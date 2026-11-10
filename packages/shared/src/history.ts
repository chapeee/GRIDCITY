import { z } from 'zod';

/**
 * History: what happened to a server (or resource) over the retention
 * window. Two kinds of record, both read from the local database:
 * - incidents: periods a target was degraded ("overloaded") or offline,
 *   from status transitions recorded as they happen;
 * - points: averaged metric buckets for the charts.
 */
export const IncidentStatusSchema = z.enum(['degraded', 'offline']);
export type IncidentStatus = z.infer<typeof IncidentStatusSchema>;

export const HistoryIncidentSchema = z.object({
  targetId: z.string(),
  status: IncidentStatusSchema,
  /** Status reason when the incident started, e.g. "CPU 97% for 3 polls". */
  reason: z.string().nullable(),
  startedAt: z.number().int(),
  /** Null while the incident is still going on. */
  endedAt: z.number().int().nullable(),
});
export type HistoryIncident = z.infer<typeof HistoryIncidentSchema>;

export const HistoryPointSchema = z.object({
  at: z.number().int(),
  cpuPercent: z.number().nullable(),
  memoryPercent: z.number().nullable(),
  maxDiskPercent: z.number().nullable(),
  networkBytesPerSec: z.number().nullable(),
  loadOne: z.number().nullable(),
});
export type HistoryPoint = z.infer<typeof HistoryPointSchema>;

export const HistoryResponseSchema = z.object({
  targetId: z.string().nullable(),
  since: z.number().int(),
  until: z.number().int(),
  retentionDays: z.number().int(),
  /** Width of one point after downsampling, ms. */
  bucketMs: z.number().int(),
  points: z.array(HistoryPointSchema),
  incidents: z.array(HistoryIncidentSchema),
});
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

/** App settings kept in the local database (not secrets, not per-host config). */
export const AppSettingsSchema = z.object({
  /** How long metric history and incidents are kept. */
  historyRetentionDays: z.number().int().min(1).max(90).default(7),
});
export type AppSettings = z.infer<typeof AppSettingsSchema>;
export const DEFAULT_APP_SETTINGS: AppSettings = AppSettingsSchema.parse({});

/** Total time spent in incidents of each status inside [since, until]. */
export function incidentTotals(
  incidents: readonly HistoryIncident[],
  since: number,
  until: number,
): Record<IncidentStatus, number> {
  const totals: Record<IncidentStatus, number> = { degraded: 0, offline: 0 };
  for (const incident of incidents) {
    const start = Math.max(since, incident.startedAt);
    const end = Math.min(until, incident.endedAt ?? until);
    if (end > start) totals[incident.status] += end - start;
  }
  return totals;
}
