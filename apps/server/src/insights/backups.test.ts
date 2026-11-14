import { describe, expect, it } from 'vitest';
import type { ResourceConfig } from '../config/resources-file';
import {
  createBackupProducer,
  newestFileScript,
  parseNewestFile,
  validateBackup,
  type BackupExpectation,
} from './backups';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const HOUR = 3_600_000;
const host = {
  id: 'db',
  name: 'db-1',
  address: 'h',
  port: 22,
  user: 'u',
  district: 'D',
  tags: [],
  auth: { method: 'agent' as const },
};
const context = { env: {}, homeDir: '/', appName: 't', now: () => NOW };
const expectation = (over: Partial<BackupExpectation> = {}): BackupExpectation => ({
  id: 'bk-1',
  name: 'nightly dump',
  targetId: 'db',
  kind: 'file',
  path: '/var/backups/db-*.sql.gz',
  maxAgeHours: 26,
  minBytes: 1000,
  ...over,
});

async function run(stdout: string) {
  const producer = createBackupProducer({
    load: () => [expectation()],
    hosts: () => [host],
    resources: () => [],
    configs: async () => new Map(),
    runnerFor: () => ({ exec: async () => ({ stdout }) }),
    context,
  });
  return (await producer.run(NOW))[0]!;
}

describe('backup checks', () => {
  it('accepts only plain absolute paths', () => {
    expect(validateBackup({ ...expectation(), path: '/var/backups/db-*.sql.gz' })).toEqual([]);
    expect(validateBackup({ ...expectation(), path: '/tmp/$(reboot)' })).toHaveLength(1);
    expect(validateBackup({ ...expectation(), path: 'relative/path' })).toHaveLength(1);
    expect(newestFileScript('/var/backups/*.gz')).toContain("stat -c '%Y %s %n' /var/backups/*.gz");
  });

  it('reads the newest file and judges age and size', async () => {
    expect(parseNewestFile('@@end')).toBeNull();
    expect(parseNewestFile('')).toBe('failed');

    const fresh = await run(`${(NOW - 3 * HOUR) / 1000} 52428800 /var/backups/db-1.sql.gz\n@@end`);
    expect(fresh.drafts).toEqual([]);
    expect(fresh.upcoming![0]).toMatchObject({ status: 'ok', at: NOW - 3 * HOUR + 26 * HOUR });

    const late = await run(`${(NOW - 40 * HOUR) / 1000} 52428800 /var/backups/db-0.sql.gz\n@@end`);
    expect(late.drafts[0]).toMatchObject({
      severity: 'medium',
      title: 'Backup "nightly dump" is late: last one 40 h ago',
    });

    const tiny = await run(`${(NOW - HOUR) / 1000} 20 /var/backups/db-2.sql.gz\n@@end`);
    expect(tiny.drafts[0]!.title).toBe('Backup "nightly dump" is too small (20 B)');
    // A truncated dump needs attention now, and the calendar says why.
    expect(tiny.upcoming![0]).toMatchObject({ status: 'urgent' });
    expect(tiny.upcoming![0]!.detail).toMatch(/^too small/);

    const none = await run('@@end');
    expect(none.drafts[0]).toMatchObject({
      severity: 'high',
      title: 'Backup "nightly dump" is missing',
    });
    expect(none.checkedScopes).toEqual(['backup:bk-1']);
  });

  it('checks a bucket prefix', async () => {
    const producer = createBackupProducer({
      load: () => [expectation({ kind: 's3', targetId: 'media-b', path: 'nightly/' })],
      hosts: () => [],
      resources: () => [
        {
          id: 'media-b',
          name: 'backups',
          kind: 's3',
          engine: 'S3',
          district: 'D',
          tags: [],
          target: 't',
          sourceId: 'media',
        },
      ],
      configs: async () =>
        new Map([['media', { kind: 's3', id: 'media' } as unknown as ResourceConfig]]),
      runnerFor: () => undefined,
      context,
      newestObject: async (_config, bucket, prefix) => ({
        at: NOW - HOUR,
        bytes: 5000,
        name: `${bucket}/${prefix}x.tar`,
      }),
    });
    const [result] = await producer.run(NOW);
    expect(result!.drafts).toEqual([]);
    expect(result!.upcoming![0]!.detail).toContain('backups/nightly/x.tar');
  });
});
