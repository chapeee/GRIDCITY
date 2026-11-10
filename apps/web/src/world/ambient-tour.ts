import { isStale, type HostState, type StatusThresholds } from '@app/shared';

/**
 * Ambient mode ("second monitor"): the camera drifts between hosts that need
 * attention. Pure selection logic, so the order is predictable and tested.
 */

/** How long ambient mode stays on one host before moving on, ms. */
export const AMBIENT_DWELL_MS = 12_000;

/**
 * Hosts that need attention, in navigation order: offline, degraded, or
 * stale (data stopped arriving). Healthy and not-yet-measured hosts are never
 * tour stops.
 */
export function hostsNeedingAttention(
  navigationOrder: readonly string[],
  states: Readonly<Record<string, HostState | undefined>>,
  now: number,
  thresholds: StatusThresholds,
): string[] {
  return navigationOrder.filter((hostId) => {
    const state = states[hostId];
    if (!state || state.status === 'unknown') return false;
    if (state.status === 'offline' || state.status === 'degraded') return true;
    return state.stale || isStale(state.lastSeenAt, now, thresholds);
  });
}

/**
 * The next tour stop after `current`, wrapping around. Null when every host is
 * healthy (the camera then slowly orbits the whole city instead).
 */
export function nextAmbientTarget(
  candidates: readonly string[],
  current: string | null,
): string | null {
  if (candidates.length === 0) return null;
  const index = current === null ? -1 : candidates.indexOf(current);
  return candidates[(index + 1) % candidates.length] ?? null;
}
