import {
  AppSettingsSchema,
  type AppSettings,
  type HistoryPoint,
  type HistoryResponse,
  type StatusThresholds,
} from '@app/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FileThresholdsSchema, HostPatchSchema, type HostPatch } from '../config/hosts-editor';
import { HostValidationError } from '../config/hosts-writer';
import type { AuditLog } from '../storage/audit-log';
import type { StoredSample } from '../storage/sample-history';

/** At most this many chart points per response (buckets are averaged down). */
const MAX_POINTS = 720;
const DAY_MS = 86_400_000;

export interface ManageDependencies {
  audit: AuditLog;
  /** The alert webhook, set in Settings and saved encrypted (optional in tests). */
  alerts?: {
    configured(): boolean;
    /** Set by ALERT_WEBHOOK_URL rather than in the app. */
    fromEnvironment(): boolean;
    setWebhook(url: string | null): void;
    sendTest(): Promise<void>;
  };
  demoMode: boolean;
  now?: () => number;
  hostsFile?: string;
  knownTargets(): Set<string>;
  samples(targetId: string, since: number): StoredSample[];
  incidents: (
    targetId: string | null,
    since: number,
    until: number,
  ) => HistoryResponse['incidents'];
  loadSettings(): AppSettings;
  saveSettings(settings: AppSettings): AppSettings;
  currentThresholds(): StatusThresholds;
  setThresholds(thresholds: Partial<StatusThresholds>): Promise<StatusThresholds>;
  editHost(id: string, patch: HostPatch): Promise<void>;
  removeHost(id: string): Promise<void>;
}

const HistoryQuerySchema = z.object({
  target: z.string().min(1).max(200).optional(),
  days: z.coerce.number().int().min(1).max(90).default(7),
});

const SettingsBodySchema = z.strictObject({
  app: AppSettingsSchema.partial().strict().optional(),
  thresholds: FileThresholdsSchema.optional(),
  /** A webhook URL (null removes it). Saved encrypted; never sent back. */
  alerts: z
    .strictObject({
      webhookUrl: z
        .url()
        .refine((value) => value.startsWith('https://') || value.startsWith('http://'), {
          message: 'must be an http(s) URL',
        })
        .nullable(),
    })
    .optional(),
});

/** History, Settings and Edit. Every write needs the usual token + Origin guards. */
export function registerManageRoutes(app: FastifyInstance, deps: ManageDependencies): void {
  const now = deps.now ?? Date.now;

  app.get('/api/history', async (request, reply) => {
    const query = HistoryQuerySchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'target and days (1-90) expected' });
    const settings = deps.loadSettings();
    const until = now();
    const days = Math.min(query.data.days, settings.historyRetentionDays);
    const since = until - days * DAY_MS;
    const targetId = query.data.target ?? null;
    const known = deps.knownTargets();
    if (targetId !== null && !known.has(targetId)) {
      return reply.code(404).send({ error: `unknown server or resource "${targetId}"` });
    }
    const { points, bucketMs } =
      targetId === null
        ? { points: [], bucketMs: 0 }
        : downsample(deps.samples(targetId, since), since, until);
    const incidents = deps
      .incidents(targetId, since, until)
      .filter((incident) => known.has(incident.targetId));
    const response: HistoryResponse = {
      targetId,
      since,
      until,
      retentionDays: settings.historyRetentionDays,
      bucketMs,
      points,
      incidents,
    };
    return response;
  });

  const settingsView = () => ({
    app: deps.loadSettings(),
    thresholds: deps.currentThresholds(),
    editable: !deps.demoMode,
    alerts: {
      webhookConfigured: deps.alerts?.configured() ?? false,
      fromEnvironment: deps.alerts?.fromEnvironment() ?? false,
    },
    ...(deps.hostsFile ? { hostsFile: process.env.HOSTS_FILE_HINT ?? deps.hostsFile } : {}),
  });

  app.get('/api/settings', async () => settingsView());

  app.put('/api/settings', async (request, reply) => {
    if (deps.demoMode)
      return reply.code(409).send({ error: 'Demo data: settings cannot be saved.' });
    const body = SettingsBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(422)
        .send({ problems: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    try {
      if (body.data.app) {
        const saved = deps.saveSettings({ ...deps.loadSettings(), ...body.data.app });
        deps.audit.append(
          'settings_changed',
          null,
          `history kept ${saved.historyRetentionDays} days`,
        );
      }
      if (body.data.alerts && deps.alerts) {
        deps.alerts.setWebhook(body.data.alerts.webhookUrl);
        deps.audit.append(
          'settings_changed',
          null,
          body.data.alerts.webhookUrl ? 'alert webhook set' : 'alert webhook removed',
        );
      }
      if (body.data.thresholds && Object.keys(body.data.thresholds).length > 0) {
        await deps.setThresholds(body.data.thresholds);
        deps.audit.append(
          'settings_changed',
          null,
          `thresholds: ${describe(body.data.thresholds)}`,
        );
      }
    } catch (error) {
      if (error instanceof HostValidationError)
        return reply.code(422).send({ problems: error.problems });
      throw error;
    }
    return settingsView();
  });

  app.post('/api/alerts/test', async (_request, reply) => {
    if (deps.demoMode || !deps.alerts) {
      return reply.code(409).send({ error: 'Demo data: alerts are not sent.' });
    }
    try {
      await deps.alerts.sendTest();
      return { ok: true };
    } catch (error) {
      return reply.code(502).send({ error: (error as Error).message });
    }
  });

  app.patch<{ Params: { id: string } }>('/api/hosts/:id', async (request, reply) => {
    if (deps.demoMode) return reply.code(409).send({ error: 'Demo data: hosts cannot be edited.' });
    const patch = HostPatchSchema.safeParse(request.body);
    if (!patch.success) {
      return reply
        .code(422)
        .send({ problems: patch.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    try {
      await deps.editHost(request.params.id, patch.data);
    } catch (error) {
      if (error instanceof HostValidationError)
        return reply.code(422).send({ problems: error.problems });
      throw error;
    }
    deps.audit.append('host_edited', request.params.id, describe(patch.data));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/hosts/:id', async (request, reply) => {
    if (deps.demoMode)
      return reply.code(409).send({ error: 'Demo data: hosts cannot be removed.' });
    try {
      await deps.removeHost(request.params.id);
    } catch (error) {
      if (error instanceof HostValidationError)
        return reply.code(422).send({ problems: error.problems });
      throw error;
    }
    deps.audit.append('host_removed', request.params.id);
    return { ok: true };
  });
}

/** Averages stored buckets into at most MAX_POINTS points; empty windows stay gaps. */
export function downsample(
  samples: readonly StoredSample[],
  since: number,
  until: number,
): { points: HistoryPoint[]; bucketMs: number } {
  const bucketMs = Math.max(30_000, Math.ceil((until - since) / MAX_POINTS / 30_000) * 30_000);
  const groups = new Map<number, StoredSample[]>();
  for (const sample of samples) {
    const key = Math.floor(sample.at / bucketMs) * bucketMs;
    const group = groups.get(key);
    if (group) group.push(sample);
    else groups.set(key, [sample]);
  }
  const average = (group: StoredSample[], key: keyof Omit<StoredSample, 'at'>) => {
    const values = group.map((s) => s[key]).filter((v): v is number => v !== null);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
  };
  const points: HistoryPoint[] = [];
  const start = Math.floor(since / bucketMs) * bucketMs;
  for (let at = start; at <= until; at += bucketMs) {
    const group = groups.get(at);
    // A missing bucket is a gap (no data), so charts never draw a line through it.
    points.push(
      group
        ? {
            at,
            cpuPercent: average(group, 'cpuPercent'),
            memoryPercent: average(group, 'memoryPercent'),
            maxDiskPercent: average(group, 'maxDiskPercent'),
            networkBytesPerSec: average(group, 'networkBytesPerSec'),
            loadOne: average(group, 'loadOne'),
          }
        : {
            at,
            cpuPercent: null,
            memoryPercent: null,
            maxDiskPercent: null,
            networkBytesPerSec: null,
            loadOne: null,
          },
    );
  }
  return { points, bucketMs };
}

function describe(value: object): string {
  return Object.entries(value)
    .map(
      ([key, entry]) =>
        `${key}=${typeof entry === 'object' ? JSON.stringify(entry) : String(entry)}`,
    )
    .join(', ');
}
