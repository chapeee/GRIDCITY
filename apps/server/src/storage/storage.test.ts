import { createUnknownHostState, type HostState } from '@app/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from './audit-log';
import { openDatabase, type AppDatabase } from './database';
import { LayoutStore } from './layout-store';
import { SampleHistory } from './sample-history';

let db: AppDatabase;
beforeEach(() => {
  db = openDatabase(':memory:');
});
afterEach(() => db.close());

describe('database', () => {
  it('runs migrations once and records the schema version', () => {
    expect(db.pragma('user_version', { simple: true })).toBe(1);
  });
});

describe('AuditLog', () => {
  it('appends entries and returns them newest first', () => {
    let now = 1000;
    const log = new AuditLog(db, () => now++);
    log.append('server_started');
    log.append('connection_opened', 'web-01');
    expect(log.recent()).toMatchObject([
      { kind: 'connection_opened', hostId: 'web-01', at: 1001 },
      { kind: 'server_started', hostId: null, at: 1000 },
    ]);
  });

  it('is append-only: the database rejects updates and deletes', () => {
    new AuditLog(db).append('server_started');
    expect(() => db.prepare("UPDATE audit_log SET kind = 'x'").run()).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM audit_log').run()).toThrow(/append-only/);
  });
});

describe('LayoutStore', () => {
  it('keeps real and demo slots apart and replaces on save', () => {
    const store = new LayoutStore(db);
    store.save('real', { a: 0, b: 1 });
    store.save('demo', { a: 5 });
    store.save('real', { b: 1 });
    expect(store.load('real')).toEqual({ b: 1 });
    expect(store.load('demo')).toEqual({ a: 5 });
  });
});

describe('SampleHistory', () => {
  const polled = (at: number, cpuPercent: number | null): HostState => ({
    ...createUnknownHostState('web-01'),
    status: 'online',
    lastSeenAt: at,
    cpuPercent,
    memory: { usedBytes: 50, totalBytes: 100 },
    disks: [{ mount: '/', usedBytes: 90, totalBytes: 100 }],
  });

  it('averages polls into buckets, skipping unknown values', () => {
    const history = new SampleHistory(db, { bucketMs: 10_000, retentionMs: 1e9 });
    history.record(polled(1_000, 10));
    history.record(polled(3_000, null)); // unknown CPU must not pull the average down
    history.record(polled(5_000, 30));
    history.record(polled(12_000, 50)); // next bucket: the first one is written
    history.flush(12_000);
    expect(history.query('web-01', 0)).toEqual([
      {
        at: 0,
        cpuPercent: 20,
        memoryPercent: 50,
        networkBytesPerSec: null,
        loadOne: null,
        maxDiskPercent: 90,
      },
      {
        at: 10_000,
        cpuPercent: 50,
        memoryPercent: 50,
        networkBytesPerSec: null,
        loadOne: null,
        maxDiskPercent: 90,
      },
    ]);
  });

  it('ignores re-sent states and offline hosts', () => {
    const history = new SampleHistory(db, { bucketMs: 10_000, retentionMs: 1e9 });
    history.record(polled(1_000, 10));
    history.record(polled(1_000, 99));
    history.record({ ...polled(2_000, 99), status: 'offline' });
    history.flush(2_000);
    expect(history.query('web-01', 0)[0]?.cpuPercent).toBe(10);
  });

  it('deletes rows older than the retention window', () => {
    const history = new SampleHistory(db, { bucketMs: 1000, retentionMs: 5000 });
    history.record(polled(1_000, 10));
    history.flush(100_000);
    expect(history.query('web-01', 0)).toEqual([]);
  });
});
