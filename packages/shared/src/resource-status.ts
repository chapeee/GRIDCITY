import type { HostStatus } from './host-state';
import type { ResourceGauges, ResourceThresholds } from './resource';

/**
 * What a connector measured in one poll, beyond the gauges: the inputs to
 * the `degraded` rules. `null` means "this engine or this user cannot see it".
 */
export interface ResourceHealthSample {
  gauges: ResourceGauges;
  /** Seconds a replica is behind its primary; null on a primary or when unreadable. */
  replicationLagSeconds: number | null;
  /** Queries running longer than the slow-query limit right now (or new slow log entries). */
  slowQueries: number | null;
  /** Cache hit percent over this poll; null without enough reads to judge. */
  cacheHitPercent: number | null;
  /**
   * A problem the connector itself reports that is not a failure to connect,
   * e.g. "replica link down" or "instance is rebooting".
   */
  warnings: string[];
}

/** Consecutive polls counters, kept by whoever polls the resource. */
export interface ResourceStreaks {
  slowQueries: number;
  cpu: number;
}

export function nextResourceStreaks(
  previous: ResourceStreaks,
  sample: ResourceHealthSample,
  thresholds: ResourceThresholds,
): ResourceStreaks {
  const cpu = sample.gauges.cpuPercent;
  return {
    slowQueries:
      sample.slowQueries !== null && sample.slowQueries > 0 ? previous.slowQueries + 1 : 0,
    cpu: cpu !== null && cpu > thresholds.cpuDegradedPercent ? previous.cpu + 1 : 0,
  };
}

/** Every rule the sample breaks, as readable reasons. */
export function findResourceDegradedReasons(
  sample: ResourceHealthSample,
  streaks: ResourceStreaks,
  thresholds: ResourceThresholds,
): string[] {
  const reasons = [...sample.warnings];
  const { connections, storage, cpuPercent } = sample.gauges;

  if (connections?.max) {
    const percent = (connections.used / connections.max) * 100;
    if (percent > thresholds.connectionsDegradedPercent) {
      reasons.push(`connections ${connections.used}/${connections.max}`);
    }
  }
  if (
    sample.replicationLagSeconds !== null &&
    sample.replicationLagSeconds > thresholds.replicationLagDegradedSeconds
  ) {
    reasons.push(`replica ${Math.round(sample.replicationLagSeconds)}s behind`);
  }
  if (sample.slowQueries !== null && streaks.slowQueries >= thresholds.slowQueryDegradedPolls) {
    reasons.push(`${sample.slowQueries} slow quer${sample.slowQueries === 1 ? 'y' : 'ies'}`);
  }
  if (
    sample.cacheHitPercent !== null &&
    sample.cacheHitPercent < thresholds.cacheHitDegradedPercent
  ) {
    reasons.push(`cache hit ${Math.round(sample.cacheHitPercent)}%`);
  }
  if (storage?.totalBytes) {
    const percent = (storage.usedBytes / storage.totalBytes) * 100;
    if (percent > thresholds.storageDegradedPercent)
      reasons.push(`storage ${Math.round(percent)}%`);
  }
  if (cpuPercent !== null && streaks.cpu >= thresholds.cpuDegradedPolls) {
    reasons.push(`CPU ${Math.round(cpuPercent)}% for ${streaks.cpu} polls`);
  }
  return reasons;
}

export interface ResourceStatusInput {
  /** The last poll failed to reach the resource (or it reports itself down). */
  failed: boolean;
  failureReason?: string | null;
  hasPolled: boolean;
  sample: ResourceHealthSample | null;
  streaks: ResourceStreaks;
}

/** Same order of rules as hosts: offline, unknown, degraded, online. */
export function computeResourceStatus(
  input: ResourceStatusInput,
  thresholds: ResourceThresholds,
): { status: HostStatus; reason: string } {
  if (input.failed) return { status: 'offline', reason: input.failureReason ?? 'unreachable' };
  if (!input.hasPolled || !input.sample)
    return { status: 'unknown', reason: 'waiting for first poll' };
  const reasons = findResourceDegradedReasons(input.sample, input.streaks, thresholds);
  if (reasons.length > 0) return { status: 'degraded', reason: reasons.join(', ') };
  return { status: 'online', reason: 'all metrics within thresholds' };
}
