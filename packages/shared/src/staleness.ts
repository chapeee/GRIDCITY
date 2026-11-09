import type { StatusThresholds } from './thresholds';

/**
 * Whether host data should be shown as frozen.
 *
 * A host that has never been polled is not stale: it is `unknown`, which has
 * its own visual treatment. Staleness only applies once we have seen data and
 * it has stopped arriving.
 *
 * @param lastSeenAt Epoch ms of the last successful poll, or null.
 * @param now        Epoch ms "now" (injected so the function stays pure).
 */
export function isStale(
  lastSeenAt: number | null,
  now: number,
  thresholds: Pick<StatusThresholds, 'pollIntervalMs' | 'staleAfterPolls'>,
): boolean {
  if (lastSeenAt === null) return false;
  const staleWindowMs = thresholds.pollIntervalMs * thresholds.staleAfterPolls;
  return now - lastSeenAt > staleWindowMs;
}
