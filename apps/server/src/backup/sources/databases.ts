import type { Readable } from 'node:stream';
import mssql from 'mssql';
import mysql from 'mysql2/promise';
import pg from 'pg';
import type { SourceConfig } from '@app/shared';
import type { ResourceConfig, ResourceConfigOf } from '../../config/resources-file';
import { tlsOptions } from '../../connectors/connector';
import { DEFAULT_IMAGES, hostForMode, runToEnd, shellQuote, wrapForMode } from '../runner';
import {
  fromProcess,
  intoProcess,
  type BackupContext,
  type RestoreContext,
  type SourceAdapter,
  type SourceContext,
} from './types';

const asKind = <K extends ResourceConfig['kind']>(
  resource: ResourceConfig | undefined,
  kind: K,
): ResourceConfigOf<K> | undefined =>
  resource?.kind === kind ? (resource as ResourceConfigOf<K>) : undefined;

const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;
const quoteMy = (name: string) => `\`${name.replace(/`/g, '``')}\``;

/** Host and port as the tool sees them (inside the DB container: itself). */
function endpoint(
  context: SourceContext,
  defaults: { host: string; port: number },
  containerPort: number,
): { host: string; port: number } {
  const { source, runner } = context;
  if (source.tool.mode === 'docker-exec') {
    return { host: source.host || '127.0.0.1', port: source.port ?? containerPort };
  }
  const host = source.host || defaults.host;
  return { host: hostForMode(host, source.tool, runner), port: source.port ?? defaults.port };
}

function needResource(kind: string, resource: ResourceConfig | undefined): string[] {
  return resource
    ? []
    : [`choose the ${kind} connection to back up (from your connected resources)`];
}

function modeProblems(source: SourceConfig): string[] {
  if (source.tool.mode === 'docker-exec' && !source.tool.container) {
    return ['docker exec needs the container name'];
  }
  if (source.tool.mode === 'driver')
    return ['this database is backed up with its own tool: choose Docker or installed'];
  return [];
}

// ── PostgreSQL ────────────────────────────────────────────────────────────

function pgEnv(
  context: SourceContext,
  config: ResourceConfigOf<'postgres'>,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (context.password) env.PGPASSWORD = context.password;
  if (config.tls && context.source.tool.mode !== 'docker-exec') {
    env.PGSSLMODE = config.tlsVerify === false ? 'require' : 'verify-full';
    if (!config.tlsCa) env.PGSSLMODE = 'require';
  }
  return env;
}

async function pgAdmin(
  context: SourceContext,
  config: ResourceConfigOf<'postgres'>,
  run: (client: pg.Client) => Promise<string | void>,
): Promise<string | void> {
  const client = new pg.Client({
    host: context.source.host || config.host,
    port: context.source.port ?? config.port,
    user: config.user,
    password: context.password,
    database: 'postgres',
    ssl: tlsOptions(config) ?? false,
    application_name: context.connectorContext.appName,
    connectionTimeoutMillis: 8000,
  });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export const postgresAdapter: SourceAdapter = {
  kind: 'postgres',
  validate: (source, resource) => [
    ...needResource('PostgreSQL', resource),
    ...(resource && resource.kind !== 'postgres'
      ? ['the chosen connection is not PostgreSQL']
      : []),
    ...modeProblems(source),
  ],
  targetLabel: (source, resource) =>
    `${source.database || (resource as ResourceConfigOf<'postgres'>)?.database || 'postgres'} on ${resource?.name ?? resource?.id ?? 'PostgreSQL'}`,
  async backup(context: BackupContext) {
    const config = asKind(context.resource, 'postgres')!;
    const database = context.source.database || config.database;
    const { host, port } = endpoint(context, config, 5432);
    const env = pgEnv(context, config);
    // Size is reported for information; a custom-format dump is smaller.
    try {
      const size = (await pgAdmin(context, config, async (client) => {
        const r = await client.query<{ size: string }>(
          'SELECT pg_database_size($1)::text AS size',
          [database],
        );
        return r.rows[0]?.size;
      })) as string | undefined;
      if (size)
        context.log('info', `Database size on disk: ${Number(size).toLocaleString()} bytes`);
    } catch {
      // not fatal: the dump itself reports any real problem
    }
    const argv = wrapForMode(
      [
        'pg_dump',
        '-h',
        host,
        '-p',
        String(port),
        '-U',
        config.user,
        '-d',
        database,
        '-Fc',
        '--no-password',
      ],
      Object.keys(env),
      context.source.tool,
      context.runner,
      DEFAULT_IMAGES.postgres!,
    );
    context.log(
      'info',
      `Running pg_dump (custom format) for "${database}" via ${describeMode(context)}`,
    );
    const proc = await context.runner.spawn(argv, env);
    const { stream, done } = fromProcess(proc, 'pg_dump', context.signal);
    return {
      stream,
      done,
      contentFormat: 'pg_dump custom format (-Fc)',
      extension: '.dump',
      tool: 'pg_dump',
      details: { database, host: config.host, port: config.port },
    };
  },
  async restore(context: RestoreContext, input: Readable) {
    const config = asKind(context.resource, 'postgres')!;
    const database = context.source.database || config.database;
    if (context.createDatabase) {
      await pgAdmin(context, config, async (client) => {
        const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
          database,
        ]);
        if (exists.rowCount === 0) {
          await client.query(`CREATE DATABASE ${quoteIdent(database)}`);
          context.log('info', `Created database "${database}"`);
        }
      });
    }
    const { host, port } = endpoint(context, config, 5432);
    const env = pgEnv(context, config);
    const argv = wrapForMode(
      [
        'pg_restore',
        '-h',
        host,
        '-p',
        String(port),
        '-U',
        config.user,
        '-d',
        database,
        '--clean',
        '--if-exists',
        '--no-owner',
        '--no-acl',
        '--no-password',
      ],
      Object.keys(env),
      context.source.tool,
      context.runner,
      DEFAULT_IMAGES.postgres!,
    );
    context.log('info', `Running pg_restore into "${database}" (existing objects are replaced)`);
    const proc = await context.runner.spawn(argv, env);
    await intoProcess(proc, input, 'pg_restore', context.signal);
  },
  async check(context) {
    const config = asKind(context.resource, 'postgres')!;
    const database = context.source.database || config.database;
    const client = new pg.Client({
      host: context.source.host || config.host,
      port: context.source.port ?? config.port,
      user: config.user,
      password: context.password,
      database,
      ssl: tlsOptions(config) ?? false,
      connectionTimeoutMillis: 8000,
    });
    await client.connect();
    try {
      const r = await client.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')",
      );
      return `${r.rows[0]?.n ?? 0} tables in "${database}"`;
    } finally {
      await client.end().catch(() => undefined);
    }
  },
};

// ── MySQL / MariaDB ───────────────────────────────────────────────────────

function myEnv(context: SourceContext): Record<string, string> {
  return context.password ? { MYSQL_PWD: context.password } : {};
}

function isMaria(context: SourceContext): boolean {
  return (
    /maria/i.test(context.source.tool.image ?? '') || /maria/i.test(context.resource?.name ?? '')
  );
}

async function myAdmin(context: SourceContext, config: ResourceConfigOf<'mysql'>) {
  return mysql.createConnection({
    host: context.source.host || config.host,
    port: context.source.port ?? config.port,
    user: config.user,
    password: context.password,
    ssl: tlsOptions(config),
    connectTimeout: 8000,
    multipleStatements: false,
  });
}

export const mysqlAdapter: SourceAdapter = {
  kind: 'mysql',
  validate: (source, resource) => [
    ...needResource('MySQL', resource),
    ...(resource && resource.kind !== 'mysql'
      ? ['the chosen connection is not MySQL / MariaDB']
      : []),
    ...modeProblems(source),
  ],
  targetLabel: (source, resource) =>
    `${source.database || (resource as ResourceConfigOf<'mysql'>)?.database || 'all databases'} on ${resource?.name ?? resource?.id ?? 'MySQL'}`,
  async backup(context) {
    const config = asKind(context.resource, 'mysql')!;
    const database = context.source.database || config.database;
    const { host, port } = endpoint(context, config, 3306);
    const env = myEnv(context);
    const tool =
      isMaria(context) && context.source.tool.mode !== 'native' ? 'mariadb-dump' : 'mysqldump';
    const args = [
      tool,
      '-h',
      host,
      '-P',
      String(port),
      '-u',
      config.user,
      '--single-transaction',
      '--quick',
      '--routines',
      '--triggers',
      '--events',
      '--hex-blob',
      '--default-character-set=utf8mb4',
      '--no-tablespaces',
      ...(config.tls ? ['--ssl-mode=REQUIRED'] : []),
      // One database: no CREATE DATABASE / USE, so it can be restored under another name.
      ...(database ? [database] : ['--all-databases']),
    ];
    const argv = wrapForMode(
      args,
      Object.keys(env),
      context.source.tool,
      context.runner,
      isMaria(context) ? DEFAULT_IMAGES.mariadb! : DEFAULT_IMAGES.mysql!,
    );
    context.log(
      'info',
      `Running ${tool} for ${database ? `"${database}"` : 'all databases'} via ${describeMode(context)}`,
    );
    const proc = await context.runner.spawn(argv, env);
    const { stream, done } = fromProcess(proc, tool, context.signal);
    return {
      stream,
      done,
      contentFormat: database ? 'mysqldump SQL (single database)' : 'mysqldump SQL (all databases)',
      extension: '.sql',
      tool,
      details: { database: database ?? null, host: config.host, port: config.port },
    };
  },
  async restore(context, input) {
    const config = asKind(context.resource, 'mysql')!;
    const database = context.source.database || config.database;
    const single = (context.manifest.source.details.database as string | null) !== null;
    if (single && !database) throw new Error('choose the database to restore into');
    if (single && context.createDatabase) {
      const conn = await myAdmin(context, config);
      try {
        await conn.query(`CREATE DATABASE IF NOT EXISTS ${quoteMy(database!)}`);
      } finally {
        await conn.end().catch(() => undefined);
      }
    }
    const { host, port } = endpoint(context, config, 3306);
    const env = myEnv(context);
    const tool = isMaria(context) && context.source.tool.mode !== 'native' ? 'mariadb' : 'mysql';
    const argv = wrapForMode(
      [
        tool,
        '-h',
        host,
        '-P',
        String(port),
        '-u',
        config.user,
        '--default-character-set=utf8mb4',
        ...(config.tls ? ['--ssl-mode=REQUIRED'] : []),
        ...(single ? [database!] : []),
      ],
      Object.keys(env),
      context.source.tool,
      context.runner,
      isMaria(context) ? DEFAULT_IMAGES.mariadb! : DEFAULT_IMAGES.mysql!,
    );
    context.log(
      'info',
      `Running ${tool} into ${single ? `"${database}"` : 'the server'} (tables in the dump are replaced)`,
    );
    const proc = await context.runner.spawn(argv, env);
    await intoProcess(proc, input, tool, context.signal);
  },
  async check(context) {
    const config = asKind(context.resource, 'mysql')!;
    const database = context.source.database || config.database;
    const conn = await myAdmin(context, config);
    try {
      const [rows] = await conn.query(
        database
          ? 'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ?'
          : "SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema NOT IN ('mysql','sys','performance_schema','information_schema')",
        database ? [database] : [],
      );
      const n = (rows as { n: number }[])[0]?.n ?? 0;
      return `${n} tables${database ? ` in "${database}"` : ''}`;
    } finally {
      await conn.end().catch(() => undefined);
    }
  },
};

// ── SQL Server ────────────────────────────────────────────────────────────

async function msPool(
  context: SourceContext,
  config: ResourceConfigOf<'mssql'>,
  database = 'master',
) {
  const pool = new mssql.ConnectionPool({
    server: context.source.host || config.host,
    port: context.source.port ?? config.port,
    user: config.user,
    password: context.password,
    database,
    connectionTimeout: 10_000,
    // BACKUP and RESTORE of big databases take long.
    requestTimeout: 6 * 60 * 60_000,
    options: {
      encrypt: config.encrypt,
      trustServerCertificate: config.trustServerCertificate,
      appName: context.connectorContext.appName,
    },
  });
  pool.on('error', () => undefined);
  await pool.connect();
  return pool;
}

/** Where SQL Server writes its backup file (read back through the runner). */
async function msBackupDir(pool: mssql.ConnectionPool): Promise<string> {
  const r = await pool
    .request()
    .query<{ path: string | null }>(
      "SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000)) AS path",
    );
  const path = r.recordset[0]?.path;
  return path && path.length > 0 ? path.replace(/[\\/]+$/, '') : '/var/opt/mssql/data';
}

const joinPath = (dir: string, name: string) =>
  dir.includes('\\') ? `${dir}\\${name}` : `${dir}/${name}`;

/** argv that prints a file on the SQL Server machine (container, server or this machine). */
function catArgv(context: SourceContext, path: string, remove: boolean): string[] {
  const script = `cat ${shellQuote(path)}${remove ? ` && rm -f ${shellQuote(path)}` : ''}`;
  return wrapForMode(['sh', '-c', script], [], context.source.tool, context.runner, '');
}

export const mssqlAdapter: SourceAdapter = {
  kind: 'mssql',
  validate: (source, resource) => [
    ...needResource('SQL Server', resource),
    ...(resource && resource.kind !== 'mssql' ? ['the chosen connection is not SQL Server'] : []),
    ...(source.tool.mode === 'docker-image' || source.tool.mode === 'driver'
      ? [
          'SQL Server writes the backup on its own machine: choose "inside its container" or "installed" with the server it runs on',
        ]
      : []),
    ...(source.tool.mode === 'native' &&
    source.tool.runner === 'local' &&
    process.platform === 'win32'
      ? ['on Windows choose the server that runs SQL Server (over SSH), or its container']
      : []),
    ...modeProblems(source),
  ],
  targetLabel: (source, resource) =>
    `${source.database || (resource as ResourceConfigOf<'mssql'>)?.database || 'master'} on ${resource?.name ?? resource?.id ?? 'SQL Server'}`,
  async backup(context) {
    const config = asKind(context.resource, 'mssql')!;
    const database = context.source.database || config.database;
    const differential = context.type === 'differential';
    const pool = await msPool(context, config);
    let path: string;
    try {
      const dir = await msBackupDir(pool);
      path = joinPath(dir, `gridcity-${Date.now()}.bak`);
      context.log(
        'info',
        `BACKUP DATABASE [${database}] ${differential ? 'WITH DIFFERENTIAL' : '(full, COPY_ONLY)'} to ${path}`,
      );
      // Full backups are COPY_ONLY unless this job takes differentials, which need a real base.
      const takesDifferentials = context.strategy === 'differential';
      await pool
        .request()
        .batch(
          `BACKUP DATABASE [${database.replace(/]/g, ']]')}] TO DISK = N'${path.replace(/'/g, "''")}' WITH ${
            differential ? 'DIFFERENTIAL, ' : takesDifferentials ? '' : 'COPY_ONLY, '
          }INIT, FORMAT, CHECKSUM`,
        );
      await pool
        .request()
        .batch(`RESTORE VERIFYONLY FROM DISK = N'${path.replace(/'/g, "''")}' WITH CHECKSUM`);
      context.log('info', 'RESTORE VERIFYONLY passed on the server');
    } finally {
      await pool.close().catch(() => undefined);
    }
    const proc = await context.runner.spawn(catArgv(context, path, true));
    const { stream, done } = fromProcess(proc, 'reading the .bak file', context.signal);
    return {
      stream,
      done,
      contentFormat: differential
        ? 'SQL Server differential backup (.bak)'
        : 'SQL Server full backup (.bak)',
      extension: '.bak',
      tool: 'BACKUP DATABASE',
      details: { database, host: config.host, port: config.port },
    };
  },
  async restore(context, input) {
    const config = asKind(context.resource, 'mssql')!;
    const database = context.source.database || config.database;
    const last = context.chainIndex === context.chainLength - 1;
    const pool = await msPool(context, config);
    try {
      const dir = await msBackupDir(pool);
      const path = joinPath(dir, `gridcity-restore-${Date.now()}.bak`);
      const write = wrapForMode(
        ['sh', '-c', `cat > ${shellQuote(path)}`],
        [],
        context.source.tool,
        context.runner,
        '',
      );
      await intoProcess(
        await context.runner.spawn(write),
        input,
        'writing the .bak file',
        context.signal,
      );
      try {
        const esc = path.replace(/'/g, "''");
        const files = await pool
          .request()
          .query<{ LogicalName: string; PhysicalName: string; Type: string }>(
            `RESTORE FILELISTONLY FROM DISK = N'${esc}'`,
          );
        const dataDir =
          (
            await pool
              .request()
              .query<{ d: string }>(
                "SELECT CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000)) AS d",
              )
          ).recordset[0]?.d?.replace(/[\\/]+$/, '') ?? dir;
        const original = context.manifest.source.details.database as string;
        // Another name: move the files so they do not collide with the original database.
        const moves =
          original !== database
            ? files.recordset
                .map((f, i) => {
                  const ext = f.Type === 'L' ? '_log.ldf' : i === 0 ? '.mdf' : `_${i}.ndf`;
                  return `MOVE N'${f.LogicalName.replace(/'/g, "''")}' TO N'${joinPath(dataDir, `${database}${ext}`).replace(/'/g, "''")}'`;
                })
                .join(', ')
            : '';
        context.log(
          'info',
          `RESTORE DATABASE [${database}] ${last ? 'WITH RECOVERY' : 'WITH NORECOVERY'}`,
        );
        await pool
          .request()
          .batch(
            `RESTORE DATABASE [${database.replace(/]/g, ']]')}] FROM DISK = N'${esc}' WITH REPLACE, ${
              last ? 'RECOVERY' : 'NORECOVERY'
            }${moves ? `, ${moves}` : ''}`,
          );
      } finally {
        await runToEnd(
          context.runner,
          wrapForMode(['rm', '-f', path], [], context.source.tool, context.runner, ''),
          {
            timeoutMs: 30_000,
          },
        ).catch(() => undefined);
      }
    } finally {
      await pool.close().catch(() => undefined);
    }
  },
  async check(context) {
    const config = asKind(context.resource, 'mssql')!;
    const database = context.source.database || config.database;
    const pool = await msPool(context, config, database);
    try {
      const r = await pool.request().query<{ n: number }>('SELECT COUNT(*) AS n FROM sys.tables');
      return `${r.recordset[0]?.n ?? 0} tables in "${database}"`;
    } finally {
      await pool.close().catch(() => undefined);
    }
  },
};

// ── Firebird ──────────────────────────────────────────────────────────────

function fbDatabase(context: SourceContext): string {
  const { source } = context;
  const path = source.path ?? '';
  if (source.tool.mode === 'docker-exec' && !source.host) return path; // local, embedded access inside the container
  const host = hostForMode(source.host || '127.0.0.1', source.tool, context.runner);
  return `${host}/${source.port ?? 3050}:${path}`;
}

function fbEnv(context: SourceContext): Record<string, string> {
  return {
    ISC_USER: context.source.user || 'SYSDBA',
    ...(context.password ? { ISC_PASSWORD: context.password } : {}),
  };
}

export const firebirdAdapter: SourceAdapter = {
  kind: 'firebird',
  validate: (source) => [
    ...(source.path
      ? []
      : ['enter the database file path on the Firebird server (/var/lib/firebird/data/app.fdb)']),
    ...modeProblems(source),
  ],
  targetLabel: (source) =>
    `${source.path ?? 'Firebird database'}${source.host ? ` on ${source.host}` : ''}`,
  async backup(context) {
    const env = fbEnv(context);
    const database = fbDatabase(context);
    const gbak = context.source.tool.mode === 'native' ? 'gbak' : '/opt/firebird/bin/gbak';
    const argv = wrapForMode(
      [gbak, '-b', '-g', '-v', database, 'stdout'],
      Object.keys(env),
      context.source.tool,
      context.runner,
      DEFAULT_IMAGES.firebird!,
    );
    context.log('info', `Running gbak -b for ${database} via ${describeMode(context)}`);
    const proc = await context.runner.spawn(argv, env);
    const { stream, done } = fromProcess(proc, 'gbak', context.signal);
    return {
      stream,
      done,
      contentFormat: 'Firebird gbak backup (.fbk)',
      extension: '.fbk',
      tool: 'gbak',
      details: { database: context.source.path, host: context.source.host ?? null },
    };
  },
  async restore(context, input) {
    const env = fbEnv(context);
    const database = fbDatabase(context);
    const gbak = context.source.tool.mode === 'native' ? 'gbak' : '/opt/firebird/bin/gbak';
    const argv = wrapForMode(
      [gbak, '-rep', 'stdin', database],
      Object.keys(env),
      context.source.tool,
      context.runner,
      DEFAULT_IMAGES.firebird!,
    );
    context.log('info', `Running gbak -rep into ${database} (the database file is replaced)`);
    await intoProcess(await context.runner.spawn(argv, env), input, 'gbak', context.signal);
  },
};

export function describeMode(context: SourceContext): string {
  const { tool } = context.source;
  const where = context.runner.label;
  switch (tool.mode) {
    case 'docker-image':
      return `a temporary ${tool.image || 'official'} container on ${where}`;
    case 'docker-exec':
      return `container "${tool.container}" on ${where}`;
    case 'native':
      return `the tool installed on ${where}`;
    default:
      return 'GRIDCITY itself (database driver)';
  }
}
