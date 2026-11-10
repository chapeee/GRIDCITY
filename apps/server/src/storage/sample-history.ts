import { usagePercent, type HostState } from '@app/shared';
import type { AppDatabase } from './database';

export interface SampleHistoryOptions {
  /** Width of one stored row, ms. */
  bucketMs: number;
  /** Rows older than this are deleted, ms. */
  retentionMs: number;
}

export const DEFAULT_HISTORY: SampleHistoryOptions = {
  bucketMs: 30_000,
  // 7 days by default; the Settings panel changes it (setRetention).
  retentionMs: 7 * 24 * 60 * 60 * 1000,
};

type MetricKey =
  'cpuPercent' | 'memoryPercent' | 'networkBytesPerSec' | 'loadOne' | 'maxDiskPercent';

interface Bucket {
  start: number;
  lastSeenAt: number;
  sums: Record<MetricKey, number>;
  counts: Record<MetricKey, number>;
}

export interface StoredSample {
  at: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  networkBytesPerSec: number | null;
  loadOne: number | null;
  maxDiskPercent: number | null;
}

/**
 * Keeps the last days of history (7 by default, set in Settings) at reduced resolution: polls are
 * averaged into fixed buckets (unknown values are skipped, never counted as
 * zero) and one row per host per bucket is written. Read by the time
 * scrubber in a later phase.
 */
export class SampleHistory {
  private readonly buckets = new Map<string, Bucket>();
  private readonly insert;

  private readonly options: SampleHistoryOptions;

  constructor(
    private readonly db: AppDatabase,
    options: SampleHistoryOptions = DEFAULT_HISTORY,
  ) {
    this.options = { ...options };
    this.insert = db.prepare(`
      INSERT OR REPLACE INTO metric_samples
        (host_id, at, cpu_percent, memory_percent, network_bytes_per_sec, load_one, max_disk_percent)
      VALUES (@hostId, @at, @cpuPercent, @memoryPercent, @networkBytesPerSec, @loadOne, @maxDiskPercent)
    `);
  }

  /** Adds a host state; only new polls count (re-sent stale states are ignored). */
  record(state: HostState): void {
    if (state.lastSeenAt === null || state.status === 'offline') return;
    const existing = this.buckets.get(state.hostId);
    if (existing && state.lastSeenAt <= existing.lastSeenAt) return;

    const start = Math.floor(state.lastSeenAt / this.options.bucketMs) * this.options.bucketMs;
    let bucket = existing;
    if (!bucket || bucket.start !== start) {
      if (bucket) this.write(state.hostId, bucket);
      bucket = { start, lastSeenAt: 0, sums: emptyMetrics(), counts: emptyMetrics() };
      this.buckets.set(state.hostId, bucket);
    }
    bucket.lastSeenAt = state.lastSeenAt;

    const values: Record<MetricKey, number | null> = {
      cpuPercent: state.cpuPercent,
      memoryPercent: state.memory ? usagePercent(state.memory) : null,
      networkBytesPerSec:
        state.network.length > 0
          ? state.network.reduce((sum, rate) => sum + rate.rxBytesPerSec + rate.txBytesPerSec, 0)
          : null,
      loadOne: state.load?.one ?? null,
      maxDiskPercent:
        state.disks.length > 0
          ? Math.max(...state.disks.map((disk) => usagePercent(disk) ?? 0))
          : null,
    };
    for (const key of Object.keys(values) as MetricKey[]) {
      const value = values[key];
      if (value === null) continue;
      bucket.sums[key] += value;
      bucket.counts[key] += 1;
    }
  }

  /** Writes all open buckets (call on shutdown) and deletes expired rows. */
  flush(now: number): void {
    for (const [hostId, bucket] of this.buckets) this.write(hostId, bucket);
    this.buckets.clear();
    this.prune(now);
  }

  /** Writes the buckets still being filled without closing them (for history reads). */
  writeOpen(): void {
    for (const [hostId, bucket] of this.buckets) this.write(hostId, bucket);
  }

  /** Changes how long rows are kept and deletes what is now too old. */
  setRetention(retentionMs: number, now: number): void {
    this.options.retentionMs = retentionMs;
    this.prune(now);
  }

  get retentionMs(): number {
    return this.options.retentionMs;
  }

  prune(now: number): void {
    this.db.prepare('DELETE FROM metric_samples WHERE at < ?').run(now - this.options.retentionMs);
  }

  /** Stored rows for one host since `since`, oldest first. */
  query(hostId: string, since: number): StoredSample[] {
    return this.db
      .prepare(
        `SELECT at, cpu_percent AS cpuPercent, memory_percent AS memoryPercent,
                network_bytes_per_sec AS networkBytesPerSec, load_one AS loadOne,
                max_disk_percent AS maxDiskPercent
         FROM metric_samples WHERE host_id = ? AND at >= ? ORDER BY at`,
      )
      .all(hostId, since) as StoredSample[];
  }

  private write(hostId: string, bucket: Bucket): void {
    const average = (key: MetricKey) =>
      bucket.counts[key] > 0 ? bucket.sums[key] / bucket.counts[key] : null;
    this.insert.run({
      hostId,
      at: bucket.start,
      cpuPercent: average('cpuPercent'),
      memoryPercent: average('memoryPercent'),
      networkBytesPerSec: average('networkBytesPerSec'),
      loadOne: average('loadOne'),
      maxDiskPercent: average('maxDiskPercent'),
    });
  }
}

function emptyMetrics(): Record<MetricKey, number> {
  return { cpuPercent: 0, memoryPercent: 0, networkBytesPerSec: 0, loadOne: 0, maxDiskPercent: 0 };
}
