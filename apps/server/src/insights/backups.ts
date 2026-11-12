import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { Host, Resource } from '@app/shared';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ResourceConfig, ResourceConfigOf } from '../config/resources-file';
import type { ConnectorContext } from '../connectors/connector';
import { clientConfig } from '../connectors/s3';
import type { InsightProducer, ProducerResult, SweepRunner } from '../threats/threat-hub';
import { insightDraft } from './expiry';

const HOUR = 3_600_000;
const CONFIG_KEY = 'backups:expected';

/** A backup GRIDCITY should see: a file pattern on a server, or a prefix in a bucket. */
export const BackupExpectationSchema = z.strictObject({
  id: z.string().min(1).max(40).optional(),
  name: z.string().trim().min(1).max(80),
  /** A server (file) or a bucket resource (object prefix). */
  targetId: z.string().min(1).max(200),
  kind: z.enum(['file', 's3']),
  /**
   * file: an absolute path, wildcards allowed ("/var/backups/db-*.sql.gz").
   * s3: an object prefix ("nightly/").
   */
  path: z.string().trim().max(300),
  /** The newest backup may be at most this old. */
  maxAgeHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  /** …and at least this big (a 0-byte dump is a failed dump). */
  minBytes: z.number().int().min(0).max(1e15).default(1),
});
export type BackupExpectation = z.infer<typeof BackupExpectationSchema> & { id: string };

/** Only plain path characters: the pattern is expanded by the remote shell. */
const SAFE_PATH = /^\/[A-Za-z0-9._\-/*?[\]]+$/;

export function validateBackup(input: z.infer<typeof BackupExpectationSchema>): string[] {
  if (input.kind === 'file' && !SAFE_PATH.test(input.path)) {
    return [
      'Path must be absolute and use only letters, digits, . _ - / and the wildcards * ? [ ].',
    ];
  }
  if (input.kind === 's3' && /[\s]/.test(input.path)) return ['Prefix must not contain spaces.'];
  return [];
}

export interface NewestBackup {
  at: number;
  bytes: number;
  name: string;
}

export interface BackupDeps {
  load(): BackupExpectation[];
  hosts(): readonly Host[];
  resources(): readonly Resource[];
  configs(): Promise<ReadonlyMap<string, ResourceConfig>>;
  runnerFor(hostId: string): SweepRunner | undefined;
  context: ConnectorContext;
  /** Injectable for tests. */
  newestObject?(
    config: ResourceConfigOf<'s3'>,
    bucket: string,
    prefix: string,
  ): Promise<NewestBackup | null>;
}

/** Stored in the threat store's JSON cache (no secrets in it). */
export const backupStore = (cache: {
  getJson<T>(key: string): T | null;
  setJson(key: string, value: unknown, now: number): void;
}) => ({
  load: (): BackupExpectation[] => cache.getJson<BackupExpectation[]>(CONFIG_KEY) ?? [],
  save(input: z.infer<typeof BackupExpectationSchema>, now: number): BackupExpectation {
    const all = cache.getJson<BackupExpectation[]>(CONFIG_KEY) ?? [];
    const saved: BackupExpectation = {
      ...input,
      id: input.id ?? `bk-${randomBytes(4).toString('hex')}`,
    };
    cache.setJson(CONFIG_KEY, [...all.filter((b) => b.id !== saved.id), saved], now);
    return saved;
  },
  remove(id: string, now: number): boolean {
    const all = cache.getJson<BackupExpectation[]>(CONFIG_KEY) ?? [];
    if (!all.some((b) => b.id === id)) return false;
    cache.setJson(
      CONFIG_KEY,
      all.filter((b) => b.id !== id),
      now,
    );
    return true;
  },
});

/** The newest file matching a pattern on a server: "<mtime> <bytes> <path>". */
export function newestFileScript(path: string): string {
  return `export LC_ALL=C\nstat -c '%Y %s %n' ${path} 2>/dev/null | sort -n | tail -n 1\necho '@@end'\n`;
}

export function parseNewestFile(output: string): NewestBackup | null | 'failed' {
  if (!output.includes('@@end')) return 'failed';
  const line = output.split('\n').find((l) => /^\d+ \d+ /.test(l.trim()));
  if (!line) return null;
  const [mtime, bytes, ...rest] = line.trim().split(' ');
  return { at: Number(mtime) * 1000, bytes: Number(bytes), name: rest.join(' ') };
}

async function defaultNewestObject(
  config: ResourceConfigOf<'s3'>,
  context: ConnectorContext,
  bucket: string,
  prefix: string,
): Promise<NewestBackup | null> {
  const s3 = new S3Client(clientConfig(config, context));
  try {
    let newest: NewestBackup | null = null;
    let token: string | undefined;
    for (let page = 0; page < 10; page++) {
      const response = await s3.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix || undefined,
          ContinuationToken: token,
        }),
      );
      for (const object of response.Contents ?? []) {
        const at = object.LastModified?.getTime() ?? 0;
        if (!newest || at > newest.at)
          newest = { at, bytes: object.Size ?? 0, name: object.Key ?? '' };
      }
      if (!response.IsTruncated) break;
      token = response.NextContinuationToken;
    }
    return newest;
  } finally {
    s3.destroy();
  }
}

const bytesText = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GiB`
    : bytes >= 1024 ** 2
      ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
      : bytes >= 1024
        ? `${(bytes / 1024).toFixed(1)} KiB`
        : `${bytes} B`;

const ageText = (ms: number) =>
  ms < 2 * HOUR
    ? `${Math.round(ms / 60_000)} min`
    : ms < 48 * HOUR
      ? `${Math.round(ms / HOUR)} h`
      : `${Math.round(ms / (24 * HOUR))} days`;

/** Did last night's backup run, and is it a real one? */
export function createBackupProducer(deps: BackupDeps): InsightProducer {
  return {
    name: 'backups',
    intervalMs: 10 * 60_000,
    async run(now) {
      const results: ProducerResult[] = [];
      const hosts = deps.hosts();
      const resources = deps.resources();
      const configs = await deps.configs();
      for (const backup of deps.load()) {
        const host = hosts.find((h) => h.id === backup.targetId);
        const resource = resources.find((r) => r.id === backup.targetId);
        const targetName = host?.name ?? resource?.name ?? backup.targetId;
        const scope = `backup:${backup.id}`;
        let newest: NewestBackup | null | 'failed' = 'failed';
        let problem: string | null = null;
        try {
          if (backup.kind === 'file') {
            const runner = deps.runnerFor(backup.targetId);
            if (!runner) problem = 'the server is not connected';
            else
              newest = parseNewestFile(
                (await runner.exec('sh -s', newestFileScript(backup.path), 20_000)).stdout,
              );
          } else {
            const config = resource ? configs.get(resource.sourceId) : undefined;
            if (!resource || config?.kind !== 's3') problem = 'the bucket is not connected';
            else {
              newest = await (deps.newestObject
                ? deps.newestObject(config, resource.name, backup.path)
                : defaultNewestObject(config, deps.context, resource.name, backup.path));
            }
          }
        } catch (error) {
          problem = (error as Error).message.slice(0, 200);
        }
        if (newest === 'failed') {
          results.push({
            targetId: backup.targetId,
            targetName,
            drafts: [],
            checkedScopes: [],
            coverage: [
              { name: `Backup: ${backup.name}`, ok: false, note: problem ?? 'could not check' },
            ],
            upcoming: [
              {
                targetId: backup.targetId,
                kind: 'backup',
                label: backup.name,
                at: null,
                status: 'unknown',
                detail: problem ?? 'could not check',
              },
            ],
          });
          continue;
        }
        const maxAge = backup.maxAgeHours * HOUR;
        const where = backup.kind === 'file' ? backup.path : `${resource?.name}/${backup.path}`;
        const draftBase = { key: `backup:${backup.id}`, scope, category: 'backup' as const, now };
        let draft = null;
        if (!newest) {
          draft = insightDraft({
            ...draftBase,
            severity: 'high',
            title: `Backup "${backup.name}" is missing`,
            detail: `No backup matches ${where} on ${targetName}.`,
            advice:
              'Check that the backup job exists and runs (cron, systemd timer, your backup tool), and that the path is right.',
          });
        } else if (now - newest.at > maxAge) {
          const age = now - newest.at;
          draft = insightDraft({
            ...draftBase,
            severity: age > 2 * maxAge ? 'high' : 'medium',
            title: `Backup "${backup.name}" is late: last one ${ageText(age)} ago`,
            detail: `The newest backup (${newest.name}, ${bytesText(newest.bytes)}) is ${ageText(age)} old; one is expected at least every ${backup.maxAgeHours} h.`,
            advice:
              "Look at the backup job's last run and its log; a full disk or an expired credential is the usual cause.",
          });
        } else if (newest.bytes < backup.minBytes) {
          draft = insightDraft({
            ...draftBase,
            severity: 'medium',
            title: `Backup "${backup.name}" is too small (${bytesText(newest.bytes)})`,
            detail: `The newest backup (${newest.name}) is ${bytesText(newest.bytes)}, less than the ${bytesText(backup.minBytes)} expected. An empty or truncated dump usually means the job failed.`,
            advice: "Open the file and the job's log; try restoring it somewhere safe.",
          });
        }
        results.push({
          targetId: backup.targetId,
          targetName,
          drafts: draft ? [draft] : [],
          checkedScopes: [scope],
          coverage: [{ name: `Backup: ${backup.name}`, ok: true, note: null }],
          upcoming: [
            {
              targetId: backup.targetId,
              kind: 'backup',
              label: backup.name,
              at: newest ? newest.at + maxAge : null,
              status: !newest
                ? 'overdue'
                : now - newest.at > maxAge
                  ? 'overdue'
                  : newest.bytes < backup.minBytes
                    ? 'soon'
                    : 'ok',
              detail: newest
                ? `last: ${newest.name}, ${bytesText(newest.bytes)}, ${ageText(now - newest.at)} ago`
                : `nothing matches ${where}`,
            },
          ],
        });
      }
      return results;
    },
  };
}
