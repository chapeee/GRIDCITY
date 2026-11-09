import type { ByteUsage, DiskUsage, HostStatus } from './host-state';
import type { StatusThresholds } from './thresholds';

/** The metrics that decide whether a connected host is `degraded`. */
export interface HealthSample {
  cpuPercent: number | null;
  memory: ByteUsage | null;
  disks: readonly DiskUsage[];
}

/** Connection lifecycle as seen by whoever polls the host. */
export type ConnectionPhase = 'connecting' | 'connected' | 'failed';

export interface StatusInput {
  connection: ConnectionPhase;
  /** True once at least one poll succeeded on the current or a previous connection. */
  hasPolled: boolean;
  /** Consecutive polls with CPU above the threshold. See {@link nextCpuBusyStreak}. */
  cpuBusyStreak: number;
  sample: HealthSample;
  /** Error message from the failed connection, if any. */
  connectionError?: string | null;
}

export interface StatusResult {
  status: HostStatus;
  /** Short, human-readable explanation shown in the HUD. */
  reason: string;
}

/**
 * Updates the count of consecutive busy polls. CPU must stay above the
 * threshold for `cpuDegradedPolls` polls in a row, so a single spike never
 * marks a host degraded. Unknown CPU (first poll, no delta yet) resets it.
 */
export function nextCpuBusyStreak(
  previousStreak: number,
  cpuPercent: number | null,
  thresholds: Pick<StatusThresholds, 'cpuDegradedPercent'>,
): number {
  if (cpuPercent === null) return 0;
  return cpuPercent > thresholds.cpuDegradedPercent ? previousStreak + 1 : 0;
}

/** Usage as a percentage, or null when the total is unknown or zero. */
export function usagePercent(usage: ByteUsage): number | null {
  return usage.totalBytes > 0 ? (usage.usedBytes / usage.totalBytes) * 100 : null;
}

/** Every threshold the sample currently breaks, as readable reasons. */
export function findDegradedReasons(
  sample: HealthSample,
  cpuBusyStreak: number,
  thresholds: StatusThresholds,
): string[] {
  const reasons: string[] = [];

  if (sample.cpuPercent !== null && cpuBusyStreak >= thresholds.cpuDegradedPolls) {
    reasons.push(`CPU ${Math.round(sample.cpuPercent)}% for ${cpuBusyStreak} polls`);
  }

  const memoryPercent = sample.memory ? usagePercent(sample.memory) : null;
  if (memoryPercent !== null && memoryPercent > thresholds.memoryDegradedPercent) {
    reasons.push(`memory ${Math.round(memoryPercent)}%`);
  }

  for (const disk of sample.disks) {
    const diskPercent = usagePercent(disk);
    if (diskPercent !== null && diskPercent > thresholds.diskDegradedPercent) {
      reasons.push(`disk ${disk.mount} ${Math.round(diskPercent)}%`);
    }
  }

  return reasons;
}

/**
 * The status rules from the brief, in one place:
 * - `offline`  when the connection failed or the heartbeat was lost;
 * - `unknown`  before the first successful poll;
 * - `degraded` when any threshold is broken;
 * - `online`   otherwise.
 */
export function computeHostStatus(input: StatusInput, thresholds: StatusThresholds): StatusResult {
  if (input.connection === 'failed') {
    return { status: 'offline', reason: input.connectionError ?? 'connection lost' };
  }
  if (!input.hasPolled) {
    return { status: 'unknown', reason: 'waiting for first poll' };
  }

  const reasons = findDegradedReasons(input.sample, input.cpuBusyStreak, thresholds);
  if (reasons.length > 0) {
    return { status: 'degraded', reason: reasons.join(', ') };
  }
  return { status: 'online', reason: 'all metrics within thresholds' };
}
