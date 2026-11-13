import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database';
import {
  betterSqlite3Loads,
  openSqlite,
  resetSqliteDriverForTests,
  sqliteDriver,
  type SqliteDatabase,
} from './sqlite';

const dir = mkdtempSync(join(tmpdir(), 'gridcity-sqlite-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// better-sqlite3 is optional: npm may have left it out (no C++ toolchain for npm 10).
const DRIVERS = [
  ...(betterSqlite3Loads() ? [['better-sqlite3', 'better-sqlite3'] as const] : []),
  ['node', 'node:sqlite'] as const,
];

describe.each(DRIVERS)('SQLite driver %s', (setting, name) => {
  const before = process.env.GRIDCITY_SQLITE_DRIVER;
  let db: SqliteDatabase;

  beforeEach(() => {
    process.env.GRIDCITY_SQLITE_DRIVER = setting;
    resetSqliteDriverForTests();
    db = openSqlite(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, data BLOB)');
  });

  afterEach(() => {
    db.close();
    if (before === undefined) delete process.env.GRIDCITY_SQLITE_DRIVER;
    else process.env.GRIDCITY_SQLITE_DRIVER = before;
    resetSqliteDriverForTests();
  });

  it('is the driver asked for', () => {
    expect(sqliteDriver()).toEqual({ name, nativeError: null });
  });

  it('runs the app migrations and stores rows', () => {
    const app = openDatabase(':memory:');
    expect(app.pragma('user_version', { simple: true })).toBeGreaterThan(0);
    expect(app.pragma('foreign_keys', { simple: true })).toBe(1);
    app.close();
  });

  it('binds positional and named parameters like better-sqlite3', () => {
    const info = db.prepare('INSERT INTO t (name, data) VALUES (?, ?)').run('a', null);
    expect(Number(info.changes)).toBe(1);
    expect(Number(info.lastInsertRowid)).toBe(1);
    // Extra keys are ignored and undefined binds as NULL.
    db.prepare('INSERT INTO t (name, data) VALUES (@name, @data)').run({
      name: 'b',
      data: undefined,
      unused: 1,
    });
    expect(db.prepare('SELECT id, name, data FROM t ORDER BY id').all()).toEqual([
      { id: 1, name: 'a', data: null },
      { id: 2, name: 'b', data: null },
    ]);
    expect(db.prepare('SELECT name FROM t WHERE id = ?').get(99)).toBeUndefined();
  });

  it('returns BLOBs as Buffers and rows as plain objects', () => {
    db.prepare('INSERT INTO t (name, data) VALUES (?, ?)').run('x', Buffer.from([1, 2, 3]));
    const row = db.prepare('SELECT data FROM t').get() as { data: Buffer };
    expect(Buffer.isBuffer(row.data)).toBe(true);
    expect([...row.data]).toEqual([1, 2, 3]);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(db.prepare('SELECT 1 AS one').get()))).toEqual({ one: 1 });
  });

  it('reads pragmas', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(0);
    db.pragma('user_version = 7');
    expect(db.pragma('user_version', { simple: true })).toBe(7);
    expect(db.pragma('table_info(t)')).toHaveLength(3);
  });

  it('commits a transaction, rolls it back on throw, and nests', () => {
    const insert = db.prepare('INSERT INTO t (name) VALUES (?)');
    db.transaction((n: string) => insert.run(n))('kept');
    expect(() =>
      db.transaction(() => {
        insert.run('dropped');
        throw new Error('boom');
      })(),
    ).toThrow('boom');
    db.transaction(() => {
      insert.run('outer');
      try {
        db.transaction(() => {
          insert.run('inner');
          throw new Error('inner fails');
        })();
      } catch {
        // the inner savepoint rolls back; the outer work stays
      }
    })();
    expect(db.inTransaction).toBe(false);
    expect(db.prepare('SELECT name FROM t ORDER BY id').all()).toEqual([
      { name: 'kept' },
      { name: 'outer' },
    ]);
  });

  it('gives the explorer reader, columns, raw rows, iterate and safe integers', () => {
    db.prepare('INSERT INTO t (id, name) VALUES (?, ?)').run(9007199254740993n, 'big');
    db.defaultSafeIntegers(true);
    const select = db.prepare('SELECT id, name FROM t');
    expect(select.reader).toBe(true);
    expect(db.prepare('DELETE FROM t WHERE 0').reader).toBe(false);
    expect(select.columns().map((c) => [c.name, c.type])).toEqual([
      ['id', 'INTEGER'],
      ['name', 'TEXT'],
    ]);
    select.raw(true);
    expect([...select.iterate()]).toEqual([[9007199254740993n, 'big']]);
  });

  it('opens read-only and refuses missing files when asked', () => {
    const file = join(dir, `${setting}.db`);
    const rw = openSqlite(file);
    rw.exec('CREATE TABLE k (v)');
    rw.close();
    const ro = openSqlite(file, { readonly: true, fileMustExist: true });
    expect(() => ro.exec('INSERT INTO k VALUES (1)')).toThrow(/readonly/i);
    ro.close();
    expect(() => openSqlite(join(dir, 'missing.db'), { fileMustExist: true })).toThrow();
  });
});
