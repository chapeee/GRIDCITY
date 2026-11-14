import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqlite } from '../storage/sqlite';
import type { ManageMode } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseResourcesYaml } from '../config/resources-file';
import type { ConnectorContext } from '../connectors/connector';
import { parseInfo } from './redis';
import { createSqlExplorer, type SqlExplorer } from './sql';
import { firstKeyword, isRowStatement, readModeProblem, splitStatements } from './sql-text';
import { fromJsonValue, toJsonValue } from './values';

describe('splitStatements', () => {
  it('splits on semicolons outside strings, identifiers and comments', () => {
    expect(splitStatements('select 1; select \'a;b\'; -- x;\nselect "c;d" /* ; */')).toEqual([
      'select 1',
      "select 'a;b'",
      '-- x;\nselect "c;d" /* ; */',
    ]);
  });

  it('keeps PostgreSQL dollar-quoted bodies and SQL Server brackets whole', () => {
    expect(
      splitStatements(
        'create function f() returns int as $$ begin; return 1; end $$ language plpgsql; select 2',
      ),
    ).toHaveLength(2);
    expect(splitStatements('select [a;b] from t; select 1')).toEqual([
      'select [a;b] from t',
      'select 1',
    ]);
  });

  it('drops empty statements and comment-only pieces', () => {
    expect(splitStatements(';; -- nothing\n;select 1;')).toEqual(['select 1']);
  });
});

describe('read mode', () => {
  it('allows statements that only return rows', () => {
    for (const sql of [
      'SELECT 1',
      '  with x as (select 1) select * from x',
      'show tables',
      'EXPLAIN select 1',
      'pragma table_info(t)',
    ]) {
      expect(readModeProblem(sql)).toBeNull();
      expect(isRowStatement(sql)).toBe(true);
    }
  });

  it('refuses writes, DDL, file writes and setting pragmas with a clear reason', () => {
    expect(readModeProblem('delete from t')).toMatch(/DELETE changes data/);
    expect(readModeProblem('/* hi */ DROP TABLE t')).toMatch(/DROP/);
    expect(readModeProblem("select * from t into outfile '/tmp/x'")).toMatch(/OUTFILE/);
    expect(readModeProblem('pragma journal_mode = wal')).toMatch(/PRAGMA/);
  });

  it('refuses SELECTs that act on the server, however they are written', () => {
    for (const sql of [
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'app'",
      'select PG_RELOAD_CONF()',
      'SELECT pg_catalog.pg_cancel_backend(42)',
      'SELECT "pg_terminate_backend"(42)',
      'SELECT pg_terminate_backend/**/(42)',
      'SELECT pg_advisory_lock(1)',
      'SELECT pg_stat_reset()',
      "SELECT lo_export(1, '/tmp/x')",
      "SELECT GET_LOCK('deploy', 0)",
      "SELECT load_extension('evil')",
    ]) {
      expect(readModeProblem(sql), sql).toMatch(/acts on the server/);
    }
    // Reading about sessions is fine.
    expect(readModeProblem('SELECT pid, state FROM pg_stat_activity')).toBeNull();
    expect(readModeProblem('SELECT pg_size_pretty(pg_database_size(current_database()))')).toBe(
      null,
    );
  });

  it('reads the first keyword past comments', () => {
    expect(firstKeyword('-- c\n# d\n/* e */ update t set a = 1')).toBe('UPDATE');
  });
});

describe('values', () => {
  it('keeps big integers exact and small ones as numbers', () => {
    expect(toJsonValue(42n)).toBe(42);
    expect(toJsonValue(9007199254740993n)).toBe('9007199254740993');
  });

  it('shows binary as a preview and refuses to write it back', () => {
    const value = toJsonValue(Buffer.from([1, 2, 3]));
    expect(value).toEqual({ $binary: 'AQID', bytes: 3 });
    expect(() => fromJsonValue(value)).toThrow(/binary/);
  });

  it('turns dates into ISO text and objects into JSON for writes', () => {
    expect(toJsonValue(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(fromJsonValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('Redis INFO parsing', () => {
  it('groups fields by section', () => {
    const info = parseInfo(
      '# Server\r\nredis_version:7.4.1\r\n# Keyspace\r\ndb0:keys=3,expires=1\r\n',
    );
    expect(info.server?.redis_version).toBe('7.4.1');
    expect(info.keyspace?.db0).toBe('keys=3,expires=1');
  });
});

describe('the Manage setting in resources.yaml', () => {
  it('accepts read and write, and refuses anything else', () => {
    const ok = parseResourcesYaml(
      'resources:\n  - { kind: sqlite, id: a, path: /x.db, manage: write }\n',
    );
    expect(ok.ok && ok.config.resources[0]).toMatchObject({ manage: 'write' });
    const refused = parseResourcesYaml(
      'resources:\n  - { kind: sqlite, id: a, path: /x.db, manage: yes }\n',
    );
    expect(refused.ok && refused.config.resources).toEqual([]);
    expect(refused.ok && refused.skipped.join()).toMatch(/manage/);
  });
});

describe('the shared SQL explorer (SQLite, a real file)', () => {
  let dir: string;
  let file: string;
  let mode: ManageMode;
  let explorer: SqlExplorer;
  const context: ConnectorContext = { env: {}, homeDir: tmpdir(), appName: 'test', now: Date.now };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'explore-'));
    file = join(dir, 'shop.db');
    const db = openSqlite(file);
    db.exec(`
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE);
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id), total REAL, note TEXT);
      CREATE TABLE tags (label TEXT);
      INSERT INTO customers (name, email) VALUES ('Ana', 'ana@x'), ('Bo', 'bo@x'), ('Cy', 'cy@x');
      INSERT INTO orders (customer_id, total, note) VALUES (1, 9.5, 'gift'), (1, 3, NULL), (2, 120, 'rush');
      INSERT INTO tags VALUES ('same'), ('same');
    `);
    db.close();
    mode = 'read';
    explorer = createSqlExplorer(
      { kind: 'sqlite', id: 'shop', path: file, tags: [], dependsOn: [] },
      context,
      () => mode,
    );
  });

  afterEach(async () => {
    await explorer.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists tables and describes columns, keys and relations both ways', async () => {
    expect((await explorer.tables('main')).map((t) => t.name)).toEqual([
      'customers',
      'orders',
      'tags',
    ]);
    const orders = await explorer.table('main', 'main', 'orders');
    expect(orders.columns.find((c) => c.name === 'id')).toMatchObject({
      primaryKey: true,
      autoIncrement: true,
    });
    expect(orders.foreignKeys[0]).toMatchObject({
      refTable: 'customers',
      columns: ['customer_id'],
      refColumns: ['id'],
    });
    const customers = await explorer.table('main', 'main', 'customers');
    expect(customers.referencedBy[0]).toMatchObject({ table: 'orders', columns: ['customer_id'] });
  });

  it('pages, sorts and searches rows, with a total', async () => {
    const page = await explorer.rows('main', {
      schema: 'main',
      table: 'orders',
      limit: 2,
      offset: 0,
      orderBy: 'total',
      descending: true,
    });
    expect(page.rows.map((r) => r[2])).toEqual([120, 9.5]);
    expect(page.total).toBe(3);
    expect(page.primaryKey).toEqual(['id']);
    const found = await explorer.rows('main', {
      schema: 'main',
      table: 'orders',
      limit: 10,
      offset: 0,
      search: 'rus',
    });
    expect(found.rows).toHaveLength(1);
  });

  it('refuses unknown columns instead of putting them into SQL', async () => {
    await expect(
      explorer.rows('main', {
        schema: 'main',
        table: 'orders',
        limit: 1,
        offset: 0,
        orderBy: 'total; drop table orders',
      }),
    ).rejects.toThrow(/unknown column/);
  });

  it('runs scripts, caps results, and refuses writes in read mode', async () => {
    const result = await explorer.query(
      'main',
      'select count(*) as n from orders; select name from customers order by id',
    );
    expect(result.results.map((r) => r.rows)).toEqual([[[3]], [['Ana'], ['Bo'], ['Cy']]]);
    await expect(explorer.query('main', 'delete from orders')).rejects.toThrow(/switch Changes on/);
    await expect(
      explorer.updateRow('main', {
        schema: 'main',
        table: 'orders',
        key: { id: 1 },
        values: { total: 1 },
      }),
    ).rejects.toThrow(/Changes are off/);
  });

  it('edits exactly one row in write mode, and refuses ambiguous keys', async () => {
    mode = 'write';
    await explorer.updateRow('main', {
      schema: 'main',
      table: 'orders',
      key: { id: 1 },
      values: { note: 'changed' },
    });
    await explorer.insertRow('main', {
      schema: 'main',
      table: 'customers',
      key: {},
      values: { name: 'Di', email: 'di@x' },
    });
    await explorer.deleteRow('main', { schema: 'main', table: 'orders', key: { id: 2 } });
    const check = await explorer.query(
      'main',
      "select note from orders where id = 1; select count(*) from orders; select count(*) from customers where name = 'Di'",
    );
    expect(check.results.map((r) => r.rows[0]?.[0])).toEqual(['changed', 2, 1]);
    // Two identical rows and no key: nothing must change.
    await expect(
      explorer.deleteRow('main', { schema: 'main', table: 'tags', key: { label: 'same' } }),
    ).rejects.toThrow(/2 rows matched/);
    expect(
      (await explorer.query('main', 'select count(*) from tags')).results[0]?.rows[0]?.[0],
    ).toBe(2);
  });
});
