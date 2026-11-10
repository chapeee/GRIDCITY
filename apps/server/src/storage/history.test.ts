import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { editHostInFile, removeHostFromFile, setFileThresholds } from '../config/hosts-editor';
import { parseHostsYaml } from '../config/hosts-file';
import { downsample } from '../http/manage-routes';
import { AppSettingsStore } from './app-settings';
import { openDatabase } from './database';
import { StatusEvents, toIncidents } from './status-events';

describe('status events → incidents', () => {
  it('records only real transitions and turns them into degraded/offline periods', () => {
    const db = openDatabase(':memory:');
    const events = new StatusEvents(db);
    expect(events.record('web', 'unknown', null, 0)).toBe(false);
    expect(events.record('web', 'online', 'ok', 1000)).toBe(true);
    expect(events.record('web', 'online', 'ok', 2000)).toBe(false);
    events.record('web', 'degraded', 'CPU 97% for 3 polls', 3000);
    events.record('web', 'offline', 'heartbeat lost', 5000);
    events.record('web', 'online', 'ok', 9000);
    events.record('web', 'degraded', 'memory 93%', 12_000);
    expect(events.incidents('web', 0, 20_000)).toEqual([
      {
        targetId: 'web',
        status: 'degraded',
        reason: 'CPU 97% for 3 polls',
        startedAt: 3000,
        endedAt: 5000,
      },
      {
        targetId: 'web',
        status: 'offline',
        reason: 'heartbeat lost',
        startedAt: 5000,
        endedAt: 9000,
      },
      {
        targetId: 'web',
        status: 'degraded',
        reason: 'memory 93%',
        startedAt: 12_000,
        endedAt: null,
      },
    ]);
    // Only incidents overlapping the window.
    expect(events.incidents('web', 10_000, 20_000)).toHaveLength(1);
    // Survives a restart: no duplicate event for the same status.
    expect(new StatusEvents(db).record('web', 'degraded', 'memory 93%', 13_000)).toBe(false);
  });

  it('prunes old events but keeps the newest per target (a long incident keeps its start)', () => {
    const db = openDatabase(':memory:');
    const events = new StatusEvents(db);
    events.record('a', 'online', null, 1);
    events.record('a', 'degraded', 'x', 2);
    events.prune(1_000);
    expect(events.incidents('a', 0, 2_000)).toEqual([
      { targetId: 'a', status: 'degraded', reason: 'x', startedAt: 2, endedAt: null },
    ]);
  });

  it('builds incidents per target in fleet view', () => {
    expect(
      toIncidents([
        { targetId: 'a', at: 1, status: 'offline', reason: null },
        { targetId: 'b', at: 2, status: 'degraded', reason: 'r' },
        { targetId: 'a', at: 3, status: 'online', reason: null },
      ]).map((i) => [i.targetId, i.startedAt, i.endedAt]),
    ).toEqual([
      ['a', 1, 3],
      ['b', 2, null],
    ]);
  });
});

describe('history points', () => {
  it('averages into at most 720 points and leaves missing buckets as gaps', () => {
    const day = 86_400_000;
    const samples = [
      {
        at: 0,
        cpuPercent: 10,
        memoryPercent: 50,
        networkBytesPerSec: null,
        loadOne: 1,
        maxDiskPercent: 40,
      },
      {
        at: 30_000,
        cpuPercent: 30,
        memoryPercent: null,
        networkBytesPerSec: null,
        loadOne: 1,
        maxDiskPercent: 40,
      },
    ];
    const { points, bucketMs } = downsample(samples, 0, 7 * day);
    expect(points.length).toBeLessThanOrEqual(722);
    expect(bucketMs).toBe(840_000);
    expect(points[0]).toMatchObject({
      cpuPercent: 20,
      memoryPercent: 50,
      networkBytesPerSec: null,
    });
    expect(points[1]).toMatchObject({ cpuPercent: null });
  });
});

describe('app settings', () => {
  it('defaults to 7 days of history and validates saves', () => {
    const store = new AppSettingsStore(openDatabase(':memory:'));
    expect(store.load().historyRetentionDays).toBe(7);
    expect(store.save({ historyRetentionDays: 30 }).historyRetentionDays).toBe(30);
    expect(store.load().historyRetentionDays).toBe(30);
    expect(() => store.save({ historyRetentionDays: 400 })).toThrow();
  });
});

describe('editing hosts.yaml', () => {
  const file = () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hosts-edit-')), 'hosts.yaml');
    writeFileSync(
      path,
      `# my servers\nhosts:\n  - id: web-01 # main web\n    name: web-01\n    address: 10.0.0.1\n    user: ops\n    district: Hetzner\n  - id: db-01\n    name: db-01\n    address: 10.0.0.2\n    user: ops\n`,
    );
    return path;
  };

  it('renames, moves district, sets tags and per-host thresholds, keeping comments', async () => {
    const path = file();
    const host = await editHostInFile(path, 'web-01', {
      name: 'Web (main)',
      district: 'Home lab',
      tags: ['web'],
      thresholds: { cpuDegradedPercent: 75 },
    });
    expect(host).toMatchObject({
      id: 'web-01',
      name: 'Web (main)',
      district: 'Home lab',
      tags: ['web'],
      thresholds: { cpuDegradedPercent: 75 },
    });
    const text = readFileSync(path, 'utf8');
    expect(text).toContain('# my servers');
    expect(text).toContain('# main web');
    await editHostInFile(path, 'web-01', { thresholds: null, tags: [] });
    const reparsed = parseHostsYaml(readFileSync(path, 'utf8'));
    expect(reparsed.ok && reparsed.config.hosts[0]).toMatchObject({ tags: [] });
    expect(reparsed.ok && reparsed.config.hosts[0]?.thresholds).toBeUndefined();
  });

  it('refuses unknown hosts and invalid values, and removes hosts', async () => {
    const path = file();
    await expect(editHostInFile(path, 'nope', { name: 'x' })).rejects.toThrow(/no host "nope"/);
    await expect(
      editHostInFile(path, 'web-01', { thresholds: { cpuDegradedPercent: 150 } }),
    ).rejects.toThrow();
    await removeHostFromFile(path, 'db-01');
    const parsed = parseHostsYaml(readFileSync(path, 'utf8'));
    expect(parsed.ok && parsed.config.hosts.map((h) => h.id)).toEqual(['web-01']);
  });

  it('writes file-wide thresholds', async () => {
    const path = file();
    const thresholds = await setFileThresholds(path, { memoryDegradedPercent: 80 });
    expect(thresholds.memoryDegradedPercent).toBe(80);
    expect(thresholds.cpuDegradedPercent).toBe(90);
  });
});
