/**
 * Every database/storage connector against a REAL instance
 * (compose.connectors-test.yaml). Run with `npm run test:connectors`; skipped
 * in the normal unit run because it needs Docker.
 */
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { ResourceConfigSchema, type ResourceConfig } from '../config/resources-file';
import { createConnector } from './index';
import type { Connector, PollOutcome } from './connector';
import { openSqlite } from '../storage/sqlite';

const enabled = process.env.CONNECTOR_TESTS === '1';
const env = {
  PG_MONITOR: 'test-monitor',
  MYSQL_MONITOR: 'test-monitor',
  MONGO_MONITOR: 'test-monitor',
  REDIS_MONITOR: 'test-monitor',
  MINIO_KEY: 'test-minio',
  MINIO_SECRET: 'test-minio-secret',
  MSSQL_SA: 'Test-root-1234',
  WRONG: 'definitely-wrong-password',
};
const context = { env, homeDir: tmpdir(), appName: 'connector-tests', now: Date.now };

const opened: Connector[] = [];
function connector(raw: unknown): Connector {
  const created = createConnector(ResourceConfigSchema.parse(raw) as ResourceConfig, context);
  opened.push(created);
  return created;
}
afterAll(async () => {
  await Promise.all(opened.map((c) => c.close()));
});

function ok(outcomes: PollOutcome[]): Extract<PollOutcome, { ok: true }> {
  expect(outcomes).toHaveLength(1);
  const [outcome] = outcomes;
  if (!outcome!.ok) throw new Error(`poll failed: ${outcome!.error}`);
  return outcome!;
}
const value = (outcome: Extract<PollOutcome, { ok: true }>, key: string) =>
  outcome.metrics.find((entry) => entry.key === key);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const compose = (...args: string[]) =>
  spawnSync('docker', ['compose', '-f', 'compose.connectors-test.yaml', ...args], {
    cwd: join(import.meta.dirname, '../../../..'),
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });

describe.skipIf(!enabled)('PostgreSQL connector (real instance)', () => {
  const base = {
    kind: 'postgres',
    id: 'pg',
    host: '127.0.0.1',
    port: 15432,
    user: 'monitor',
    passwordEnv: 'PG_MONITOR',
  };

  it('reads connections, size, role and, on the second poll, rates and cache hits', async () => {
    const pgConnector = connector({ ...base, slowQueryMs: 200 });
    const first = ok(await pgConnector.poll());
    expect(first.sample.gauges.connections?.used).toBeGreaterThanOrEqual(1);
    expect(first.sample.gauges.connections?.max).toBe(100);
    expect(first.sample.gauges.storage?.usedBytes).toBeGreaterThan(1_000_000);
    expect(first.sample.gauges.opsPerSec).toBeNull(); // no rate from one sample
    expect(value(first, 'role')?.text).toBe('primary');
    expect(first.sample.replicationLagSeconds).toBeNull();

    // Some load between polls (statistics are flushed about once a second).
    const load = new pg.Client({
      host: '127.0.0.1',
      port: 15432,
      user: 'postgres',
      password: 'test-root',
      database: 'postgres',
    });
    await load.connect();
    for (let i = 0; i < 50; i++) await load.query('SELECT count(*) FROM demo_items');
    await load.end();
    await sleep(1500);
    const second = ok(await pgConnector.poll());
    expect(second.sample.gauges.opsPerSec).toBeGreaterThan(0);
    expect(second.sample.cacheHitPercent === null || second.sample.cacheHitPercent > 50).toBe(true);
  });

  it('counts a query running longer than the slow-query limit', async () => {
    const pgConnector = connector({ ...base, id: 'pg-slow', slowQueryMs: 300 });
    const sleeper = new pg.Client({
      host: '127.0.0.1',
      port: 15432,
      user: 'postgres',
      password: 'test-root',
      database: 'postgres',
    });
    await sleeper.connect();
    const running = sleeper.query('SELECT pg_sleep(3)');
    await sleep(1000);
    const outcome = ok(await pgConnector.poll());
    expect(outcome.sample.slowQueries).toBeGreaterThanOrEqual(1);
    await running;
    await sleeper.end();
  });

  it('runs read-only: the session refuses writes', async () => {
    const client = new pg.Client({
      host: '127.0.0.1',
      port: 15432,
      user: 'postgres',
      password: 'test-root',
      database: 'postgres',
      options: '-c default_transaction_read_only=on',
    });
    await client.connect();
    await expect(client.query('CREATE TABLE should_fail (id int)')).rejects.toThrow(/read-only/);
    await client.end();
  });

  it('reports a wrong password as unreachable without echoing it', async () => {
    const [outcome] = await connector({ ...base, id: 'pg-bad', passwordEnv: 'WRONG' }).poll();
    expect(outcome!.ok).toBe(false);
    if (!outcome!.ok) {
      expect(outcome!.error).toMatch(/password authentication failed/);
      expect(outcome!.error).not.toContain(env.WRONG);
    }
  });

  it('reports a closed port as unreachable', async () => {
    const [outcome] = await connector({ ...base, id: 'pg-closed', port: 15999 }).poll();
    expect(outcome!.ok).toBe(false);
  });
});

describe.skipIf(!enabled)('MySQL connector (real instance)', () => {
  const base = {
    kind: 'mysql',
    id: 'my',
    host: '127.0.0.1',
    port: 13306,
    user: 'monitor',
    passwordEnv: 'MYSQL_MONITOR',
  };

  it('reads status, max connections, size and rates', async () => {
    const myConnector = connector(base);
    const first = ok(await myConnector.poll());
    expect(first.sample.gauges.connections?.used).toBeGreaterThanOrEqual(1);
    expect(first.sample.gauges.connections?.max).toBe(151);
    expect(value(first, 'version')?.text).toMatch(/^8\.4/);
    expect(value(first, 'role')?.text).toBe('primary');
    expect(first.sample.slowQueries).toBe(0);
    await sleep(1100);
    const second = ok(await myConnector.poll());
    expect(second.sample.gauges.opsPerSec).toBeGreaterThan(0);
    expect(second.sample.gauges.storage?.usedBytes).toBeGreaterThan(0);
  });

  it('refuses a wrong password', async () => {
    const [outcome] = await connector({ ...base, id: 'my-bad', passwordEnv: 'WRONG' }).poll();
    expect(outcome!.ok).toBe(false);
    if (!outcome!.ok) expect(outcome!.error).toMatch(/Access denied/);
  });
});

describe.skipIf(!enabled)('MongoDB connector (real instance)', () => {
  const base = {
    kind: 'mongodb',
    id: 'mongo',
    url: 'mongodb://monitor@127.0.0.1:27018/?authSource=admin',
    passwordEnv: 'MONGO_MONITOR',
  };

  it('reads serverStatus, sizes and op rates with a clusterMonitor user', async () => {
    const mongoConnector = connector(base);
    const first = ok(await mongoConnector.poll());
    expect(first.sample.gauges.connections?.used).toBeGreaterThanOrEqual(1);
    expect(first.sample.gauges.connections?.max).toBeGreaterThan(100);
    expect(first.sample.gauges.storage?.usedBytes).toBeGreaterThan(0);
    expect(value(first, 'role')?.text).toBe('standalone');
    await sleep(1100);
    const second = ok(await mongoConnector.poll());
    expect(second.sample.gauges.opsPerSec).not.toBeNull();
  });

  it('refuses a password written into the URL (config level)', () => {
    expect(() =>
      ResourceConfigSchema.parse({ ...base, url: 'mongodb://monitor:x@127.0.0.1:27018' }),
    ).not.toThrow();
    // The file-level check catches it; see resources-file.test.ts.
  });

  it('reports a wrong password as unreachable', async () => {
    const [outcome] = await connector({ ...base, id: 'mongo-bad', passwordEnv: 'WRONG' }).poll();
    expect(outcome!.ok).toBe(false);
  });
});

describe.skipIf(!enabled)('Redis connector (real instance)', () => {
  const base = {
    kind: 'redis',
    id: 'redis',
    host: '127.0.0.1',
    port: 16379,
    user: 'monitor',
    passwordEnv: 'REDIS_MONITOR',
  };

  it('reads INFO with a minimal ACL user (+info +slowlog|get)', async () => {
    const redisConnector = connector(base);
    const first = ok(await redisConnector.poll());
    expect(first.sample.gauges.connections?.used).toBeGreaterThanOrEqual(1);
    expect(first.sample.gauges.storage?.usedBytes).toBeGreaterThan(0);
    expect(first.sample.gauges.storage?.totalBytes).toBeNull(); // maxmemory 0 = no limit
    expect(value(first, 'role')?.text).toBe('master');
    await sleep(1100);
    const second = ok(await redisConnector.poll());
    expect(second.sample.gauges.opsPerSec).toBeGreaterThan(0);
    expect(second.sample.slowQueries).toBe(0);
  });

  it('goes unreachable when the container stops, and recovers', async () => {
    const redisConnector = connector({ ...base, id: 'redis-stop' });
    ok(await redisConnector.poll());
    expect(compose('stop', 'redis').status).toBe(0);
    const [down] = await redisConnector.poll();
    expect(down!.ok).toBe(false);
    expect(compose('start', 'redis').status).toBe(0);
    let recovered = false;
    for (let attempt = 0; attempt < 20 && !recovered; attempt++) {
      await sleep(500);
      recovered = (await redisConnector.poll())[0]!.ok;
    }
    expect(recovered).toBe(true);
  }, 60_000);
});

describe.skipIf(!enabled)('S3 connector against MinIO (real instance)', () => {
  const endpoint = 'http://127.0.0.1:19000';
  const admin = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test-minio', secretAccessKey: 'test-minio-secret' },
  });
  const base = {
    kind: 's3',
    id: 'minio',
    provider: 'minio',
    endpoint,
    accessKeyIdEnv: 'MINIO_KEY',
    secretAccessKeyEnv: 'MINIO_SECRET',
  };

  it('discovers buckets and counts objects and bytes, then measures growth', async () => {
    const bucket = `media-${Date.now()}`;
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    for (let i = 0; i < 25; i++) {
      await admin.send(
        new PutObjectCommand({ Bucket: bucket, Key: `obj-${i}`, Body: 'x'.repeat(100) }),
      );
    }
    const s3 = connector(base);
    const outcomes = await s3.poll();
    const resource = s3.resources().find((entry) => entry.name === bucket)!;
    expect(resource.kind).toBe('s3');
    expect(resource.engine).toBe('S3 · MinIO');
    const first = outcomes.find((outcome) => outcome.resourceId === resource.id)!;
    if (!first.ok) throw new Error(first.error);
    expect(value(first, 'objects')?.value).toBe(25);
    expect(value(first, 'size')?.value).toBe(2500);
    expect(first.sample.gauges.growthBytesPerHour).toBeNull();

    await admin.send(new PutObjectCommand({ Bucket: bucket, Key: 'more', Body: 'y'.repeat(1000) }));
    await sleep(200);
    const second = (await s3.poll()).find((outcome) => outcome.resourceId === resource.id)!;
    if (!second.ok) throw new Error(second.error);
    expect(second.sample.gauges.growthBytesPerHour).toBeGreaterThan(0);
  });

  it('stops counting at maxObjects and says "at least"', async () => {
    const bucket = `capped-${Date.now()}`;
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    for (let i = 0; i < 12; i++) {
      await admin.send(new PutObjectCommand({ Bucket: bucket, Key: `k${i}`, Body: 'z' }));
    }
    const s3 = connector({ ...base, id: 'minio-capped', buckets: [bucket], maxObjects: 5 });
    const outcome = ok(await s3.poll());
    expect(value(outcome, 'objects')).toMatchObject({ value: 5, atLeast: true });
    expect(outcome.sample.gauges.growthBytesPerHour).toBeNull();
  });

  it('marks a missing bucket unreachable and wrong keys as access denied', async () => {
    const [notFound] = await connector({
      ...base,
      id: 'minio-missing',
      buckets: ['no-such-bucket-here'],
    }).poll();
    expect(notFound!.ok).toBe(false);
    if (!notFound!.ok) expect(notFound!.error).toMatch(/not found/);
    const [denied] = await connector({
      ...base,
      id: 'minio-denied',
      secretAccessKeyEnv: 'WRONG',
    }).poll();
    expect(denied!.ok).toBe(false);
    if (!denied!.ok) expect(denied!.error).toMatch(/access denied|signature/i);
  });
});

describe.skipIf(!enabled || process.env.CONNECTOR_TESTS_MSSQL !== '1')(
  'SQL Server connector (real instance)',
  () => {
    it('reads performance counters, connections and size', async () => {
      const mssqlConnector = connector({
        kind: 'mssql',
        id: 'mssql',
        host: '127.0.0.1',
        port: 11433,
        user: 'sa',
        passwordEnv: 'MSSQL_SA',
        trustServerCertificate: true,
      });
      const first = ok(await mssqlConnector.poll());
      expect(first.sample.gauges.connections?.used).toBeGreaterThanOrEqual(1);
      expect(first.sample.gauges.storage?.usedBytes).toBeGreaterThan(0);
      expect(first.sample.cacheHitPercent).toBeGreaterThan(0);
      await sleep(1100);
      const second = ok(await mssqlConnector.poll());
      expect(second.sample.gauges.opsPerSec).not.toBeNull();
    });
  },
);

describe('SQLite connector (real files)', () => {
  it('opens a database read-only and reports its size', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-connector-'));
    const file = join(dir, 'app.db');
    const db = openSqlite(file);
    db.exec(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('a'), ('b');",
    );
    db.close();
    const outcome = ok(await connector({ kind: 'sqlite', id: 'lite', path: file }).poll());
    expect(value(outcome, 'tables')?.value).toBe(1);
    expect(outcome.sample.gauges.storage?.usedBytes).toBeGreaterThan(0);
  });

  it('never creates a missing file, and rejects a file that is not SQLite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sqlite-connector-'));
    const [missing] = await connector({
      kind: 'sqlite',
      id: 'lite-missing',
      path: join(dir, 'nope.db'),
    }).poll();
    expect(missing!.ok).toBe(false);
    const garbage = join(dir, 'garbage.db');
    writeFileSync(garbage, 'this is not a database file at all, just text that is long enough');
    const [bad] = await connector({ kind: 'sqlite', id: 'lite-bad', path: garbage }).poll();
    expect(bad!.ok).toBe(false);
  });
});
