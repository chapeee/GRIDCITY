import { usagePercent, type Host, type HostState } from '@app/shared';
import type { StoredSample } from '../storage/sample-history';
import type { InsightProducer, ProducerResult } from '../threats/threat-hub';
import { expirySeverity, insightDraft, upcomingStatus } from './expiry';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Trends are fitted over at most this much history. */
const WINDOW_MS = 3 * DAY;
/** …and need at least this much of it. */
const MIN_SPAN_MS = 6 * HOUR;
/** A drop this large (points of percent) is a cleanup: the trend starts again after it. */
const CLEANUP_DROP = 5;
/** Slower growth than this (points per day) counts as "not filling up". */
const MIN_GROWTH_PER_DAY = 0.05;

export interface DiskTrend {
  /** Percent used now (latest sample). */
  current: number;
  /** Points of percent per day. */
  perDay: number;
  /** When it reaches 100 %, or null when it is not filling up. */
  fullAt: number | null;
}

/**
 * Least-squares line through the fullest disk's history since the last
 * cleanup. Null without enough history (a fresh install, a gap).
 */
export function diskTrend(samples: readonly StoredSample[], now: number): DiskTrend | null {
  let points = samples
    .filter((s) => s.maxDiskPercent !== null && now - s.at <= WINDOW_MS)
    .map((s) => ({ at: s.at, value: s.maxDiskPercent! }));
  for (let i = points.length - 1; i > 0; i--) {
    if (points[i - 1]!.value - points[i]!.value >= CLEANUP_DROP) {
      points = points.slice(i);
      break;
    }
  }
  if (points.length < 4 || points[points.length - 1]!.at - points[0]!.at < MIN_SPAN_MS) return null;
  const n = points.length;
  const meanT = points.reduce((sum, p) => sum + p.at, 0) / n;
  const meanV = points.reduce((sum, p) => sum + p.value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const p of points) {
    numerator += (p.at - meanT) * (p.value - meanV);
    denominator += (p.at - meanT) ** 2;
  }
  const slopePerMs = denominator === 0 ? 0 : numerator / denominator;
  const perDay = slopePerMs * DAY;
  const current = points[n - 1]!.value;
  if (perDay < MIN_GROWTH_PER_DAY || current >= 100) {
    return { current, perDay, fullAt: current >= 100 ? now : null };
  }
  return { current, perDay, fullAt: now + ((100 - current) / perDay) * DAY };
}

export interface DiskForecastDeps {
  hosts(): readonly Host[];
  states(): readonly HostState[];
  samples(hostId: string, since: number): StoredSample[];
}

/** "web-1's /var will be full in about 9 days", before it happens. */
export function createDiskForecastProducer(deps: DiskForecastDeps): InsightProducer {
  return {
    name: 'disk-forecast',
    intervalMs: 15 * 60_000,
    async run(now) {
      const states = new Map(deps.states().map((state) => [state.hostId, state]));
      const results: ProducerResult[] = [];
      for (const host of deps.hosts()) {
        const trend = diskTrend(deps.samples(host.id, now - WINDOW_MS), now);
        const fullest = [...(states.get(host.id)?.disks ?? [])].sort(
          (a, b) => (usagePercent(b) ?? 0) - (usagePercent(a) ?? 0),
        )[0];
        const label = fullest ? fullest.mount : 'fullest disk';
        if (!trend) {
          results.push({
            targetId: host.id,
            targetName: host.name,
            drafts: [],
            checkedScopes: [],
            coverage: [
              { name: 'Disk forecast', ok: false, note: 'needs at least 6 hours of history' },
            ],
          });
          continue;
        }
        const days =
          trend.fullAt === null ? null : Math.max(0, Math.floor((trend.fullAt - now) / DAY));
        const severity = days === null ? null : expirySeverity(days);
        const rate = `${trend.perDay.toFixed(trend.perDay < 1 ? 2 : 1)} points a day`;
        results.push({
          targetId: host.id,
          targetName: host.name,
          drafts:
            days !== null && severity
              ? [
                  insightDraft({
                    key: 'disk-full',
                    scope: 'disk-forecast',
                    category: 'disk-forecast',
                    severity,
                    title: `${host.name}: ${label} full ${days === 0 ? 'today' : `in about ${days} day${days === 1 ? '' : 's'}`}`,
                    detail: `${label} is ${trend.current.toFixed(0)} % used and growing by ${rate} (trend over the last ${trend.perDay > 0 ? 'days' : 'hours'}). At this rate it is full around ${new Date(trend.fullAt!).toLocaleDateString()}. A full disk stops databases, logs and deployments.`,
                    advice:
                      'Find what grows (du -xh / | sort -h | tail), rotate or delete old logs and backups, or grow the volume.',
                    now,
                  }),
                ]
              : [],
          checkedScopes: ['disk-forecast'],
          coverage: [{ name: 'Disk forecast', ok: true, note: null }],
          upcoming: [
            {
              targetId: host.id,
              kind: 'disk-full',
              label: `${host.name} ${label}`,
              at: trend.fullAt,
              status: days === null ? 'ok' : upcomingStatus(days),
              detail:
                trend.fullAt === null
                  ? `${trend.current.toFixed(0)} % used, not filling up`
                  : `${trend.current.toFixed(0)} % used, +${rate}`,
            },
          ],
        });
      }
      return results;
    },
  };
}
