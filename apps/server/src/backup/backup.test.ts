import { createHash } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it } from 'vitest';
import type { BackupEvent } from '@app/shared';
import { openDatabase } from '../storage/database';
import { AuditLog } from '../storage/audit-log';
import { describeCron, nextCronTime, validateCron } from './cron';
import { BackupEngine, mergeTarget } from './engine';
import { selectExpired } from './retention';
import { shellQuote } from './runner';
import { diffIndex, excludeMatcher, parseFindOutput } from './sources/files';
import { keyspaceDbs } from './sources/nosql';
import { BackupStore } from './store';
import {
  createCompressStream,
  createDecompressStream,
  createDecryptStream,
  createEncryptStream,
  MeterStream,
} from './streams';

const DAY = 86_400_000;

describe('cron', () => {
  it('finds the next daily run', () => {
    const after = new Date(2026, 10, 14, 10, 30).getTime();
    expect(new Date(nextCronTime('0 3 * * *', after)!)).toEqual(new Date(2026, 10, 15, 3, 0));
    expect(new Date(nextCronTime('*/15 * * * *', after)!)).toEqual(new Date(2026, 10, 14, 10, 45));
    expect(new Date(nextCronTime('@weekly', after)!).getDay()).toBe(0);
    expect(new Date(nextCronTime('0 0 1 * *', after)!)).toEqual(new Date(2026, 11, 1, 0, 0));
  });
  it('rejects bad expressions and describes common ones', () => {
    expect(validateCron('61 * * * *')).toMatch(/outside/);
    expect(validateCron('0 3 * *')).toMatch(/5 fields/);
    expect(validateCron('30 2 * * 1-5')).toBeNull();
    expect(describeCron('0 3 * * *')).toBe('Every day at 03:00');
    expect(describeCron('5 * * * *')).toBe('Every hour at :05');
  });
});

describe('retention', () => {
  const now = new Date(2026, 10, 14, 12).getTime();
  const daily = Array.from({ length: 20 }, (_, i) => ({
    id: `r${i}`,
    startedAt: now - i * DAY,
    type: 'full' as const,
    parentRunId: null,
  }));
  it('keeps everything without a policy', () => {
    expect(selectExpired(daily, {}, now)).toEqual([]);
  });
  it('keeps the last N', () => {
    expect(selectExpired(daily, { keepLast: 5 }, now)).toHaveLength(15);
  });
  it('keeps one per day / week', () => {
    const expired = selectExpired(daily, { keepDaily: 7, keepWeekly: 4 }, now);
    expect(expired).not.toContain('r0');
    expect(expired.length).toBeLessThan(20 - 7);
  });
  it('keeps by age and never the newest', () => {
    expect(selectExpired(daily, { maxAgeDays: 10 }, now)).toHaveLength(9);
    expect(selectExpired([daily[19]!], { maxAgeDays: 1 }, now)).toEqual([]);
  });
  it('keeps the chain a kept incremental needs', () => {
    const chain = [
      { id: 'full', startedAt: now - 3 * DAY, type: 'full' as const, parentRunId: null },
      { id: 'i1', startedAt: now - 2 * DAY, type: 'incremental' as const, parentRunId: 'full' },
      { id: 'i2', startedAt: now - DAY, type: 'incremental' as const, parentRunId: 'i1' },
    ];
    expect(selectExpired(chain, { keepLast: 1 }, now)).toEqual([]);
  });
});

describe('streams', () => {
  const roundTrip = async (data: Buffer, passphrase: string, wrong?: string) => {
    const enc = await createEncryptStream(passphrase);
    const gz = createCompressStream('gzip')!;
    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from([data]),
      gz,
      enc.stream,
      new Writable({ write: (c, _e, d) => (chunks.push(c), d()) }),
    );
    const sealed = Buffer.concat(chunks);
    const out: Buffer[] = [];
    await pipeline(
      Readable.from([sealed.subarray(0, 7), sealed.subarray(7, 40), sealed.subarray(40)]),
      createDecryptStream(wrong ?? passphrase),
      createDecompressStream('gzip')!,
      new Writable({ write: (c, _e, d) => (out.push(c), d()) }),
    );
    return { sealed, plain: Buffer.concat(out) };
  };
  it('encrypts and decrypts (any chunking)', async () => {
    const data = Buffer.from('backup '.repeat(10_000));
    const { sealed, plain } = await roundTrip(data, 'correct horse battery');
    expect(sealed.subarray(0, 4).toString()).toBe('GCBK');
    expect(plain.equals(data)).toBe(true);
  });
  it('refuses a wrong passphrase', async () => {
    await expect(roundTrip(Buffer.from('secret data'), 'right one', 'wrong one')).rejects.toThrow(
      /decryption failed/,
    );
  });
  it('detects a changed byte', async () => {
    const enc = await createEncryptStream('pass phrase');
    const chunks: Buffer[] = [];
    await pipeline(
      Readable.from([Buffer.from('important')]),
      enc.stream,
      new Writable({ write: (c, _e, d) => (chunks.push(c), d()) }),
    );
    const sealed = Buffer.concat(chunks);
    sealed[40] = sealed[40]! ^ 1;
    await expect(
      pipeline(
        Readable.from([sealed]),
        createDecryptStream('pass phrase'),
        new Writable({ write: (_c, _e, d) => d() }),
      ),
    ).rejects.toThrow(/decryption failed/);
  });
  it('hashes what passes', async () => {
    const meter = new MeterStream();
    await pipeline(
      Readable.from([Buffer.from('abc')]),
      meter,
      new Writable({ write: (_c, _e, d) => d() }),
    );
    expect(meter.digest()).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(meter.bytes).toBe(3);
  });
});

describe('files helpers', () => {
  it('diffs indexes for incremental backups', () => {
    const base = { 'a.txt': [1, 100, 'f'], 'b.txt': [2, 100, 'f'], dir: [0, 1, 'd'] } as const;
    const current = {
      'a.txt': [1, 100, 'f'],
      'b.txt': [3, 200, 'f'],
      'c.txt': [1, 1, 'f'],
      dir: [0, 5, 'd'],
    } as const;
    expect(diffIndex(current as never, base as never)).toEqual({
      include: ['b.txt', 'c.txt'],
      deleted: [],
    });
    expect(diffIndex({ 'a.txt': [1, 100, 'f'] } as never, base as never).deleted).toEqual([
      'b.txt',
      'dir',
    ]);
    expect(diffIndex(current as never, null).include).toHaveLength(4);
  });
  it('matches excludes on names and paths', () => {
    const excluded = excludeMatcher(['node_modules', '*.log', 'cache/**']);
    expect(excluded('app/node_modules/x.js')).toBe(true);
    expect(excluded('logs/today.log')).toBe(true);
    expect(excluded('cache/a/b')).toBe(true);
    expect(excluded('src/index.ts')).toBe(false);
  });
  it('parses GNU find output', () => {
    const out = 'f\t12\t1700000000.5\tdir/a b.txt\0d\t4096\t1700000000.0\tdir\0';
    expect(parseFindOutput(out)).toEqual({
      'dir/a b.txt': [12, 1700000000500, 'f'],
      dir: [0, 1700000000000, 'd'],
    });
  });
  it('quotes for the shell', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('/srv/app')).toBe('/srv/app');
  });
  it('reads the redis keyspace', () => {
    expect(keyspaceDbs('# Keyspace\r\ndb0:keys=3,expires=0\r\ndb4:keys=10,expires=1\r\n')).toEqual([
      { db: 0, keys: 3 },
      { db: 4, keys: 10 },
    ]);
  });
  it('merges restore targets', () => {
    const original = {
      kind: 'files',
      path: '/a',
      exclude: [],
      tool: { runner: 'local', mode: 'native' },
    } as const;
    expect(
      mergeTarget(original as never, { path: '/b', tool: { runner: 'web-1' } } as never),
    ).toMatchObject({
      kind: 'files',
      path: '/b',
      tool: { runner: 'web-1', mode: 'native' },
    });
  });
});

// ── the engine, end to end, with real files and a local destination ──

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function memoryVault() {
  const map = new Map<string, string>();
  return {
    get: (id: string) => map.get(id),
    has: (id: string) => map.has(id),
    set: (id: string, value: string) => void map.set(id, value),
    delete: (id: string) => void map.delete(id),
    deletePrefix: (prefix: string) => {
      for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
    },
    ids: () => [...map.keys()],
  };
}

async function settle(engine: BackupEngine) {
  for (let i = 0; i < 400 && engine.operations().length > 0; i++)
    await new Promise((r) => setTimeout(r, 25));
}

describe('BackupEngine (files → local destination)', () => {
  it('backs up, takes an incremental, restores the chain and enforces confirmation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gc-backup-'));
    dirs.push(root);
    const source = join(root, 'source');
    const store = join(root, 'store');
    const restoreTo = join(root, 'restored');
    mkdirSync(join(source, 'sub'), { recursive: true });
    writeFileSync(join(source, 'a.txt'), 'alpha');
    writeFileSync(join(source, 'sub', 'b.txt'), 'bravo'.repeat(1000));
    writeFileSync(join(source, 'skip.log'), 'noise');

    const db = openDatabase(':memory:');
    const backupStore = new BackupStore(db);
    const events: BackupEvent[] = [];
    const sent: string[] = [];
    const engine = new BackupEngine({
      store: backupStore,
      vault: memoryVault(),
      audit: new AuditLog(db),
      notifier: { send: (_l, title) => (sent.push(title), ['test']) },
      appVersion: '1.2.0',
      stagingDir: join(root, 'staging'),
      context: { env: {}, homeDir: root, appName: 'test', now: Date.now },
      resources: async () => new Map(),
      connection: () => undefined,
      hostLabel: (id) => id,
      hostExists: () => false,
      emit: (e) => events.push(e),
    });
    await engine.start();
    const destId = engine.saveDestination(null, { kind: 'local', name: 'Disk', path: store });
    const job = await engine.saveJob(null, {
      name: 'Site files',
      source: {
        kind: 'files',
        path: source,
        exclude: ['*.log'],
        tool: { runner: 'local', mode: 'native' },
      },
      destinationIds: [destId],
      schedule: null,
      scheduleEnabled: true,
      strategy: 'incremental',
      fullEvery: 7,
      retention: {},
      compression: 'gzip',
      encrypt: true,
      passphrase: 'a long test passphrase',
      verifyAfterUpload: true,
      notifyOnSuccess: true,
      notifyOnFailure: true,
    });

    const first = await engine.runJob(job.id, 'manual');
    await settle(engine);
    const full = backupStore.run(first)!;
    expect(full.status, full.error ?? '').toBe('success');
    expect(full.type).toBe('full');
    expect(full.targets[0]!.status).toBe('verified');
    expect(full.encrypted).toBe(true);
    const stored = readdirSync(join(store, 'site-files'));
    expect(stored.some((f) => f.endsWith('.tar.gz.enc'))).toBe(true);
    expect(stored.some((f) => f.endsWith('.manifest.json'))).toBe(true);
    expect(events.some((e) => e.type === 'progress' && e.operation.stage === 'uploading')).toBe(
      true,
    );

    // Change one file, add one, delete one: the incremental holds only the changes.
    writeFileSync(join(source, 'a.txt'), 'alpha changed');
    utimesSync(join(source, 'a.txt'), new Date(), new Date(Date.now() + 5000));
    writeFileSync(join(source, 'new.txt'), 'new');
    rmSync(join(source, 'sub', 'b.txt'));
    const second = await engine.runJob(job.id, 'manual');
    await settle(engine);
    const incr = backupStore.run(second)!;
    expect(incr.status, incr.error ?? '').toBe('success');
    expect(incr.type).toBe('incremental');
    expect(incr.parentRunId).toBe(first);
    expect(backupStore.manifest(second)!.deleted).toEqual(['sub/b.txt']);

    const plan = await engine.restorePlan({ runId: second, target: { path: restoreTo } });
    expect(plan.chain.map((c) => c.type)).toEqual(['full', 'incremental']);
    await expect(
      engine.restore({
        runId: second,
        target: { path: restoreTo },
        applyDeletions: true,
        createDatabase: true,
        confirm: 'nope',
      }),
    ).rejects.toThrow(/to confirm/);

    await engine.restore({
      runId: second,
      target: { path: restoreTo },
      applyDeletions: true,
      createDatabase: true,
      confirm: plan.label,
    });
    await settle(engine);
    const restore = backupStore.restores()[0]!;
    expect(restore.status, restore.error ?? '').toBe('success');
    expect(readFileSync(join(restoreTo, 'a.txt'), 'utf8')).toBe('alpha changed');
    expect(readFileSync(join(restoreTo, 'new.txt'), 'utf8')).toBe('new');
    expect(existsSync(join(restoreTo, 'sub', 'b.txt'))).toBe(false); // deletion applied
    expect(existsSync(join(restoreTo, 'skip.log'))).toBe(false); // excluded

    // A damaged copy is refused before anything is restored.
    const file = join(store, 'site-files', full.fileName!);
    const bytes = readFileSync(file);
    bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0xff;
    writeFileSync(file, bytes);
    await engine.verify(first);
    await settle(engine);
    expect(backupStore.run(first)!.targets[0]!.status).toBe('failed');

    expect(sent.some((t) => t.startsWith('Backup succeeded'))).toBe(true);
    expect(sent.some((t) => t.startsWith('Restore completed'))).toBe(true);
    // Retention never ran (no policy) and the files are still there.
    expect(backupStore.usableRuns(job.id)).toHaveLength(2);
    engine.stop();
    db.close();
  }, 60_000);

  it('marks interrupted runs and keeps finished ones after a restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gc-backup-'));
    dirs.push(root);
    const db = openDatabase(':memory:');
    const store = new BackupStore(db);
    store.createRun({
      id: 'run_x',
      jobId: 'job_x',
      jobName: 'X',
      sourceKind: 'files',
      type: 'full',
      trigger: 'manual',
      startedAt: 1,
      parentRunId: null,
    });
    mkdirSync(join(root, 'staging'), { recursive: true });
    writeFileSync(join(root, 'staging', 'run_x.part'), 'partial');
    const engine = new BackupEngine({
      store,
      vault: memoryVault(),
      audit: new AuditLog(db),
      notifier: { send: () => [] },
      appVersion: '1.2.0',
      stagingDir: join(root, 'staging'),
      context: { env: {}, homeDir: root, appName: 't', now: Date.now },
      resources: async () => new Map(),
      connection: () => undefined,
      hostLabel: (i) => i,
      hostExists: () => false,
      emit: () => undefined,
    });
    await engine.start();
    expect(store.run('run_x')!.status).toBe('interrupted');
    expect(existsSync(join(root, 'staging', 'run_x.part'))).toBe(false);
    engine.stop();
    db.close();
  });
});
