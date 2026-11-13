import { afterEach, describe, expect, it, vi } from 'vitest';

// Simulate Windows Application Control refusing better-sqlite3's native module.
vi.mock('better-sqlite3', () => ({
  default: class {
    constructor() {
      throw new Error(
        'An Application Control policy has blocked this file.\r\n' +
          '\\\\?\\C:\\npm\\node_modules\\better-sqlite3\\prebuilds\\win32-x64.node',
      );
    }
  },
}));

const { openDatabase } = await import('./database');
const { resetSqliteDriverForTests, sqliteDriver } = await import('./sqlite');

describe('when better-sqlite3 is blocked', () => {
  const before = process.env.GRIDCITY_SQLITE_DRIVER;
  afterEach(() => {
    if (before === undefined) delete process.env.GRIDCITY_SQLITE_DRIVER;
    else process.env.GRIDCITY_SQLITE_DRIVER = before;
    resetSqliteDriverForTests();
  });

  it('falls back to node:sqlite and the app database still works', () => {
    delete process.env.GRIDCITY_SQLITE_DRIVER;
    resetSqliteDriverForTests();
    const db = openDatabase(':memory:');
    expect(sqliteDriver().name).toBe('node:sqlite');
    expect(sqliteDriver().nativeError).toMatch(/Application Control/);
    db.prepare('INSERT INTO audit_log (at, kind) VALUES (?, ?)').run(1, 'test');
    expect(db.prepare('SELECT kind FROM audit_log').get()).toEqual({ kind: 'test' });
    db.close();
  });

  it('reports the block when better-sqlite3 is forced', () => {
    process.env.GRIDCITY_SQLITE_DRIVER = 'better-sqlite3';
    resetSqliteDriverForTests();
    expect(() => openDatabase(':memory:')).toThrow(/SQLite driver could not be loaded/);
  });
});
