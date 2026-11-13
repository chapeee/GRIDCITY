import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import type * as NodeSqlite from 'node:sqlite';

/**
 * One SQLite API for the whole server, on top of two drivers:
 *
 * - `better-sqlite3`, the default: fast, but a native `.node` file that some
 *   machines refuse to load (Windows Application Control / Smart App Control
 *   blocks unsigned DLLs, antivirus quarantines it, or the prebuild is missing).
 * - `node:sqlite`, built into Node itself (22.16+, 24+): nothing extra to load,
 *   so nothing to block. Used when better-sqlite3 cannot load.
 *
 * The API is the subset of better-sqlite3 the server uses, so with
 * better-sqlite3 the database object is returned as is. Set
 * GRIDCITY_SQLITE_DRIVER to `better-sqlite3` or `node` to pick one.
 */

export type SqliteDriverName = 'better-sqlite3' | 'node:sqlite';

export interface SqliteRunResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface SqliteColumn {
  name: string;
  type: string | null;
}

export interface SqliteStatement {
  /** True when the statement returns rows. */
  readonly reader: boolean;
  run(...params: unknown[]): SqliteRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  columns(): SqliteColumn[];
  /** Rows as arrays instead of objects. */
  raw(toggle?: boolean): this;
}

export interface SqliteDatabase {
  readonly inTransaction: boolean;
  prepare(sql: string): SqliteStatement;
  exec(sql: string): this;
  /** `PRAGMA <source>`; `simple` returns the first column of the first row. */
  pragma(source: string, options?: { simple?: boolean }): unknown;
  /** Wraps `fn` so that calling it runs inside BEGIN/COMMIT (ROLLBACK on throw). */
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  /** INTEGER columns read as bigint (statements prepared after the call). */
  defaultSafeIntegers(toggle?: boolean): this;
  close(): void;
}

export interface SqliteOpenOptions {
  readonly?: boolean;
  /** Fail instead of creating the file. */
  fileMustExist?: boolean;
  /** Busy timeout in ms. */
  timeout?: number;
}

/** Errors that mean the native binary itself could not load (not a bad path or file). */
export const NATIVE_LOAD_ERROR =
  /\.node\b|Application Control|was compiled against|invalid ELF|not a valid Win32|Could not locate the bindings file|blocked/i;

let chosen: { name: SqliteDriverName; nativeError: string | null } | null = null;

/** The driver in use (decided on first use), and why better-sqlite3 was skipped. */
export function sqliteDriver(): { name: SqliteDriverName; nativeError: string | null } {
  if (chosen) return chosen;
  const wanted = (process.env.GRIDCITY_SQLITE_DRIVER ?? '').trim().toLowerCase();
  if (wanted === 'node' || wanted === 'node:sqlite') {
    requireNodeSqlite(null);
    return (chosen = { name: 'node:sqlite', nativeError: null });
  }
  try {
    new BetterSqlite3(':memory:').close();
    return (chosen = { name: 'better-sqlite3', nativeError: null });
  } catch (error) {
    const message = (error as Error).message;
    if (wanted === 'better-sqlite3' || !NATIVE_LOAD_ERROR.test(message)) throw error;
    requireNodeSqlite(message);
    return (chosen = { name: 'node:sqlite', nativeError: message });
  }
}

/** Test hook: forget the chosen driver so the next open decides again. */
export function resetSqliteDriverForTests(): void {
  chosen = null;
}

export function openSqlite(file: string, options: SqliteOpenOptions = {}): SqliteDatabase {
  if (sqliteDriver().name === 'better-sqlite3') {
    return new BetterSqlite3(file, options) as unknown as SqliteDatabase;
  }
  return new NodeSqliteDatabase(file, options);
}

// ------------------------------------------------------------------ node:sqlite

/** Statement methods node:sqlite needs to stand in for better-sqlite3. */
const REQUIRED_STATEMENT_METHODS = [
  'columns',
  'iterate',
  'setReturnArrays',
  'setReadBigInts',
  'setAllowUnknownNamedParameters',
] as const;

function loadNodeSqlite(): typeof NodeSqlite | null {
  try {
    const mod = process.getBuiltinModule?.('node:sqlite') as typeof NodeSqlite | undefined;
    if (!mod?.DatabaseSync || !mod.StatementSync) return null;
    const proto = mod.StatementSync.prototype as unknown as Record<string, unknown>;
    return REQUIRED_STATEMENT_METHODS.every((m) => typeof proto[m] === 'function') ? mod : null;
  } catch {
    return null;
  }
}

function requireNodeSqlite(nativeError: string | null): typeof NodeSqlite {
  const mod = loadNodeSqlite();
  if (mod) return mod;
  const why = nativeError ? `${nativeError}. ` : '';
  throw new Error(
    `${why}The built-in SQLite fallback (node:sqlite) needs Node.js 22.16 or newer ` +
      `(this is ${process.version}): upgrade Node.js, or allow better-sqlite3's native module.`,
  );
}

/** better-sqlite3 binds undefined as NULL; node:sqlite refuses it. */
function bindable(value: unknown): unknown {
  return value === undefined ? null : value;
}

function bindParams(params: unknown[]): unknown[] {
  return params.map((param) => {
    if (
      param !== null &&
      typeof param === 'object' &&
      !ArrayBuffer.isView(param) &&
      !(param instanceof ArrayBuffer)
    ) {
      const named: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(param)) named[key] = bindable(value);
      return named;
    }
    return bindable(param);
  });
}

/** BLOBs as Buffer (node:sqlite gives Uint8Array); rows as plain objects. */
function fromSqlite(value: unknown): unknown {
  return value instanceof Uint8Array && !Buffer.isBuffer(value)
    ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
    : value;
}

function convertRow(row: unknown): unknown {
  if (row === undefined || row === null) return row;
  if (Array.isArray(row)) return row.map(fromSqlite);
  const plain: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row as object)) plain[key] = fromSqlite(value);
  return plain;
}

class NodeSqliteStatement implements SqliteStatement {
  readonly reader: boolean;

  constructor(
    private readonly statement: NodeSqlite.StatementSync,
    safeIntegers: boolean,
  ) {
    statement.setAllowUnknownNamedParameters(true);
    statement.setReadBigInts(safeIntegers);
    this.reader = statement.columns().length > 0;
  }

  run(...params: unknown[]): SqliteRunResult {
    return this.statement.run(...(bindParams(params) as never[]));
  }

  get(...params: unknown[]): unknown {
    return convertRow(this.statement.get(...(bindParams(params) as never[])));
  }

  all(...params: unknown[]): unknown[] {
    return this.statement.all(...(bindParams(params) as never[])).map(convertRow);
  }

  *iterate(...params: unknown[]): IterableIterator<unknown> {
    for (const row of this.statement.iterate(...(bindParams(params) as never[])))
      yield convertRow(row);
  }

  columns(): SqliteColumn[] {
    return this.statement.columns().map((c) => ({ name: c.name, type: c.type }));
  }

  raw(toggle = true): this {
    this.statement.setReturnArrays(toggle);
    return this;
  }
}

class NodeSqliteDatabase implements SqliteDatabase {
  private readonly db: NodeSqlite.DatabaseSync;
  private safeIntegers = false;
  private depth = 0;

  constructor(file: string, options: SqliteOpenOptions) {
    const { DatabaseSync } = requireNodeSqlite(null);
    if (options.fileMustExist && file !== ':memory:' && !existsSync(file)) {
      throw new Error(`unable to open database file: ${file} does not exist`);
    }
    this.db = new DatabaseSync(file, {
      readOnly: options.readonly ?? false,
      timeout: options.timeout ?? 5000,
    });
  }

  get inTransaction(): boolean {
    return this.db.isTransaction;
  }

  prepare(sql: string): SqliteStatement {
    return new NodeSqliteStatement(this.db.prepare(sql), this.safeIntegers);
  }

  exec(sql: string): this {
    this.db.exec(sql);
    return this;
  }

  pragma(source: string, options: { simple?: boolean } = {}): unknown {
    const statement = this.prepare(`PRAGMA ${source}`);
    if (!statement.reader) {
      statement.run();
      return options.simple ? undefined : [];
    }
    if (options.simple) {
      const row = statement.raw(true).get() as unknown[] | undefined;
      return row?.[0];
    }
    return statement.all();
  }

  transaction<F extends (...args: never[]) => unknown>(fn: F): F {
    const wrapped = (...args: Parameters<F>): unknown => {
      // Nested calls use a savepoint, as better-sqlite3 does.
      const savepoint = `gridcity_tx_${this.depth}`;
      const nested = this.depth > 0 || this.db.isTransaction;
      this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      this.depth++;
      try {
        const result = fn(...args);
        this.db.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return result;
      } catch (error) {
        if (this.db.isTransaction) {
          this.db.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        }
        throw error;
      } finally {
        this.depth--;
      }
    };
    return wrapped as F;
  }

  defaultSafeIntegers(toggle = true): this {
    this.safeIntegers = toggle;
    return this;
  }

  close(): void {
    if (this.db.isOpen) this.db.close();
  }
}
