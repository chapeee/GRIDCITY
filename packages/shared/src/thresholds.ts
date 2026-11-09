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
