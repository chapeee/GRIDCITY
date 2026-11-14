/**
 * Backup & restore against REAL databases, Docker, an SSH server and S3
 * (MinIO). Each test backs something up, restores it somewhere else and
 * checks the restored data. Needs Docker and compose.connectors-test.yaml:
 *
 *   docker compose -f compose.connectors-test.yaml up -d --wait postgres mysql mongo redis minio
 *   BACKUP_TESTS=1 npx vitest run apps/server/src/backup/backup.integration.test.ts
 *
 * The SSH server (alpine + openssh, for SFTP and the files-over-SSH runner)
 * is started and removed by the test itself.
 */
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Redis from 'ioredis';
import { MongoClient } from 'mongodb';
import mysql from 'mysql2/promise';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Host, JobInput, SourceConfig } from '@app/shared';
import { ResourceConfigSchema, type ResourceConfig } from '../config/resources-file';
import { HostConnection } from '../ssh/host-connection';
import { parseKnownHosts } from '../ssh/known-hosts';
import { AuditLog } from '../storage/audit-log';
import { openDatabase } from '../storage/database';
import { openSqlite } from '../storage/sqlite';
import { BackupEngine } from './engine';
import { BackupStore } from './store';

const enabled = process.env.BACKUP_TESTS === '1';
const env = {
  PG_ROOT: 'test-root',
  MYSQL_ROOT: 'test-root',
  MONGO_ROOT: 'test-root',
  REDIS_ROOT: 'test-root',
  MINIO_KEY: 'test-minio',
  MINIO_SECRET: 'test-minio-secret',
};
const SSH_PORT = 12222;
const SSH_NAME = 'gridcity-backup-it-ssh';

const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

function vault() {
  const map = new Map<string, string>();
  return {
    get: (id: string) => map.get(id),
    has: (id: string) => map.has(id),
    set: (id: string, v: string) => void map.set(id, v),
    delete: (id: string) => void map.delete(id),
    deletePrefix: () => undefined,
    ids: () => [...map.keys()],
  };
}

const resourceList: ResourceConfig[] = [
  {
    kind: 'postgres',
    id: 'pg',
    host: '127.0.0.1',
    port: 15432,
    user: 'postgres',
    passwordEnv: 'PG_ROOT',
    database: 'postgres',
  },
  {
    kind: 'mysql',
    id: 'my',
    host: '127.0.0.1',
    port: 13306,
    user: 'root',
    passwordEnv: 'MYSQL_ROOT',
    database: 'shop',
  },
  {
    kind: 'mongodb',
    id: 'mongo',
    url: 'mongodb://root@127.0.0.1:27018/?authSource=admin',
    passwordEnv: 'MONGO_ROOT',
  },
  { kind: 'redis', id: 'redis', host: '127.0.0.1', port: 16379, passwordEnv: 'REDIS_ROOT' },
  {
    kind: 's3',
    id: 'minio',
    provider: 'minio',
    endpoint: 'http://127.0.0.1:19000',
    region: 'us-east-1',
    accessKeyIdEnv: 'MINIO_KEY',
    secretAccessKeyEnv: 'MINIO_SECRET',
    buckets: ['gc-backups'],
  },
].map((raw) => ResourceConfigSchema.parse(raw));
const resources = new Map(resourceList.map((r) => [r.id, r]));

describe.skipIf(!enabled)('backup & restore against real services', () => {
  let root: string;
  let db: ReturnType<typeof openDatabase>;
  let store: BackupStore;
  let engine: BackupEngine;
  let ssh: HostConnection | null = null;
  const destinations: Record<string, string> = {};

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gc-backup-it-'));
    // SSH server with GNU tar/find and sqlite3, key login only.
    spawnSync('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', join(root, 'key')]);
    const pub = readFileSync(join(root, 'key.pub'), 'utf8').trim();
    docker('rm', '-f', SSH_NAME);
    const script = [
      'apk add --no-cache openssh tar findutils coreutils sqlite >/dev/null',
      'ssh-keygen -A >/dev/null',
      'adduser -D ops && passwd -d ops >/dev/null',
      'mkdir -p /home/ops/.ssh /home/ops/site/sub /srv/backups && chown ops /srv/backups',
      'echo "$PUBKEY" > /home/ops/.ssh/authorized_keys',
      'echo hello > /home/ops/site/index.html && echo deep > /home/ops/site/sub/a.txt',
      'sqlite3 /home/ops/app.db "create table t(x); insert into t values (1),(2),(3);"',
      'chown -R ops /home/ops && chmod 700 /home/ops/.ssh && chmod 600 /home/ops/.ssh/authorized_keys',
      'exec /usr/sbin/sshd -D -e',
    ].join(' && ');
    const run = docker(
      'run',
      '-d',
      '--name',
      SSH_NAME,
      '-p',
      `127.0.0.1:${SSH_PORT}:22`,
      '-e',
      `PUBKEY=${pub}`,
      'alpine:3.20',
      'sh',
      '-c',
      script,
    );
    expect(run.status, run.stderr).toBe(0);
    let keyscan = '';
    for (let i = 0; i < 60 && !keyscan.includes('ssh-ed25519'); i++) {
      await new Promise((r) => setTimeout(r, 1000));
      keyscan = spawnSync('ssh-keyscan', ['-p', String(SSH_PORT), '-t', 'ed25519', '127.0.0.1'], {
        encoding: 'utf8',
      }).stdout;
    }
    const host: Host = {
      id: 'box',
      name: 'box',
      address: '127.0.0.1',
      port: SSH_PORT,
      user: 'ops',
      tags: [],
      district: 'test',
      auth: { method: 'keyFile', path: join(root, 'key') },
    } as unknown as Host;
    const privateKey = readFileSync(join(root, 'key'));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ssh did not connect')), 30_000);
      ssh = new HostConnection({
        host,
        loadKnownHosts: () => parseKnownHosts(keyscan),
        buildAuth: async () => ({ privateKey }) as never,
        onPhaseChange: (change) => {
          if (change.phase === 'connected') {
            clearTimeout(timer);
            resolve();
          }
        },
      });
      ssh.start();
    });

    const s3 = new S3Client({
      endpoint: 'http://127.0.0.1:19000',
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId: env.MINIO_KEY, secretAccessKey: env.MINIO_SECRET },
    });
    await s3.send(new CreateBucketCommand({ Bucket: 'gc-backups' })).catch(() => undefined);
    s3.destroy();

    db = openDatabase(':memory:');
    store = new BackupStore(db);
    engine = new BackupEngine({
      store,
      vault: vault(),
      audit: new AuditLog(db),
      notifier: { send: () => [] },
      appVersion: '1.2.0',
      stagingDir: join(root, 'staging'),
      context: { env, homeDir: root, appName: 'gridcity-backup-it', now: Date.now },
      resources: async () => resources,
      connection: (id) => (id === 'box' && ssh?.phase === 'connected' ? ssh : undefined),
      hostLabel: (id) => id,
      hostExists: (id) => id === 'box',
      emit: () => undefined,
    });
    await engine.start();
    destinations.local = engine.saveDestination(null, {
      kind: 'local',
      name: 'Local',
      path: join(root, 'store'),
    });
    destinations.s3 = engine.saveDestination(null, {
      kind: 's3',
      name: 'MinIO',
      resourceId: 'minio',
      bucket: 'gc-backups',
      prefix: 'it',
    });
    destinations.sftp = engine.saveDestination(null, {
      kind: 'sftp',
      name: 'SFTP box',
      hostId: 'box',
      path: '/srv/backups',
    });
  }, 240_000);

  afterAll(() => {
    engine?.stop();
    ssh?.stop();
    db?.close();
    docker('rm', '-f', SSH_NAME);
    docker('volume', 'rm', '-f', 'gc-it-vol', 'gc-it-vol-restored');
    if (root) rmSync(root, { recursive: true, force: true });
  });

  async function settle() {
    for (let i = 0; i < 2400 && engine.operations().length > 0; i++)
      await new Promise((r) => setTimeout(r, 50));
  }

  async function backupAndRestore(
    name: string,
    source: SourceConfig,
    target: Partial<SourceConfig>,
    extra: Partial<JobInput> = {},
  ) {
    const job = await engine.saveJob(null, {
      name,
      source,
      destinationIds: [destinations.local!, destinations.s3!, destinations.sftp!],
      schedule: null,
      scheduleEnabled: true,
      strategy: 'full',
      fullEvery: 7,
      retention: {},
      compression: 'zstd',
      encrypt: true,
      passphrase: 'integration passphrase',
      verifyAfterUpload: true,
      notifyOnSuccess: false,
      notifyOnFailure: false,
      ...extra,
    });
    const runId = await engine.runJob(job.id, 'manual');
    await settle();
    const run = store.run(runId)!;
    const logs = store
      .logs(runId)
      .map((l) => l.message)
      .join('\n');
    expect(run.status, `${run.error}\n${logs}`).toBe('success');
    expect(run.targets.map((t) => t.status)).toEqual(['verified', 'verified', 'verified']);
    const plan = await engine.restorePlan({ runId, target });
    expect(plan.problems).toEqual([]);
    // Restore from the S3 copy (proves download from a remote destination).
    await engine.restore({
      runId,
      target,
      confirm: plan.label,
      applyDeletions: false,
      createDatabase: true,
      destinationId: destinations.s3,
    });
    await settle();
    const restore = store.restores()[0]!;
    expect(
      restore.status,
      `${restore.error}\n${store
        .logs(restore.id)
        .map((l) => l.message)
        .join('\n')}`,
    ).toBe('success');
    return { run, restore, logs: store.logs(restore.id).map((l) => l.message) };
  }

  it('PostgreSQL: pg_dump in a temporary container → pg_restore into a new database', async () => {
    const { logs } = await backupAndRestore(
      'pg',
      {
        kind: 'postgres',
        resourceId: 'pg',
        exclude: [],
        tool: { runner: 'local', mode: 'docker-image', image: 'postgres:17-alpine' },
      },
      { database: 'restored_pg' },
    );
    const client = new pg.Client({
      host: '127.0.0.1',
      port: 15432,
      user: 'postgres',
      password: env.PG_ROOT,
      database: 'restored_pg',
    });
    await client.connect();
    const r = await client.query('SELECT count(*)::int AS n FROM demo_items');
    await client.end();
    expect(r.rows[0].n).toBe(1000);
    expect(logs.some((l) => /Check after restore: \d+ tables/.test(l))).toBe(true);
  }, 300_000);

  it('MySQL: mysqldump → restore under another name', async () => {
    await backupAndRestore(
      'mysql',
      {
        kind: 'mysql',
        resourceId: 'my',
        exclude: [],
        tool: { runner: 'local', mode: 'docker-image', image: 'mysql:8.4' },
      },
      { database: 'shop_restored' },
    );
    const conn = await mysql.createConnection({
      host: '127.0.0.1',
      port: 13306,
      user: 'root',
      password: env.MYSQL_ROOT,
    });
    const [rows] = await conn.query('SELECT name FROM shop_restored.items ORDER BY id');
    await conn.end();
    expect((rows as { name: string }[]).map((r) => r.name)).toEqual(['a', 'b', 'c']);
  }, 300_000);

  it('MongoDB: driver backup and mongodump archive, both restored under another name', async () => {
    await backupAndRestore(
      'mongo-driver',
      {
        kind: 'mongodb',
        resourceId: 'mongo',
        database: 'events',
        exclude: [],
        tool: { runner: 'local', mode: 'driver' },
      },
      { database: 'events_driver' },
    );
    await backupAndRestore(
      'mongo-tool',
      {
        kind: 'mongodb',
        resourceId: 'mongo',
        database: 'events',
        exclude: [],
        tool: { runner: 'local', mode: 'docker-image', image: 'mongo:8.0' },
      },
      { database: 'events_tool' },
    );
    const client = new MongoClient('mongodb://root:test-root@127.0.0.1:27018/?authSource=admin');
    await client.connect();
    const a = await client
      .db('events_driver')
      .collection('items')
      .find({}, { projection: { _id: 0 } })
      .sort({ n: 1 })
      .toArray();
    const b = await client.db('events_tool').collection('items').countDocuments();
    await client.close();
    expect(a).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(b).toBe(3);
  }, 300_000);

  it('Redis: DUMP records restored after the keys are gone (binary values and TTLs kept)', async () => {
    const redis = new Redis({ host: '127.0.0.1', port: 16379, password: env.REDIS_ROOT });
    await redis.select(3);
    await redis.flushdb();
    await redis.set('greeting', 'hello');
    await redis.set(Buffer.from([0xff, 0x00, 0x01]), Buffer.from([1, 2, 3, 255]));
    await redis.hset('user:1', { name: 'Ada', role: 'admin' });
    await redis.set('session', 'x', 'EX', 3600);
    const job = await engine.saveJob(null, {
      name: 'redis',
      source: {
        kind: 'redis',
        resourceId: 'redis',
        exclude: [],
        tool: { runner: 'local', mode: 'driver' },
      },
      destinationIds: [destinations.local!],
      schedule: null,
      scheduleEnabled: true,
      strategy: 'full',
      fullEvery: 7,
      retention: {},
      compression: 'gzip',
      encrypt: false,
      verifyAfterUpload: true,
      notifyOnSuccess: false,
      notifyOnFailure: false,
    });
    const runId = await engine.runJob(job.id, 'manual');
    await settle();
    expect(store.run(runId)!.status, store.run(runId)!.error ?? '').toBe('success');
    await redis.flushdb();
    const plan = await engine.restorePlan({ runId, target: {} });
    await engine.restore({
      runId,
      target: {},
      confirm: plan.label,
      applyDeletions: false,
      createDatabase: true,
    });
    await settle();
    expect(store.restores()[0]!.status, store.restores()[0]!.error ?? '').toBe('success');
    await redis.select(3);
    expect(await redis.get('greeting')).toBe('hello');
    expect(
      (await redis.getBuffer(Buffer.from([0xff, 0x00, 0x01])))?.equals(Buffer.from([1, 2, 3, 255])),
    ).toBe(true);
    expect(await redis.hgetall('user:1')).toEqual({ name: 'Ada', role: 'admin' });
    expect(await redis.ttl('session')).toBeGreaterThan(3000);
    redis.disconnect();
  }, 120_000);

  it('SQLite: local VACUUM INTO snapshot, restored with the old file kept', async () => {
    const file = join(root, 'app.sqlite');
    const sqlite = openSqlite(file);
    sqlite.exec("CREATE TABLE notes (t TEXT); INSERT INTO notes VALUES ('one'), ('two');");
    sqlite.close();
    const restored = join(root, 'restored', 'app.sqlite');
    mkdirSync(join(root, 'restored'), { recursive: true });
    writeFileSync(restored, 'old content');
    await backupAndRestore(
      'sqlite',
      { kind: 'sqlite', path: file, exclude: [], tool: { runner: 'local', mode: 'driver' } },
      { path: restored },
    );
    const check = openSqlite(restored, { readonly: true });
    expect((check.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n).toBe(2);
    check.close();
  }, 120_000);

  it('SQLite on a server: sqlite3 .backup over SSH, restored into another path there', async () => {
    await backupAndRestore(
      'remote sqlite',
      {
        kind: 'sqlite',
        path: '/home/ops/app.db',
        exclude: [],
        tool: { runner: 'box', mode: 'native' },
      },
      { path: '/home/ops/restored/app.db' },
    );
    const out = docker(
      'exec',
      SSH_NAME,
      'sqlite3',
      '/home/ops/restored/app.db',
      'select count(*) from t',
    );
    expect(out.stdout.trim()).toBe('3');
  }, 120_000);

  it('Docker volume: archived with a helper container, restored into a new volume', async () => {
    docker('volume', 'rm', '-f', 'gc-it-vol', 'gc-it-vol-restored');
    docker('volume', 'create', 'gc-it-vol');
    const seed = docker(
      'run',
      '--rm',
      '-v',
      'gc-it-vol:/data',
      'alpine:3.20',
      'sh',
      '-c',
      'echo volume-data > /data/file.txt && mkdir -p /data/d && echo x > /data/d/y',
    );
    expect(seed.status, seed.stderr).toBe(0);
    await backupAndRestore(
      'volume',
      {
        kind: 'docker-volume',
        dockerName: 'gc-it-vol',
        exclude: [],
        tool: { runner: 'local', mode: 'native' },
      },
      { dockerName: 'gc-it-vol-restored' },
    );
    const read = docker(
      'run',
      '--rm',
      '-v',
      'gc-it-vol-restored:/data:ro',
      'alpine:3.20',
      'cat',
      '/data/file.txt',
      '/data/d/y',
    );
    expect(read.stdout).toBe('volume-data\nx\n');
  }, 300_000);

  it.skipIf(!process.env.BACKUP_TESTS_MSSQL)(
    'SQL Server: full + differential (BACKUP DATABASE in its container), chain restored under another name',
    async () => {
      const config = ResourceConfigSchema.parse({
        kind: 'mssql',
        id: 'erp',
        host: '127.0.0.1',
        port: 11433,
        user: 'sa',
        passwordEnv: 'MSSQL_SA',
        database: 'master',
        trustServerCertificate: true,
      });
      resources.set('erp', config);
      (env as Record<string, string>).MSSQL_SA = 'Test-root-1234';
      const mssql = (await import('mssql')).default;
      const pool = await new mssql.ConnectionPool({
        server: '127.0.0.1',
        port: 11433,
        user: 'sa',
        password: 'Test-root-1234',
        database: 'master',
        options: { trustServerCertificate: true },
      }).connect();
      await pool
        .request()
        .batch(
          "IF DB_ID('erp_it') IS NOT NULL BEGIN ALTER DATABASE erp_it SET SINGLE_USER WITH ROLLBACK IMMEDIATE; DROP DATABASE erp_it; END; CREATE DATABASE erp_it;",
        );
      await pool
        .request()
        .batch('USE erp_it; CREATE TABLE orders (id INT); INSERT INTO orders VALUES (1),(2);');
      const job = await engine.saveJob(null, {
        name: 'erp',
        source: {
          kind: 'mssql',
          resourceId: 'erp',
          database: 'erp_it',
          exclude: [],
          tool: { runner: 'local', mode: 'docker-exec', container: 'connectors-test-mssql-1' },
        },
        destinationIds: [destinations.local!],
        schedule: null,
        scheduleEnabled: true,
        strategy: 'differential',
        fullEvery: 7,
        retention: {},
        compression: 'gzip',
        encrypt: false,
        verifyAfterUpload: true,
        notifyOnSuccess: false,
        notifyOnFailure: false,
      });
      const full = await engine.runJob(job.id, 'manual');
      await settle();
      expect(store.run(full)!.status, `${store.run(full)!.error}`).toBe('success');
      await pool.request().batch('USE erp_it; INSERT INTO orders VALUES (3);');
      const diff = await engine.runJob(job.id, 'manual');
      await settle();
      const diffRun = store.run(diff)!;
      expect(diffRun.status, `${diffRun.error}`).toBe('success');
      expect(diffRun.type).toBe('differential');
      const target = { database: 'erp_restored' };
      const plan = await engine.restorePlan({ runId: diff, target });
      expect(plan.chain.map((c) => c.type)).toEqual(['full', 'differential']);
      await engine.restore({
        runId: diff,
        target,
        confirm: plan.label,
        applyDeletions: false,
        createDatabase: true,
      });
      await settle();
      const restore = store.restores()[0]!;
      expect(
        restore.status,
        `${restore.error}\n${store
          .logs(restore.id)
          .map((l) => l.message)
          .join('\n')}`,
      ).toBe('success');
      const rows = await pool
        .request()
        .query<{ n: number }>('SELECT COUNT(*) AS n FROM erp_restored.dbo.orders');
      expect(rows.recordset[0]!.n).toBe(3);
      await pool.close();
    },
    300_000,
  );

  it.skipIf(!process.env.BACKUP_TESTS_FIREBIRD)(
    'Firebird: gbak inside its container → restored into a new database file',
    async () => {
      const job = await engine.saveJob(null, {
        name: 'firebird',
        source: {
          kind: 'firebird',
          path: '/var/lib/firebird/data/app.fdb',
          host: '127.0.0.1',
          user: 'SYSDBA',
          exclude: [],
          tool: { runner: 'local', mode: 'docker-exec', container: 'gc-it-firebird' },
        },
        sourcePassword: 'test-root',
        destinationIds: [destinations.local!, destinations.sftp!],
        schedule: null,
        scheduleEnabled: true,
        strategy: 'full',
        fullEvery: 7,
        retention: {},
        compression: 'gzip',
        encrypt: true,
        passphrase: 'firebird passphrase',
        verifyAfterUpload: true,
        notifyOnSuccess: false,
        notifyOnFailure: false,
      });
      const runId = await engine.runJob(job.id, 'manual');
      await settle();
      expect(
        store.run(runId)!.status,
        `${store.run(runId)!.error}\n${store
          .logs(runId)
          .map((l) => l.message)
          .join('\n')}`,
      ).toBe('success');
      const target = { path: '/var/lib/firebird/data/restored.fdb' };
      const plan = await engine.restorePlan({ runId, target });
      await engine.restore({
        runId,
        target,
        confirm: plan.label,
        applyDeletions: false,
        createDatabase: true,
      });
      await settle();
      const restore = store.restores()[0]!;
      expect(
        restore.status,
        `${restore.error}\n${store
          .logs(restore.id)
          .map((l) => l.message)
          .join('\n')}`,
      ).toBe('success');
      const out = docker(
        'exec',
        'gc-it-firebird',
        'sh',
        '-c',
        'echo "select count(*) from items;" | /opt/firebird/bin/isql -user SYSDBA -password test-root 127.0.0.1:/var/lib/firebird/data/restored.fdb',
      );
      expect(out.stdout).toMatch(/\b2\b/);
    },
    300_000,
  );

  it('Files over SSH: full + incremental with GNU tar, chain restored on this machine', async () => {
    const job = await engine.saveJob(null, {
      name: 'site',
      source: {
        kind: 'files',
        path: '/home/ops/site',
        exclude: [],
        tool: { runner: 'box', mode: 'native' },
      },
      destinationIds: [destinations.sftp!, destinations.s3!],
      schedule: null,
      scheduleEnabled: true,
      strategy: 'incremental',
      fullEvery: 7,
      retention: { keepLast: 5 },
      compression: 'gzip',
      encrypt: false,
      verifyAfterUpload: true,
      notifyOnSuccess: false,
      notifyOnFailure: false,
    });
    const first = await engine.runJob(job.id, 'manual');
    await settle();
    expect(store.run(first)!.status, store.run(first)!.error ?? '').toBe('success');
    docker(
      'exec',
      '-u',
      'ops',
      SSH_NAME,
      'sh',
      '-c',
      'sleep 1; echo changed > /home/ops/site/index.html; echo new > /home/ops/site/new.txt; rm /home/ops/site/sub/a.txt',
    );
    const second = await engine.runJob(job.id, 'manual');
    await settle();
    const incr = store.run(second)!;
    expect(incr.status, incr.error ?? '').toBe('success');
    expect(incr.type).toBe('incremental');
    expect(store.manifest(second)!.deleted).toEqual(['sub/a.txt']);
    const target = join(root, 'site-restored');
    const t = { path: target, tool: { runner: 'local' } } as Partial<SourceConfig>;
    const plan = await engine.restorePlan({ runId: second, target: t as never });
    await engine.restore({
      runId: second,
      target: t as never,
      confirm: plan.label,
      applyDeletions: true,
      createDatabase: false,
      destinationId: destinations.sftp,
    });
    await settle();
    expect(store.restores()[0]!.status, store.restores()[0]!.error ?? '').toBe('success');
    expect(readFileSync(join(target, 'index.html'), 'utf8')).toBe('changed\n');
    expect(readFileSync(join(target, 'new.txt'), 'utf8')).toBe('new\n');
    expect(existsSync(join(target, 'sub', 'a.txt'))).toBe(false);
    // The uploads really are on the SFTP server.
    const listing = docker('exec', SSH_NAME, 'sh', '-c', 'ls /srv/backups/site');
    expect(listing.stdout.split('\n').filter((f) => f.endsWith('.tar.gz')).length).toBe(2);
  }, 300_000);
});
