import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database';
import { setBetterSqlite3LoaderForTests, sqliteDriver } from './sqlite';

/** Windows Application Control refusing better-sqlite3's native module. */
const blocked = () =>
  class {
    constructor() {
      throw new Error(
        'An Application Control policy has blocked this file.\r\n' +
          '\\\\?\\C:\\npm\\node_modules\\better-sqlite3\\prebuilds\\win32-x64.node',
      );
    }
  };

/** npm skipped the optional dependency (npm 10 could not compile it). */
const notInstalled = () => {
  const error = new Error("Cannot find module 'better-sqlite3'") as NodeJS.ErrnoException;
  error.code = 'MODULE_NOT_FOUND';
  throw error;
};

describe('when better-sqlite3 cannot be used', () => {
  const before = process.env.GRIDCITY_SQLITE_DRIVER;
  afterEach(() => {
    if (before === undefined) delete process.env.GRIDCITY_SQLITE_DRIVER;
    else process.env.GRIDCITY_SQLITE_DRIVER = before;
    setBetterSqlite3LoaderForTests(null);
  });

  it.each([
    ['blocked', blocked, /Application Control/],
    ['not installed', notInstalled, /not installed/],
  ])('falls back to node:sqlite when it is %s', (_label, loader, reason) => {
    delete process.env.GRIDCITY_SQLITE_DRIVER;
    setBetterSqlite3LoaderForTests(loader);
    const db = openDatabase(':memory:');
    expect(sqliteDriver().name).toBe('node:sqlite');
    expect(sqliteDriver().nativeError).toMatch(reason);
    db.prepare('INSERT INTO audit_log (at, kind) VALUES (?, ?)').run(1, 'test');
    expect(db.prepare('SELECT kind FROM audit_log').get()).toEqual({ kind: 'test' });
    db.close();
  });

  it('reports the block when better-sqlite3 is forced', () => {
    process.env.GRIDCITY_SQLITE_DRIVER = 'better-sqlite3';
    setBetterSqlite3LoaderForTests(blocked);
    expect(() => openDatabase(':memory:')).toThrow(/SQLite driver could not be loaded/);
  });

  it('does not hide other errors behind the fallback', () => {
    delete process.env.GRIDCITY_SQLITE_DRIVER;
    setBetterSqlite3LoaderForTests(() => {
      throw new Error('something unrelated');
    });
    expect(() => sqliteDriver()).toThrow('something unrelated');
  });
});
