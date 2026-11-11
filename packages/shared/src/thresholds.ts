import { z } from 'zod';

/**
 * Tunable rules for polling, staleness and the `degraded` status.
 * Defaults follow the project brief; every value can be overridden in config.
 */
export const StatusThresholdsSchema = z.object({
  /** How often each host is polled, in milliseconds. */
  pollIntervalMs: z.number().int().min(500).default(2000),
  /** Data older than `pollIntervalMs * staleAfterPolls` is considered stale. */
  staleAfterPolls: z.number().int().min(1).default(3),
  /** How often services, containers and connections are discovered on each host, ms. */
  discoveryIntervalMs: z.number().int().min(5000).default(30_000),
  /** CPU percent above which a host counts as busy... */
  cpuDegradedPercent: z.number().min(0).max(100).default(90),
  /** ...for this many consecutive polls before it becomes `degraded`. */
  cpuDegradedPolls: z.number().int().min(1).default(3),
  /** Memory usage percent above which a host is `degraded`. */
  memoryDegradedPercent: z.number().min(0).max(100).default(90),
  /** Usage percent of any single disk above which a host is `degraded`. */
  diskDegradedPercent: z.number().min(0).max(100).default(90),
});
export type StatusThresholds = z.infer<typeof StatusThresholdsSchema>;

export const DEFAULT_STATUS_THRESHOLDS: StatusThresholds = StatusThresholdsSchema.parse({});

const percent = z.number().min(0).max(100);
const polls = z.number().int().min(1).max(1000);

/**
 * What one host may override (Edit dialog, `thresholds:` under a host in
 * hosts.yaml): when it turns degraded, the amber warning. No defaults, so an
 * override only ever contains what the user set; the rest comes from the file.
 */
export const HostThresholdOverridesSchema = z.strictObject({
  cpuDegradedPercent: percent.optional(),
  cpuDegradedPolls: polls.optional(),
  memoryDegradedPercent: percent.optional(),
  diskDegradedPercent: percent.optional(),
});
export type HostThresholdOverrides = z.infer<typeof HostThresholdOverridesSchema>;

/** File-wide thresholds as edited in Settings (also without defaults). */
export const ThresholdsPatchSchema = HostThresholdOverridesSchema.extend({
  pollIntervalMs: z.number().int().min(500).max(600_000).optional(),
  staleAfterPolls: polls.optional(),
  discoveryIntervalMs: z.number().int().min(5000).max(3_600_000).optional(),
});

/** The thresholds in effect for one host. */
export function thresholdsForHost(
  thresholds: StatusThresholds,
  host: { thresholds?: HostThresholdOverrides | undefined } | undefined,
): StatusThresholds {
  return host?.thresholds ? { ...thresholds, ...host.thresholds } : thresholds;
}
