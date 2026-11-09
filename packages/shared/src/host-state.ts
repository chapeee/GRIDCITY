import { z } from 'zod';

/**
 * Health of a host as computed by the server's state engine.
 *
 * - `unknown`  – no successful poll yet. Never rendered as healthy.
 * - `online`   – connected and within all thresholds.
 * - `degraded` – connected but over a threshold (see {@link StatusThresholds}).
 * - `offline`  – SSH connect failed or the heartbeat was lost.
 */
export const HostStatusSchema = z.enum(['unknown', 'online', 'degraded', 'offline']);
export type HostStatus = z.infer<typeof HostStatusSchema>;

const nonNegative = z.number().nonnegative();

/** Used/total pair in bytes (memory, swap). */
export const ByteUsageSchema = z.object({
  usedBytes: nonNegative,
  totalBytes: nonNegative,
});
export type ByteUsage = z.infer<typeof ByteUsageSchema>;

/** One mounted filesystem as reported by `df -P -k`. */
export const DiskUsageSchema = ByteUsageSchema.extend({
  mount: z.string().min(1),
});
export type DiskUsage = z.infer<typeof DiskUsageSchema>;

/** Throughput of one network interface, derived from /proc/net/dev deltas. */
export const NetworkRateSchema = z.object({
  iface: z.string().min(1),
  rxBytesPerSec: nonNegative,
  txBytesPerSec: nonNegative,
});
export type NetworkRate = z.infer<typeof NetworkRateSchema>;

/** Load averages from /proc/loadavg. */
export const LoadAverageSchema = z.object({
  one: nonNegative,
  five: nonNegative,
  fifteen: nonNegative,
});
export type LoadAverage = z.infer<typeof LoadAverageSchema>;

/**
 * The latest known live state of one host.
 *
 * Truth-first rule: every metric is nullable, and `null` means "we do not
 * know". The client must render `null` as unknown, never as zero or healthy.
 * Rates (CPU, network) stay `null` until two polls exist to diff.
 */
export const HostStateSchema = z.object({
  hostId: z.string().min(1),
  status: HostStatusSchema,
  /** Short human-readable explanation of `status`, e.g. "disk / at 94%". */
  statusReason: z.string().nullable(),
  /** Epoch milliseconds of the last successful poll, or null if never polled. */
  lastSeenAt: z.number().int().nullable(),
  /** True when `lastSeenAt` is older than the stale window. See {@link isStale}. */
  stale: z.boolean(),
  cpuPercent: z.number().min(0).max(100).nullable(),
  load: LoadAverageSchema.nullable(),
  memory: ByteUsageSchema.nullable(),
  swap: ByteUsageSchema.nullable(),
  disks: z.array(DiskUsageSchema),
  network: z.array(NetworkRateSchema),
  uptimeSeconds: nonNegative.nullable(),
  /** OS and kernel description, e.g. "Ubuntu 24.04 · 6.8.0-45-generic". */
  os: z.string().nullable(),
  /** Last connection or poll error, if any. Shown verbatim in the HUD. */
  error: z.string().nullable(),
});
export type HostState = z.infer<typeof HostStateSchema>;

/** State for a host the server has not polled yet: everything unknown. */
export function createUnknownHostState(hostId: string): HostState {
  return {
    hostId,
    status: 'unknown',
    statusReason: 'waiting for first poll',
    lastSeenAt: null,
    stale: false,
    cpuPercent: null,
    load: null,
    memory: null,
    swap: null,
    disks: [],
    network: [],
    uptimeSeconds: null,
    os: null,
    error: null,
  };
}
