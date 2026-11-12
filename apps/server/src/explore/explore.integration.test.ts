/**
 * The Manage explorers against REAL instances (compose.connectors-test.yaml).
 * Run with `npm run test:connectors`; skipped in the normal unit run because
 * it needs Docker. Each test creates its own objects and removes them.
 */
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { ManageMode } from '@app/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { ResourceConfigSchema, type ResourceConfig } from '../config/resources-file';
import { MongoExplorer } from './mongo';
import { RedisExplorer } from './redis';
import { S3Explorer } from './s3';
import { createSqlExplorer, type SqlExplorer } from './sql';

const enabled = process.env.CONNECTOR_TESTS === '1';
const env = { ROOT: 'test-root', MINIO_KEY: 'test-minio', MINIO_SECRET: 'test-minio-secret' };
const context = { env, homeDir: tmpdir(), appName: 'explore-tests', now: Date.now };
const suffix = Date.now().toString(36);
let mode: ManageMode = 'read';
const currentMode = () => mode;
const closers: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(closers.map((close) => close()));
});

const parse = <K extends ResourceConfig['kind']>(raw: Record<string, unknown>) =>
  ResourceConfigSchema.parse(raw) as Extract<ResourceConfig, { kind: K }>;

function sql(raw: Record<string, unknown>): SqlExplorer {
  const explorer = createSqlExplorer(parse(raw) as never, context, currentMode);
  closers.push(() => explorer.close());
  return explorer;
}

describe.skipIf(!enabled)('SQL explorer on PostgreSQL and MySQL (real instances)', () => {
  const engines = [
    {
      name: 'PostgreSQL',
      explorer: () =>
        sql({
          kind: 'postgres',
          id: 'pg',
          host: '127.0.0.1',
          port: 15432,
          user: 'postgres',
          passwordEnv: 'ROOT',
        }),
      db: 'postgres',
      schema: 'public',
    },
    {
      name: 'MySQL',
      explorer: () =>
        sql({
          kind: 'mysql',
          id: 'my',
          host: '127.0.0.1',
          port: 13306,
          user: 'root',
          passwordEnv: 'ROOT',
          database: 'shop',
        }),
      db: 'shop',
      schema: 'shop',
    },
  ];

  for (const engine of engines) {
    it(`${engine.name}: schema, rows, read-only enforcement and keyed edits`, async () => {
      const explorer = engine.explorer();
      const parent = `gc_parent_${suffix}`;
      const child = `gc_child_${suffix}`;
      mode = 'write';
      const auto =
        engine.name === 'MySQL' ? 'INT AUTO_INCREMENT PRIMARY KEY' : 'SERIAL PRIMARY KEY';
      await explorer.query(
        engine.db,
        `CREATE TABLE ${parent} (id ${auto}, name VARCHAR(40) NOT NULL);
         CREATE TABLE ${child} (id ${auto}, parent_id INT NOT NULL, note VARCHAR(40),
           FOREIGN KEY (parent_id) REFERENCES ${parent}(id));
         INSERT INTO ${parent} (name) VALUES ('a'), ('b');
         INSERT INTO ${child} (parent_id, note) VALUES (1, 'x'), (1, 'y'), (2, 'z')`,
      );
      try {
        mode = 'read';
        const tables = (await explorer.tables(engine.db)).map((t) => t.name);
        expect(tables).toEqual(expect.arrayContaining([parent, child]));
        const detail = await explorer.table(engine.db, engine.schema, child);
        expect(detail.foreignKeys[0]).toMatchObject({
          refTable: parent,
          columns: ['parent_id'],
          refColumns: ['id'],
        });
        expect(
          (await explorer.table(engine.db, engine.schema, parent)).referencedBy[0],
        ).toMatchObject({ table: child });

        const rows = await explorer.rows(engine.db, {
          schema: engine.schema,
          table: child,
          limit: 2,
          offset: 0,
          search: 'z',
        });
        expect(rows.rows).toHaveLength(1);
        expect(rows.total).toBe(1);

        await expect(explorer.query(engine.db, `DELETE FROM ${child}`)).rejects.toThrow(
          /switch Changes on/,
        );
        await expect(explorer.query(engine.db, `DROP TABLE ${child}`)).rejects.toThrow(
          /switch Changes on/,
        );

        mode = 'write';
        const key = { id: rows.rows[0]![0]! };
        await explorer.updateRow(engine.db, {
          schema: engine.schema,
          table: child,
          key,
          values: { note: 'changed' },
        });
        const after = await explorer.query(
          engine.db,
          `SELECT note FROM ${child} WHERE parent_id = 2`,
        );
        expect(after.results[0]?.rows[0]?.[0]).toBe('changed');
        await expect(
          explorer.deleteRow(engine.db, {
            schema: engine.schema,
            table: child,
            key: { parent_id: 1 },
          }),
        ).rejects.toThrow(/2 rows matched/);
      } finally {
        mode = 'write';
        await explorer.query(engine.db, `DROP TABLE ${child}; DROP TABLE ${parent}`);
        mode = 'read';
      }
    });
  }

  it('PostgreSQL: a huge SELECT stops at the row cap', async () => {
    const explorer = engines[0]!.explorer();
    const result = await explorer.query('postgres', 'SELECT g FROM generate_series(1, 50000) g');
    expect(result.results[0]?.rows).toHaveLength(1000);
    expect(result.results[0]?.truncated).toBe(true);
  });
});

describe.skipIf(!enabled)('Redis explorer (real instance)', () => {
  const explorer = new RedisExplorer(
    parse<'redis'>({ kind: 'redis', id: 'r', host: '127.0.0.1', port: 16379, passwordEnv: 'ROOT' }),
    context,
    currentMode,
  );
  closers.push(() => explorer.close());
  const key = `gc:test:${suffix}`;

  it('reads keys of every type, edits in write mode, and lets Redis decide what is a write', async () => {
    mode = 'write';
    await explorer.edit(15, { op: 'hset', key, field: 'a', value: '1' });
    await explorer.edit(15, { op: 'expire', key, ttl: 120 });
    const detail = await explorer.key(15, key);
    expect(detail).toMatchObject({ type: 'hash', value: { a: '1' } });
    expect(detail.ttl).toBeGreaterThan(100);
    const scan = await explorer.scan(15, `gc:test:${suffix}*`, '0');
    expect(scan.keys.map((k) => k.key)).toContain(key);

    mode = 'read';
    await expect(explorer.command(15, ['SET', key, 'x'])).rejects.toThrow(/switch Changes on/);
    await expect(explorer.command(15, ['CONFIG', 'SET', 'maxmemory', '1'])).rejects.toThrow(
      /switch Changes on/,
    );
    await expect(explorer.command(15, ['MONITOR'])).rejects.toThrow(/Activity/);
    expect((await explorer.command(15, ['HGET', key, 'a'])).reply).toBe('1');

    mode = 'write';
    await explorer.edit(15, { op: 'delete', keys: [key] });
    await expect(explorer.key(15, key)).rejects.toThrow(/does not exist/);
    mode = 'read';
  });

  it('records MONITOR for a short time', async () => {
    const recording = explorer.monitor(15, 1);
    const result = await recording;
    expect(Array.isArray(result.lines)).toBe(true);
  });
});

describe.skipIf(!enabled)('MongoDB explorer (real instance)', () => {
  const explorer = new MongoExplorer(
    parse<'mongodb'>({
      kind: 'mongodb',
      id: 'm',
      url: 'mongodb://127.0.0.1:27018/events',
      user: 'root',
      authSource: 'admin',
      passwordEnv: 'ROOT',
    }),
    context,
    currentMode,
  );
  closers.push(() => explorer.close());
  const collection = `gc_test_${suffix}`;

  it('finds, inserts, replaces and deletes documents; refuses writes in read mode', async () => {
    mode = 'read';
    await expect(explorer.insert('events', collection, '{"a":1}')).rejects.toThrow(
      /Changes are off/,
    );
    mode = 'write';
    const id = await explorer.insert(
      'events',
      collection,
      '{"name":"one","at":{"$date":"2026-01-01T00:00:00Z"}}',
    );
    const found = await explorer.find({
      database: 'events',
      collection,
      filter: '{"name":"one"}',
      limit: 10,
      skip: 0,
    });
    expect(found.total).toBe(1);
    expect(found.documents[0]).toMatchObject({
      name: 'one',
      at: { $date: '2026-01-01T00:00:00Z' },
    });
    await explorer.replace(
      'events',
      collection,
      id,
      '{"name":"two","at":{"$date":"2026-01-01T00:00:00Z"}}',
    );
    expect(
      (
        await explorer.find({
          database: 'events',
          collection,
          filter: '{"name":"two"}',
          limit: 1,
          skip: 0,
        })
      ).total,
    ).toBe(1);
    await explorer.remove('events', collection, id);
    await explorer.dropCollection('events', collection);
    mode = 'read';
  });
});

describe.skipIf(!enabled)('Object storage explorer on MinIO (real instance)', () => {
  const explorer = new S3Explorer(
    parse<'s3'>({
      kind: 's3',
      id: 's',
      provider: 'minio',
      endpoint: 'http://127.0.0.1:19000',
      accessKeyIdEnv: 'MINIO_KEY',
      secretAccessKeyEnv: 'MINIO_SECRET',
    }),
    context,
    currentMode,
  );
  closers.push(() => explorer.close());
  const bucket = `gc-test-${suffix}`;

  it('creates a bucket, uploads, lists, downloads, copies and deletes', async () => {
    mode = 'read';
    await expect(explorer.createBucket(bucket)).rejects.toThrow(/Changes are off/);
    mode = 'write';
    await explorer.createBucket(bucket);
    try {
      const body = Buffer.from('hello from the test');
      await explorer.upload(bucket, 'docs/a.txt', Readable.from(body), body.length, 'text/plain');
      const listing = await explorer.list(bucket, '');
      expect(listing.folders).toEqual(['docs/']);
      const file = await explorer.download(bucket, 'docs/a.txt');
      const chunks: Buffer[] = [];
      for await (const chunk of file.body) chunks.push(Buffer.from(chunk as Uint8Array));
      expect(Buffer.concat(chunks).toString()).toBe('hello from the test');
      await explorer.copy(bucket, 'docs/a.txt', 'docs/b.txt', true);
      expect((await explorer.list(bucket, 'docs/')).objects.map((o) => o.key)).toEqual([
        'docs/b.txt',
      ]);
      expect((await explorer.usage(bucket)).totalObjects).toBe(1);
      expect(await explorer.remove(bucket, [], 'docs/')).toBe(1);
    } finally {
      await explorer.deleteBucket(bucket);
      mode = 'read';
    }
  });
});
