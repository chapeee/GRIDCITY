import type { HostStatus } from '@app/shared';

/**
 * The light of a district plate's edge, from the status of everything in it
 * (docs/VISUAL_LANGUAGE.md, "Districts"):
 * - attention: something inside is degraded or offline (amber);
 * - online: every measured member is online (cyan);
 * - unknown: nothing inside has been measured yet, or it is empty (muted).
 * Stale members do not count as online: their data is old.
 */
export type DistrictTone = 'online' | 'attention' | 'unknown';

export function districtTone(
  members: readonly { status: HostStatus; stale: boolean }[],
): DistrictTone {
  if (members.some((m) => m.status === 'degraded' || m.status === 'offline')) return 'attention';
  const live = members.filter((m) => m.status === 'online' && !m.stale);
  return live.length > 0 ? 'online' : 'unknown';
}
