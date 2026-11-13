import mssql from 'mssql';
import mysql from 'mysql2/promise';
import pg from 'pg';
import type {
  ManageMode,
  SqlColumn,
  SqlDatabase,
  SqlForeignKey,
  SqlIndex,
  SqlQueryResult,
  SqlResultSet,
  SqlRowChange,
  SqlRowsRequest,
  SqlRowsResult,
  SqlTableDetail,
  SqlTableRef,
  SqlValue,
} from '@app/shared';
import type { ResourceConfigOf } from '../config/resources-file';
import { expandHome } from '../config/app-paths';
import { readPassword, tlsOptions, type ConnectorContext } from '../connectors/connector';
import { openSqlite, type SqliteDatabase } from '../storage/sqlite';
import { isRowStatement, readModeProblem, splitStatements } from './sql-text';
import { fromJsonValue, toJsonValue } from './values';

/** Rows a query returns at most; more are reported as truncated. */
export const MAX_RESULT_ROWS = 1000;
const STATEMENT_TIMEOUT_MS = 30_000;

type SqlConfig =
  | ResourceConfigOf<'postgres'>
  | ResourceConfigOf<'mysql'>
  | ResourceConfigOf<'mssql'>
  | ResourceConfigOf<'sqlite'>;

/** Thrown for problems the user can fix (bad input, read mode); shown as is. */
export class ExploreError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** A raw statement result before conversion. */
interface RawResult {
  fields: { name: string; type: string | null }[];
  rows: unknown[][];
  affected: number | null;
  command: string | null;
  truncated: boolean;
}

/**
 * What differs per engine. Everything else (rows paging, filters, row edits,
 * query scripts, read-mode rules) lives once in {@link SqlExplorer}.
 */
interface SqlEngine {
  readonly label: string;
  /** Statements are split and run one by one (false: the whole batch at once). */
  readonly splitScripts: boolean;
  quote(identifier: string): string;
  qualify(schema: string, table: string): string;
  placeholder(index: number): string;
  /** Text cast for "search in every column". */
  likeExpression(column: string, param: string): string;
  /** LIMIT/OFFSET clause (SQL Server needs ORDER BY, handled by the caller). */
  page(limit: number, offset: number): string;
  serverVersion(): Promise<string | null>;
  databases(): Promise<SqlDatabase[]>;
  tables(database: string): Promise<SqlTableRef[]>;
  detail(database: string, schema: string, table: string): Promise<SqlTableDetail>;
  /** One statement with parameters (metadata, browsing, row edits). */
  exec(database: string, sql: string, params: unknown[], maxRows: number): Promise<RawResult>;
  /** A typed script; read mode must be enforced by the database here too. */
  script(
    database: string,
    statements: string[],
    mode: ManageMode,
    maxRows: number,
  ): Promise<RawResult[]>;
  /** Runs `work` in one transaction (row edits): commits on success. */
  transaction<T>(database: string, work: () => Promise<T>): Promise<T>;
  defaultDatabase(): string;
  close(): Promise<void>;
}

export class SqlExplorer {
  constructor(
    private readonly engine: SqlEngine,
    private readonly mode: () => ManageMode,
  ) {}

  get label() {
    return this.engine.label;
  }

  serverVersion() {
    return this.engine.serverVersion();
  }

  defaultDatabase() {
    return this.engine.defaultDatabase();
  }

  databases() {
    return this.engine.databases();
  }

  tables(database: string) {
    return this.engine.tables(database);
  }

  table(database: string, schema: string, table: string) {
    return this.engine.detail(database, schema, table);
  }

  async rows(database: string, request: SqlRowsRequest): Promise<SqlRowsResult> {
    const detail = await this.engine.detail(database, request.schema, request.table);
    const columns = new Set(detail.columns.map((c) => c.name));
    const params: unknown[] = [];
    const where: string[] = [];
    for (const [column, value] of Object.entries(request.where ?? {})) {
      if (!columns.has(column)) throw new ExploreError(`unknown column "${column}"`);
      if (value === null) where.push(`${this.engine.quote(column)} IS NULL`);
      else {
        params.push(fromJsonValue(value));
        where.push(`${this.engine.quote(column)} = ${this.engine.placeholder(params.length)}`);
      }
    }
    if (request.search?.trim()) {
      const needle = `%${request.search.trim()}%`;
      // Numbered placeholders ($1, @p1) can repeat one value; positional "?" (MySQL,
      // SQLite) needs the value once per column.
      const positional = this.engine.placeholder(1) === '?';
      if (!positional) params.push(needle);
      const shared = this.engine.placeholder(params.length);
      const conditions = detail.columns.map((c) => {
        if (positional) params.push(needle);
        return this.engine.likeExpression(this.engine.quote(c.name), positional ? '?' : shared);
      });
      where.push(`(${conditions.join(' OR ')})`);
    }
    if (request.orderBy && !columns.has(request.orderBy)) {
      throw new ExploreError(`unknown column "${request.orderBy}"`);
    }
    const from = this.engine.qualify(request.schema, request.table);
    const whereSql = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const primaryKey = detail.columns.filter((c) => c.primaryKey).map((c) => c.name);
    const orderColumns = request.orderBy ? [request.orderBy] : primaryKey;
    const order =
      orderColumns.length > 0
        ? ` ORDER BY ${orderColumns.map((c) => `${this.engine.quote(c)}${request.descending ? ' DESC' : ''}`).join(', ')}`
        : this.engine.label === 'SQL Server'
          ? ' ORDER BY (SELECT NULL)'
          : '';
    const limit = clamp(request.limit, 1, MAX_RESULT_ROWS);
    const offset = Math.max(0, Math.floor(request.offset));
    const result = await this.engine.exec(
      database,
      `SELECT * FROM ${from}${whereSql}${order} ${this.engine.page(limit, offset)}`,
      params,
      limit,
    );
    // Counting a huge table can take a long time: only when it is small or filtered.
    let total: number | null = null;
    if (where.length > 0 || (detail.rowEstimate ?? 0) < 500_000) {
      const counted = await this.engine
        .exec(database, `SELECT COUNT(*) AS n FROM ${from}${whereSql}`, params, 1)
        .catch(() => null);
      total = counted ? Number(counted.rows[0]?.[0] ?? null) : null;
    }
    return { ...convert(result), total, primaryKey };
  }

  async query(database: string, sql: string): Promise<SqlQueryResult> {
    const mode = this.mode();
    const statements = this.engine.splitScripts ? splitStatements(sql) : [sql.trim()];
    const checked = this.engine.splitScripts ? statements : splitStatements(sql);
    if (checked.length === 0) throw new ExploreError('nothing to run');
    if (mode === 'read') {
      for (const statement of checked) {
        const problem = readModeProblem(statement);
        if (problem) throw new ExploreError(problem, 403);
      }
    }
    const started = performance.now();
    const results = await this.engine.script(database, statements, mode, MAX_RESULT_ROWS);
    return {
      results: results.map(convert),
      durationMs: Math.round(performance.now() - started),
      mode,
    };
  }

  /** UPDATE one row by its key. Refused unless exactly one row matches. */
  async updateRow(database: string, change: SqlRowChange): Promise<number> {
    this.requireWrite();
    const detail = await this.engine.detail(database, change.schema, change.table);
    const values = Object.entries(change.values ?? {});
    if (values.length === 0) throw new ExploreError('nothing to change');
    const params: unknown[] = [];
    const set = values.map(([column, value]) => {
      this.requireColumn(detail, column);
      params.push(fromJsonValue(value));
      return `${this.engine.quote(column)} = ${this.engine.placeholder(params.length)}`;
    });
    const where = this.keyWhere(detail, change.key, params);
    return this.exactlyOne(
      database,
      `UPDATE ${this.engine.qualify(change.schema, change.table)} SET ${set.join(', ')} WHERE ${where}`,
      params,
    );
  }

  async insertRow(database: string, change: SqlRowChange): Promise<number> {
    this.requireWrite();
    const detail = await this.engine.detail(database, change.schema, change.table);
    const values = Object.entries(change.values ?? {});
    const table = this.engine.qualify(change.schema, change.table);
    if (values.length === 0) {
      const sql =
        this.engine.label === 'MySQL'
          ? `INSERT INTO ${table} () VALUES ()`
          : `INSERT INTO ${table} DEFAULT VALUES`;
      return (
        (await this.engine.transaction(database, () => this.engine.exec(database, sql, [], 0)))
          .affected ?? 1
      );
    }
    const params: unknown[] = [];
    const columns = values.map(([column, value]) => {
      this.requireColumn(detail, column);
      params.push(fromJsonValue(value));
      return this.engine.quote(column);
    });
    const placeholders = params.map((_, i) => this.engine.placeholder(i + 1));
    const result = await this.engine.transaction(database, () =>
      this.engine.exec(
        database,
        `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        params,
        0,
      ),
    );
    return result.affected ?? 1;
  }

  async deleteRow(database: string, change: SqlRowChange): Promise<number> {
    this.requireWrite();
    const detail = await this.engine.detail(database, change.schema, change.table);
    const params: unknown[] = [];
    const where = this.keyWhere(detail, change.key, params);
    return this.exactlyOne(
      database,
      `DELETE FROM ${this.engine.qualify(change.schema, change.table)} WHERE ${where}`,
      params,
    );
  }

  close() {
    return this.engine.close();
  }

  private requireWrite() {
    if (this.mode() !== 'write') {
      throw new ExploreError('Changes are off for this resource: switch them on to edit rows', 403);
    }
  }

  private requireColumn(detail: SqlTableDetail, column: string) {
    if (!detail.columns.some((c) => c.name === column)) {
      throw new ExploreError(`unknown column "${column}"`);
    }
  }

  private keyWhere(
    detail: SqlTableDetail,
    key: Record<string, SqlValue>,
    params: unknown[],
  ): string {
    const entries = Object.entries(key);
    if (entries.length === 0) throw new ExploreError('the row has no key to find it by');
    return entries
      .map(([column, value]) => {
        this.requireColumn(detail, column);
        if (value === null) return `${this.engine.quote(column)} IS NULL`;
        params.push(fromJsonValue(value));
        return `${this.engine.quote(column)} = ${this.engine.placeholder(params.length)}`;
      })
      .join(' AND ');
  }

  /** Runs a keyed change in a transaction and rolls back unless it touched exactly one row. */
  private async exactlyOne(database: string, sql: string, params: unknown[]): Promise<number> {
    return this.engine.transaction(database, async () => {
      const result = await this.engine.exec(database, sql, params, 0);
      const affected = result.affected ?? 0;
      if (affected !== 1) {
        throw new ExploreError(
          affected === 0
            ? 'no row matched: it was changed or deleted meanwhile; reload and try again'
            : `${affected} rows matched (the table has no unique key): nothing was changed`,
          409,
        );
      }
      return affected;
    });
  }
}

function convert(result: RawResult): SqlResultSet {
  return {
    columns: result.fields,
    rows: result.rows.map((row) => row.map(toJsonValue)),
    affected: result.affected,
    truncated: result.truncated,
    command: result.command,
  };
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));

const FK_ACTIONS: Record<string, string> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

// =================================================================== PostgreSQL

const PG_TYPES: Record<number, string> = {
  16: 'bool',
  17: 'bytea',
  20: 'int8',
  21: 'int2',
  23: 'int4',
  25: 'text',
  114: 'json',
  700: 'float4',
  701: 'float8',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
  2950: 'uuid',
  3802: 'jsonb',
};

function createPostgresEngine(
  config: ResourceConfigOf<'postgres'>,
  context: ConnectorContext,
): SqlEngine {
  const clients = new Map<string, Promise<pg.Client>>();

  const client = (database: string): Promise<pg.Client> => {
    const existing = clients.get(database);
    if (existing) return existing;
    const created = (async () => {
      const password = await readPassword(config, context);
      const next = new pg.Client({
        host: config.host,
        port: config.port,
        user: config.user,
        database,
        password,
        ssl: tlsOptions(config) ?? false,
        application_name: `${context.appName} manage`,
        connectionTimeoutMillis: 8000,
        options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      });
      next.on('error', () => clients.delete(database));
      try {
        await next.connect();
      } catch (error) {
        clients.delete(database);
        await next.end().catch(() => undefined);
        throw error;
      }
      return next;
    })();
    created.catch(() => clients.delete(database));
    clients.set(database, created);
    return created;
  };

  const raw = (result: pg.QueryArrayResult, maxRows: number): RawResult => {
    const rows = result.rows ?? [];
    return {
      fields: (result.fields ?? []).map((f) => ({
        name: f.name,
        type: PG_TYPES[f.dataTypeID] ?? null,
      })),
      rows: rows.slice(0, maxRows),
      affected: result.command === 'SELECT' ? null : (result.rowCount ?? null),
      command: result.command ?? null,
      truncated: rows.length > maxRows,
    };
  };

  const exec = async (database: string, sql: string, params: unknown[], maxRows: number) => {
    const db = await client(database);
    const result = await db.query({ text: sql, values: params, rowMode: 'array' });
    return raw(result, maxRows);
  };

  const engine: SqlEngine = {
    label: 'PostgreSQL',
    splitScripts: true,
    quote: (id) => `"${id.replaceAll('"', '""')}"`,
    qualify: (schema, table) => `${engine.quote(schema)}.${engine.quote(table)}`,
    placeholder: (i) => `$${i}`,
    likeExpression: (column, param) => `CAST(${column} AS text) ILIKE ${param}`,
    page: (limit, offset) => `LIMIT ${limit} OFFSET ${offset}`,
    defaultDatabase: () => config.database,
    async serverVersion() {
      const r = await exec(config.database, 'SHOW server_version', [], 1);
      return `PostgreSQL ${String(r.rows[0]?.[0] ?? '')}`.trim();
    },
    async databases() {
      const r = await exec(
        config.database,
        `SELECT datname,
                CASE WHEN has_database_privilege(datname, 'CONNECT') THEN pg_database_size(datname) END
           FROM pg_database WHERE NOT datistemplate ORDER BY datname`,
        [],
        10_000,
      );
      return r.rows.map(([name, size]) => ({
        name: String(name),
        sizeBytes: size === null ? null : Number(size),
        current: name === config.database,
      }));
    },
    async tables(database) {
      const r = await exec(
        database,
        `SELECT n.nspname, c.relname, c.relkind, c.reltuples, pg_total_relation_size(c.oid)
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind IN ('r','p','v','m','f')
            AND n.nspname NOT IN ('pg_catalog','information_schema')
            AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
          ORDER BY n.nspname = 'public' DESC, n.nspname, c.relname`,
        [],
        50_000,
      );
      return r.rows.map(([schema, name, kind, tuples, size]) => ({
        schema: String(schema),
        name: String(name),
        type: kind === 'v' || kind === 'm' ? 'view' : 'table',
        rowEstimate: Number(tuples) >= 0 ? Math.round(Number(tuples)) : null,
        sizeBytes: size === null ? null : Number(size),
      }));
    },
    async detail(database, schema, table) {
      const rel = await exec(
        database,
        `SELECT c.oid, c.relkind, c.reltuples FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2`,
        [schema, table],
        1,
      );
      if (rel.rows.length === 0) throw new ExploreError(`no table ${schema}.${table}`, 404);
      const [oid, relkind, tuples] = rel.rows[0]!;
      const cols = await exec(
        database,
        `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
                pg_get_expr(d.adbin, d.adrelid), a.attidentity <> '' OR COALESCE(pg_get_expr(d.adbin, d.adrelid), '') LIKE 'nextval(%',
                col_description(a.attrelid, a.attnum),
                EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey))
           FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
          WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [oid],
        10_000,
      );
      const columns: SqlColumn[] = cols.rows.map(
        ([name, type, nullable, def, auto, comment, pk]) => ({
          name: String(name),
          type: String(type),
          nullable: nullable === true,
          default: def === null ? null : String(def),
          primaryKey: pk === true,
          autoIncrement: auto === true,
          comment: comment === null ? null : String(comment),
        }),
      );
      const idx = await exec(
        database,
        `SELECT i.relname, ix.indisunique, ix.indisprimary,
                ARRAY(SELECT a.attname::text FROM unnest(ix.indkey) WITH ORDINALITY k(attnum, ord)
                        JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = k.attnum ORDER BY k.ord)
           FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
          WHERE ix.indrelid = $1 ORDER BY ix.indisprimary DESC, i.relname`,
        [oid],
        10_000,
      );
      const indexes: SqlIndex[] = idx.rows.map(([name, unique, primary, cols]) => ({
        name: String(name),
        unique: unique === true,
        primary: primary === true,
        columns: (cols as string[]) ?? [],
      }));
      const fks = await exec(
        database,
        `SELECT con.conname, cn.nspname, cl.relname, rn.nspname, rc.relname,
                ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
                        JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o),
                ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, o)
                        JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.o),
                con.confdeltype, con.confupdtype
           FROM pg_constraint con
           JOIN pg_class cl ON cl.oid = con.conrelid JOIN pg_namespace cn ON cn.oid = cl.relnamespace
           JOIN pg_class rc ON rc.oid = con.confrelid JOIN pg_namespace rn ON rn.oid = rc.relnamespace
          WHERE con.contype = 'f' AND (con.conrelid = $1 OR con.confrelid = $1)`,
        [oid],
        10_000,
      );
      const foreignKeys: SqlForeignKey[] = [];
      const referencedBy: SqlTableDetail['referencedBy'] = [];
      for (const [
        name,
        fromSchema,
        fromTable,
        refSchema,
        refTable,
        cols,
        refCols,
        del,
        upd,
      ] of fks.rows) {
        const fk: SqlForeignKey = {
          name: String(name),
          columns: cols as string[],
          refSchema: String(refSchema),
          refTable: String(refTable),
          refColumns: refCols as string[],
          onDelete: FK_ACTIONS[String(del)] ?? null,
          onUpdate: FK_ACTIONS[String(upd)] ?? null,
        };
        if (fromSchema === schema && fromTable === table) foreignKeys.push(fk);
        if (refSchema === schema && refTable === table)
          referencedBy.push({ ...fk, schema: String(fromSchema), table: String(fromTable) });
      }
      const isView = relkind === 'v' || relkind === 'm';
      const ddl = isView
        ? `CREATE VIEW ${engine.qualify(schema, table)} AS\n${String((await exec(database, 'SELECT pg_get_viewdef($1::oid, true)', [oid], 1)).rows[0]?.[0] ?? '')}`
        : createTableDdl(engine, schema, table, columns, indexes);
      return {
        schema,
        name: table,
        type: isView ? 'view' : 'table',
        columns,
        indexes,
        foreignKeys,
        referencedBy,
        ddl,
        rowEstimate: Number(tuples) >= 0 ? Math.round(Number(tuples)) : null,
      };
    },
    exec,
    async script(database, statements, mode, maxRows) {
      const db = await client(database);
      const results: RawResult[] = [];
      // read: one read-only transaction, always rolled back.
      // write: autocommit, each row statement through a cursor so huge results stay capped.
      await db.query(mode === 'read' ? 'BEGIN TRANSACTION READ ONLY' : 'BEGIN');
      try {
        for (const [index, statement] of statements.entries()) {
          // A cursor keeps huge results capped; data-changing CTEs cannot run in one.
          const cursorable =
            isRowStatement(statement) &&
            !/^\s*(show|explain|values)\b/i.test(statement) &&
            !/\b(insert|update|delete|merge)\b/i.test(statement);
          if (cursorable) {
            const cursor = `gc_cursor_${index}`;
            await db.query(
              `DECLARE ${cursor} NO SCROLL CURSOR FOR ${statement.replace(/;\s*$/, '')}`,
            );
            const fetched = await db.query({
              text: `FETCH FORWARD ${maxRows + 1} FROM ${cursor}`,
              rowMode: 'array',
            });
            await db.query(`CLOSE ${cursor}`);
            results.push({ ...raw(fetched, maxRows), command: 'SELECT', affected: null });
          } else {
            results.push(raw(await db.query({ text: statement, rowMode: 'array' }), maxRows));
          }
        }
        await db.query(mode === 'read' ? 'ROLLBACK' : 'COMMIT');
      } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
      return results;
    },
    async transaction(database, work) {
      const db = await client(database);
      await db.query('BEGIN');
      try {
        const value = await work();
        await db.query('COMMIT');
        return value;
      } catch (error) {
        await db.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    },
    async close() {
      const all = [...clients.values()];
      clients.clear();
      await Promise.all(
        all.map(async (p) => (await p.catch(() => null))?.end().catch(() => undefined)),
      );
    },
  };
  return engine;
}

// =================================================================== MySQL / MariaDB

const MYSQL_SYSTEM = new Set(['information_schema', 'mysql', 'performance_schema', 'sys']);

function createMysqlEngine(
  config: ResourceConfigOf<'mysql'>,
  context: ConnectorContext,
): SqlEngine {
  let connection: Promise<mysql.Connection> | null = null;

  const connect = (): Promise<mysql.Connection> => {
    if (connection) return connection;
    const created = (async () => {
      const password = await readPassword(config, context);
      const next = await mysql.createConnection({
        host: config.host,
        port: config.port,
        user: config.user,
        password,
        database: config.database,
        ssl: tlsOptions(config),
        connectTimeout: 8000,
        supportBigNumbers: true,
        bigNumberStrings: true,
        dateStrings: true,
        rowsAsArray: true,
      });
      next.on('error', () => {
        connection = null;
      });
      await next
        .query(`SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_MS}`)
        .catch(() => undefined);
      return next;
    })();
    created.catch(() => {
      connection = null;
    });
    connection = created;
    return created;
  };

  const run = async (sql: string, params: unknown[], maxRows: number): Promise<RawResult> => {
    const db = await connect();
    const [result, fields] = await db.query({ sql, values: params, rowsAsArray: true });
    if (Array.isArray(result)) {
      const rows = result as unknown[][];
      return {
        fields: (fields ?? []).map((f) => ({ name: f.name, type: mysqlType(f.columnType) })),
        rows: rows.slice(0, maxRows),
        affected: null,
        command: 'SELECT',
        truncated: rows.length > maxRows,
      };
    }
    const header = result as mysql.ResultSetHeader;
    return {
      fields: [],
      rows: [],
      affected: header.affectedRows ?? null,
      command: null,
      truncated: false,
    };
  };

  /** Row statements stream, and the connection is dropped past the cap (no huge buffers). */
  const runCapped = async (sql: string, maxRows: number): Promise<RawResult> => {
    const db = await connect();
    const core = (
      db as unknown as {
        connection: { query: (o: unknown) => NodeJS.EventEmitter & { stream?: unknown } };
      }
    ).connection;
    return new Promise<RawResult>((resolve, reject) => {
      const rows: unknown[][] = [];
      let fields: { name: string; type: string | null }[] = [];
      let truncated = false;
      const query = core.query({ sql, rowsAsArray: true });
      query.on('fields', (list: { name: string; columnType?: number }[]) => {
        fields = list.map((f) => ({ name: f.name, type: mysqlType(f.columnType) }));
      });
      query.on('result', (row: unknown[]) => {
        if (rows.length < maxRows) rows.push(row);
        else if (!truncated) {
          truncated = true;
          // Stop reading: close this connection; the next request opens a fresh one.
          connection = null;
          db.destroy();
          resolve({ fields, rows, affected: null, command: 'SELECT', truncated: true });
        }
      });
      query.on('error', (error: Error) => (truncated ? undefined : reject(error)));
      query.on('end', () => {
        if (!truncated)
          resolve({ fields, rows, affected: null, command: 'SELECT', truncated: false });
      });
    });
  };

  const useDb = async (database: string) => {
    if (database) await run(`USE ${engine.quote(database)}`, [], 0);
  };

  const engine: SqlEngine = {
    label: 'MySQL',
    splitScripts: true,
    quote: (id) => `\`${id.replaceAll('`', '``')}\``,
    qualify: (schema, table) => `${engine.quote(schema)}.${engine.quote(table)}`,
    placeholder: () => '?',
    likeExpression: (column, param) => `CAST(${column} AS CHAR) LIKE ${param}`,
    page: (limit, offset) => `LIMIT ${limit} OFFSET ${offset}`,
    defaultDatabase: () => config.database ?? '',
    async serverVersion() {
      const r = await run('SELECT VERSION()', [], 1);
      const version = String(r.rows[0]?.[0] ?? '');
      return /mariadb/i.test(version)
        ? `MariaDB ${version.replace(/-MariaDB.*/i, '')}`
        : `MySQL ${version}`;
    },
    async databases() {
      const r = await run(
        `SELECT s.schema_name, (SELECT SUM(t.data_length + t.index_length) FROM information_schema.tables t
                                  WHERE t.table_schema = s.schema_name)
           FROM information_schema.schemata s ORDER BY s.schema_name`,
        [],
        10_000,
      );
      return r.rows
        .map(([name, size]) => ({
          name: String(name),
          sizeBytes: size === null ? null : Number(size),
          current: name === config.database,
        }))
        .sort((a, b) => Number(MYSQL_SYSTEM.has(a.name)) - Number(MYSQL_SYSTEM.has(b.name)));
    },
    async tables(database) {
      const r = await run(
        `SELECT table_schema, table_name, table_type, table_rows, data_length + index_length
           FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
        [database],
        50_000,
      );
      return r.rows.map(([schema, name, type, rows, size]) => ({
        schema: String(schema),
        name: String(name),
        type: String(type).includes('VIEW') ? 'view' : 'table',
        rowEstimate: rows === null ? null : Number(rows),
        sizeBytes: size === null ? null : Number(size),
      }));
    },
    async detail(_database, schema, table) {
      const t = await run(
        'SELECT table_type, table_rows FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
        [schema, table],
        1,
      );
      if (t.rows.length === 0) throw new ExploreError(`no table ${schema}.${table}`, 404);
      const isView = String(t.rows[0]![0]).includes('VIEW');
      const cols = await run(
        `SELECT column_name, column_type, is_nullable, column_default, column_key, extra, column_comment
           FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`,
        [schema, table],
        10_000,
      );
      const columns: SqlColumn[] = cols.rows.map(
        ([name, type, nullable, def, key, extra, comment]) => ({
          name: String(name),
          type: String(type),
          nullable: nullable === 'YES',
          default: def === null ? null : String(def),
          primaryKey: key === 'PRI',
          autoIncrement: String(extra).includes('auto_increment'),
          comment: comment ? String(comment) : null,
        }),
      );
      const idx = await run(
        `SELECT index_name, non_unique, column_name FROM information_schema.statistics
          WHERE table_schema = ? AND table_name = ? ORDER BY index_name, seq_in_index`,
        [schema, table],
        10_000,
      );
      const byName = new Map<string, SqlIndex>();
      for (const [name, nonUnique, column] of idx.rows) {
        const key = String(name);
        const index = byName.get(key) ?? {
          name: key,
          columns: [],
          unique: Number(nonUnique) === 0,
          primary: key === 'PRIMARY',
        };
        index.columns.push(String(column));
        byName.set(key, index);
      }
      const fk = await run(
        `SELECT k.constraint_name, k.table_schema, k.table_name, k.column_name,
                k.referenced_table_schema, k.referenced_table_name, k.referenced_column_name,
                r.delete_rule, r.update_rule
           FROM information_schema.key_column_usage k
           JOIN information_schema.referential_constraints r
             ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
          WHERE k.referenced_table_name IS NOT NULL
            AND ((k.table_schema = ? AND k.table_name = ?) OR (k.referenced_table_schema = ? AND k.referenced_table_name = ?))
          ORDER BY k.constraint_name, k.ordinal_position`,
        [schema, table, schema, table],
        10_000,
      );
      const { foreignKeys, referencedBy } = groupForeignKeys(fk.rows, schema, table);
      const create = await run(
        `SHOW CREATE ${isView ? 'VIEW' : 'TABLE'} ${engine.qualify(schema, table)}`,
        [],
        1,
      ).catch(() => null);
      return {
        schema,
        name: table,
        type: isView ? 'view' : 'table',
        columns,
        indexes: [...byName.values()].sort((a, b) => Number(b.primary) - Number(a.primary)),
        foreignKeys,
        referencedBy,
        ddl: create ? String(create.rows[0]?.[1] ?? '') || null : null,
        rowEstimate: t.rows[0]![1] === null ? null : Number(t.rows[0]![1]),
      };
    },
    async exec(database, sql, params, maxRows) {
      await useDb(database);
      return run(sql, params, maxRows);
    },
    async script(database, statements, mode, maxRows) {
      await useDb(database);
      const results: RawResult[] = [];
      // read: a read-only transaction, rolled back (DDL is refused before it gets here).
      if (mode === 'read') await run('START TRANSACTION READ ONLY', [], 0);
      try {
        for (const statement of statements) {
          results.push(
            isRowStatement(statement)
              ? await runCapped(statement, maxRows)
              : await run(statement, [], maxRows),
          );
        }
      } finally {
        if (mode === 'read' && connection) await run('ROLLBACK', [], 0).catch(() => undefined);
      }
      return results;
    },
    async transaction(database, work) {
      await useDb(database);
      await run('START TRANSACTION', [], 0);
      try {
        const value = await work();
        await run('COMMIT', [], 0);
        return value;
      } catch (error) {
        await run('ROLLBACK', [], 0).catch(() => undefined);
        throw error;
      }
    },
    async close() {
      const current = connection;
      connection = null;
      await (await current?.catch(() => null))?.end().catch(() => undefined);
    },
  };
  return engine;
}

function mysqlType(columnType?: number): string | null {
  const names: Record<number, string> = {
    1: 'tinyint',
    2: 'smallint',
    3: 'int',
    4: 'float',
    5: 'double',
    7: 'timestamp',
    8: 'bigint',
    10: 'date',
    12: 'datetime',
    245: 'json',
    246: 'decimal',
    252: 'blob',
    253: 'varchar',
    254: 'char',
  };
  return columnType === undefined ? null : (names[columnType] ?? null);
}

/** Rows of (name, schema, table, column, refSchema, refTable, refColumn, onDelete, onUpdate). */
/** A foreign key without the table it starts in (that table is the one being described). */
function ownKey(fk: SqlForeignKey & { schema: string; table: string }): SqlForeignKey {
  return {
    name: fk.name,
    columns: fk.columns,
    refSchema: fk.refSchema,
    refTable: fk.refTable,
    refColumns: fk.refColumns,
    onDelete: fk.onDelete,
    onUpdate: fk.onUpdate,
  };
}

function groupForeignKeys(rows: unknown[][], schema: string, table: string) {
  const grouped = new Map<string, SqlForeignKey & { schema: string; table: string }>();
  for (const [
    name,
    fromSchema,
    fromTable,
    column,
    refSchema,
    refTable,
    refColumn,
    del,
    upd,
  ] of rows) {
    const key = `${String(fromSchema)}.${String(fromTable)}.${String(name)}`;
    const fk = grouped.get(key) ?? {
      name: String(name),
      schema: String(fromSchema),
      table: String(fromTable),
      columns: [],
      refSchema: String(refSchema),
      refTable: String(refTable),
      refColumns: [],
      onDelete: del ? String(del) : null,
      onUpdate: upd ? String(upd) : null,
    };
    fk.columns.push(String(column));
    fk.refColumns.push(String(refColumn));
    grouped.set(key, fk);
  }
  const all = [...grouped.values()];
  return {
    foreignKeys: all.filter((fk) => fk.schema === schema && fk.table === table).map(ownKey),
    referencedBy: all.filter((fk) => fk.refSchema === schema && fk.refTable === table),
  };
}

// =================================================================== SQL Server

function createMssqlEngine(
  config: ResourceConfigOf<'mssql'>,
  context: ConnectorContext,
): SqlEngine {
  const pools = new Map<string, Promise<mssql.ConnectionPool>>();
  /** Row edits run inside this transaction when set. */
  let activeTransaction: mssql.Transaction | null = null;

  const pool = (database: string): Promise<mssql.ConnectionPool> => {
    const existing = pools.get(database);
    if (existing) return existing;
    const created = (async () => {
      const password = await readPassword(config, context);
      const next = new mssql.ConnectionPool({
        server: config.host,
        port: config.port,
        user: config.user,
        password,
        database,
        connectionTimeout: 8000,
        requestTimeout: STATEMENT_TIMEOUT_MS,
        pool: { max: 2, min: 0, idleTimeoutMillis: 60_000 },
        options: {
          encrypt: config.encrypt,
          trustServerCertificate: config.trustServerCertificate,
          appName: `${context.appName} manage`,
        },
      });
      next.on('error', () => pools.delete(database));
      await next.connect();
      return next;
    })();
    created.catch(() => pools.delete(database));
    pools.set(database, created);
    return created;
  };

  type ColumnMeta = { index: number; name: string; type?: { declaration?: string } };
  /** arrayRowMode: rows are arrays; column metadata comes per result set in `columns`. */
  const toRaw = (
    recordset: unknown[] | undefined,
    columns: ColumnMeta[] | undefined,
    maxRows: number,
    affected?: number,
  ): RawResult => {
    const rows = (recordset ?? []) as unknown[][];
    return {
      fields: [...(columns ?? [])]
        .sort((a, b) => a.index - b.index)
        .map((c) => ({ name: c.name, type: c.type?.declaration ?? null })),
      rows: rows.slice(0, maxRows),
      affected: recordset ? null : (affected ?? null),
      command: recordset ? 'SELECT' : null,
      truncated: rows.length > maxRows,
    };
  };
  const columnsOf = (result: unknown, index: number) =>
    ((result as { columns?: ColumnMeta[][] }).columns ?? [])[index];

  const request = async (database: string) =>
    activeTransaction ? new mssql.Request(activeTransaction) : (await pool(database)).request();

  const exec = async (database: string, sql: string, params: unknown[], maxRows: number) => {
    const req = await request(database);
    req.arrayRowMode = true;
    params.forEach((value, i) => req.input(`p${i + 1}`, value as never));
    const result = await req.query(sql);
    return toRaw(
      result.recordset as unknown[] | undefined,
      columnsOf(result, 0),
      maxRows,
      result.rowsAffected?.reduce((a, b) => a + b, 0),
    );
  };

  const engine: SqlEngine = {
    label: 'SQL Server',
    splitScripts: false,
    quote: (id) => `[${id.replaceAll(']', ']]')}]`,
    qualify: (schema, table) => `${engine.quote(schema)}.${engine.quote(table)}`,
    placeholder: (i) => `@p${i}`,
    likeExpression: (column, param) => `CAST(${column} AS NVARCHAR(MAX)) LIKE ${param}`,
    page: (limit, offset) => `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
    defaultDatabase: () => config.database,
    async serverVersion() {
      const r = await exec(
        config.database,
        "SELECT CAST(SERVERPROPERTY('ProductVersion') AS NVARCHAR(64)), CAST(SERVERPROPERTY('Edition') AS NVARCHAR(128))",
        [],
        1,
      );
      return `SQL Server ${String(r.rows[0]?.[0] ?? '')} ${String(r.rows[0]?.[1] ?? '')}`.trim();
    },
    async databases() {
      const r = await exec(
        config.database,
        `SELECT d.name, (SELECT SUM(CAST(size AS BIGINT)) * 8192 FROM sys.master_files f WHERE f.database_id = d.database_id)
           FROM sys.databases d WHERE HAS_DBACCESS(d.name) = 1 ORDER BY d.database_id`,
        [],
        10_000,
      );
      return r.rows.map(([name, size]) => ({
        name: String(name),
        sizeBytes: size === null ? null : Number(size),
        current: name === config.database,
      }));
    },
    async tables(database) {
      const r = await exec(
        database,
        `SELECT s.name, o.name, o.type, p.rows, p.bytes
           FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
           LEFT JOIN (SELECT ps.object_id, SUM(CASE WHEN ps.index_id IN (0, 1) THEN ps.row_count ELSE 0 END) AS rows,
                             SUM(ps.reserved_page_count) * 8192 AS bytes
                        FROM sys.dm_db_partition_stats ps GROUP BY ps.object_id) p ON p.object_id = o.object_id
          WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name`,
        [],
        50_000,
      ).catch(() =>
        exec(
          database,
          `SELECT s.name, o.name, o.type, NULL, NULL FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
            WHERE o.type IN ('U', 'V') AND o.is_ms_shipped = 0 ORDER BY s.name, o.name`,
          [],
          50_000,
        ),
      );
      return r.rows.map(([schema, name, type, rows, bytes]) => ({
        schema: String(schema),
        name: String(name),
        type: String(type).trim() === 'V' ? 'view' : 'table',
        rowEstimate: rows === null ? null : Number(rows),
        sizeBytes: bytes === null ? null : Number(bytes),
      }));
    },
    async detail(database, schema, table) {
      const obj = await exec(
        database,
        `SELECT o.object_id, o.type FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
          WHERE s.name = @p1 AND o.name = @p2 AND o.type IN ('U', 'V')`,
        [schema, table],
        1,
      );
      if (obj.rows.length === 0) throw new ExploreError(`no table ${schema}.${table}`, 404);
      const [objectId, type] = obj.rows[0]!;
      const cols = await exec(
        database,
        `SELECT c.name, t.name, c.max_length, c.precision, c.scale, c.is_nullable, dc.definition, c.is_identity,
                CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic JOIN sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                                   WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id) THEN 1 ELSE 0 END
           FROM sys.columns c JOIN sys.types t ON t.user_type_id = c.user_type_id
           LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
          WHERE c.object_id = @p1 ORDER BY c.column_id`,
        [objectId],
        10_000,
      );
      const columns: SqlColumn[] = cols.rows.map(
        ([name, typeName, maxLength, precision, scale, nullable, def, identity, pk]) => ({
          name: String(name),
          type: mssqlTypeName(
            String(typeName),
            Number(maxLength),
            Number(precision),
            Number(scale),
          ),
          nullable: nullable === true,
          default: def === null ? null : String(def),
          primaryKey: Number(pk) === 1,
          autoIncrement: identity === true,
          comment: null,
        }),
      );
      const idx = await exec(
        database,
        `SELECT i.name, i.is_unique, i.is_primary_key, c.name FROM sys.indexes i
           JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
           JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
          WHERE i.object_id = @p1 AND i.name IS NOT NULL ORDER BY i.name, ic.key_ordinal`,
        [objectId],
        10_000,
      );
      const byName = new Map<string, SqlIndex>();
      for (const [name, unique, primary, column] of idx.rows) {
        const index = byName.get(String(name)) ?? {
          name: String(name),
          columns: [],
          unique: unique === true,
          primary: primary === true,
        };
        index.columns.push(String(column));
        byName.set(String(name), index);
      }
      const fk = await exec(
        database,
        `SELECT f.name, ps.name, pt.name, pc.name, rs.name, rt.name, rc.name,
                REPLACE(f.delete_referential_action_desc, '_', ' '), REPLACE(f.update_referential_action_desc, '_', ' ')
           FROM sys.foreign_keys f
           JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id
           JOIN sys.tables pt ON pt.object_id = f.parent_object_id JOIN sys.schemas ps ON ps.schema_id = pt.schema_id
           JOIN sys.columns pc ON pc.object_id = fc.parent_object_id AND pc.column_id = fc.parent_column_id
           JOIN sys.tables rt ON rt.object_id = f.referenced_object_id JOIN sys.schemas rs ON rs.schema_id = rt.schema_id
           JOIN sys.columns rc ON rc.object_id = fc.referenced_object_id AND rc.column_id = fc.referenced_column_id
          WHERE f.parent_object_id = @p1 OR f.referenced_object_id = @p1
          ORDER BY f.name, fc.constraint_column_id`,
        [objectId],
        10_000,
      );
      const { foreignKeys, referencedBy } = groupForeignKeys(fk.rows, schema, table);
      const isView = String(type).trim() === 'V';
      const definition = isView
        ? String(
            (await exec(database, 'SELECT OBJECT_DEFINITION(@p1)', [objectId], 1)).rows[0]?.[0] ??
              '',
          ) || null
        : createTableDdl(engine, schema, table, columns, [...byName.values()]);
      const count = await exec(
        database,
        'SELECT SUM(row_count) FROM sys.dm_db_partition_stats WHERE object_id = @p1 AND index_id IN (0, 1)',
        [objectId],
        1,
      ).catch(() => null);
      return {
        schema,
        name: table,
        type: isView ? 'view' : 'table',
        columns,
        indexes: [...byName.values()].sort((a, b) => Number(b.primary) - Number(a.primary)),
        foreignKeys,
        referencedBy,
        ddl: definition,
        rowEstimate: count?.rows[0]?.[0] == null ? null : Number(count.rows[0][0]),
      };
    },
    exec,
    async script(database, statements, mode, maxRows) {
      const batch = statements.join(';\n');
      const allRows = splitStatements(batch).every(isRowStatement);
      const db = await pool(database);
      const transaction = new mssql.Transaction(db);
      await transaction.begin();
      try {
        const req = new mssql.Request(transaction);
        req.arrayRowMode = true;
        // ROWCOUNT caps result sets; only for pure SELECT batches (it would cap DML too).
        const result = await req.query(
          allRows ? `SET ROWCOUNT ${maxRows + 1};\n${batch};\nSET ROWCOUNT 0;` : batch,
        );
        // read: always rolled back, so even a stray write never sticks.
        if (mode === 'read') await transaction.rollback();
        else await transaction.commit();
        const sets = (result.recordsets as unknown as unknown[][]) ?? [];
        if (sets.length === 0)
          return [
            toRaw(
              undefined,
              undefined,
              maxRows,
              result.rowsAffected?.reduce((a, b) => a + b, 0),
            ),
          ];
        return sets.map((set, i) => toRaw(set, columnsOf(result, i), maxRows));
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    },
    async transaction(database, work) {
      const db = await pool(database);
      const transaction = new mssql.Transaction(db);
      await transaction.begin();
      activeTransaction = transaction;
      try {
        const value = await work();
        await transaction.commit();
        return value;
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      } finally {
        activeTransaction = null;
      }
    },
    async close() {
      const all = [...pools.values()];
      pools.clear();
      await Promise.all(
        all.map(async (p) => (await p.catch(() => null))?.close().catch(() => undefined)),
      );
    },
  };
  return engine;
}

function mssqlTypeName(name: string, maxLength: number, precision: number, scale: number): string {
  if (['varchar', 'char', 'varbinary', 'binary'].includes(name))
    return `${name}(${maxLength === -1 ? 'max' : maxLength})`;
  if (['nvarchar', 'nchar'].includes(name))
    return `${name}(${maxLength === -1 ? 'max' : maxLength / 2})`;
  if (['decimal', 'numeric'].includes(name)) return `${name}(${precision},${scale})`;
  return name;
}

// =================================================================== SQLite

function createSqliteEngine(
  config: ResourceConfigOf<'sqlite'>,
  context: ConnectorContext,
  mode: () => ManageMode,
): SqlEngine {
  const path = expandHome(config.path, context.homeDir);
  let handle: { db: SqliteDatabase; mode: ManageMode } | null = null;

  /** read: a read-only file handle (writes fail in SQLite itself). write: read-write. */
  const open = (): SqliteDatabase => {
    const wanted = mode();
    if (handle && handle.mode === wanted) return handle.db;
    handle?.db.close();
    const db = openSqlite(path, {
      readonly: wanted === 'read',
      fileMustExist: true,
      timeout: 5000,
    });
    db.defaultSafeIntegers(true);
    handle = { db, mode: wanted };
    return db;
  };

  const runOne = (sql: string, params: unknown[], maxRows: number): RawResult => {
    const db = open();
    const statement = db.prepare(sql);
    if (!statement.reader) {
      const info = statement.run(...(params as never[]));
      return {
        fields: [],
        rows: [],
        affected: Number(info.changes),
        command: null,
        truncated: false,
      };
    }
    statement.raw(true);
    const fields = statement.columns().map((c) => ({ name: c.name, type: c.type }));
    const rows: unknown[][] = [];
    let truncated = false;
    for (const row of statement.iterate(...(params as never[]))) {
      if (rows.length >= maxRows) {
        truncated = true;
        break;
      }
      rows.push(row as unknown[]);
    }
    return { fields, rows, affected: null, command: 'SELECT', truncated };
  };

  const engine: SqlEngine = {
    label: 'SQLite',
    splitScripts: true,
    quote: (id) => `"${id.replaceAll('"', '""')}"`,
    qualify: (schema, table) => `${engine.quote(schema)}.${engine.quote(table)}`,
    placeholder: () => '?',
    likeExpression: (column, param) => `CAST(${column} AS TEXT) LIKE ${param}`,
    page: (limit, offset) => `LIMIT ${limit} OFFSET ${offset}`,
    defaultDatabase: () => 'main',
    async serverVersion() {
      return `SQLite ${String(runOne('SELECT sqlite_version()', [], 1).rows[0]?.[0] ?? '')}`;
    },
    async databases() {
      return runOne('PRAGMA database_list', [], 100).rows.map(([, name]) => ({
        name: String(name),
        sizeBytes: null,
        current: name === 'main',
      }));
    },
    async tables(database) {
      const r = runOne(
        `SELECT name, type FROM ${engine.quote(database)}.sqlite_master
          WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        [],
        50_000,
      );
      return r.rows.map(([name, type]) => ({
        schema: database,
        name: String(name),
        type: type === 'view' ? 'view' : 'table',
        rowEstimate: null,
        sizeBytes: null,
      }));
    },
    async detail(database, schema, table) {
      const master = runOne(
        `SELECT type, sql FROM ${engine.quote(schema)}.sqlite_master WHERE name = ? AND type IN ('table', 'view')`,
        [table],
        1,
      );
      if (master.rows.length === 0) throw new ExploreError(`no table ${table}`, 404);
      const [type, ddl] = master.rows[0]!;
      const info = runOne(
        `PRAGMA ${engine.quote(schema)}.table_xinfo(${engine.quote(table)})`,
        [],
        10_000,
      );
      const pkCount = info.rows.filter((r) => Number(r[5]) > 0).length;
      const columns: SqlColumn[] = info.rows
        .filter((r) => Number(r[6] ?? 0) === 0)
        .map(([, name, colType, notnull, def, pk]) => ({
          name: String(name),
          type: String(colType || 'ANY'),
          nullable: Number(notnull) === 0,
          default: def === null ? null : String(def),
          primaryKey: Number(pk) > 0,
          autoIncrement: Number(pk) > 0 && pkCount === 1 && /^integer$/i.test(String(colType)),
          comment: null,
        }));
      const indexes: SqlIndex[] = runOne(
        `PRAGMA ${engine.quote(schema)}.index_list(${engine.quote(table)})`,
        [],
        1000,
      ).rows.map(([, name, unique, origin]) => ({
        name: String(name),
        unique: Number(unique) === 1,
        primary: origin === 'pk',
        columns: runOne(
          `PRAGMA ${engine.quote(schema)}.index_info(${engine.quote(String(name))})`,
          [],
          100,
        ).rows.map((r) => String(r[2])),
      }));
      const fkRows = (name: string) =>
        runOne(`PRAGMA ${engine.quote(schema)}.foreign_key_list(${engine.quote(name)})`, [], 1000)
          .rows;
      const toKeys = (rows: unknown[][], from: string) => {
        const grouped = new Map<string, SqlForeignKey & { schema: string; table: string }>();
        for (const [id, , refTable, column, refColumn, onUpdate, onDelete] of rows) {
          const fk = grouped.get(String(id)) ?? {
            name: `fk_${from}_${String(id)}`,
            schema,
            table: from,
            columns: [],
            refSchema: schema,
            refTable: String(refTable),
            refColumns: [],
            onDelete: String(onDelete),
            onUpdate: String(onUpdate),
          };
          fk.columns.push(String(column));
          fk.refColumns.push(refColumn === null ? '(primary key)' : String(refColumn));
          grouped.set(String(id), fk);
        }
        return [...grouped.values()];
      };
      const foreignKeys = toKeys(fkRows(table), table).map(ownKey);
      const referencedBy: SqlTableDetail['referencedBy'] = [];
      const others = runOne(
        `SELECT name FROM ${engine.quote(schema)}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 500`,
        [],
        500,
      ).rows.map((r) => String(r[0]));
      for (const other of others) {
        for (const fk of toKeys(fkRows(other), other))
          if (fk.refTable === table) referencedBy.push(fk);
      }
      return {
        schema,
        name: table,
        type: type === 'view' ? 'view' : 'table',
        columns,
        indexes,
        foreignKeys,
        referencedBy,
        ddl: ddl === null ? null : String(ddl),
        rowEstimate: null,
      };
    },
    async exec(_database, sql, params, maxRows) {
      return runOne(sql, params, maxRows);
    },
    async script(_database, statements, _mode, maxRows) {
      return statements.map((statement) => runOne(statement, [], maxRows));
    },
    async transaction(_database, work) {
      const db = open();
      db.exec('BEGIN');
      try {
        const value = await work();
        db.exec('COMMIT');
        return value;
      } catch (error) {
        if (db.inTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    async close() {
      handle?.db.close();
      handle = null;
    },
  };
  return engine;
}

/** A readable CREATE TABLE built from the catalog (engines without SHOW CREATE). */
function createTableDdl(
  engine: SqlEngine,
  schema: string,
  table: string,
  columns: SqlColumn[],
  indexes: SqlIndex[],
): string {
  const lines = columns.map(
    (c) =>
      `  ${engine.quote(c.name)} ${c.type}${c.nullable ? '' : ' NOT NULL'}${c.default !== null ? ` DEFAULT ${c.default}` : ''}`,
  );
  const pk = columns.filter((c) => c.primaryKey).map((c) => engine.quote(c.name));
  if (pk.length > 0) lines.push(`  PRIMARY KEY (${pk.join(', ')})`);
  const extra = indexes
    .filter((i) => !i.primary)
    .map(
      (i) =>
        `CREATE ${i.unique ? 'UNIQUE ' : ''}INDEX ${engine.quote(i.name)} ON ${engine.qualify(schema, table)} (${i.columns.map((c) => engine.quote(c)).join(', ')});`,
    );
  return [
    `CREATE TABLE ${engine.qualify(schema, table)} (\n${lines.join(',\n')}\n);`,
    ...extra,
  ].join('\n');
}

export function createSqlExplorer(
  config: SqlConfig,
  context: ConnectorContext,
  mode: () => ManageMode,
): SqlExplorer {
  switch (config.kind) {
    case 'postgres':
      return new SqlExplorer(createPostgresEngine(config, context), mode);
    case 'mysql':
      return new SqlExplorer(createMysqlEngine(config, context), mode);
    case 'mssql':
      return new SqlExplorer(createMssqlEngine(config, context), mode);
    case 'sqlite':
      return new SqlExplorer(createSqliteEngine(config, context, mode), mode);
  }
}
