import type { BackupType, RetentionPolicy } from '@app/shared';

export interface RetentionCandidate {
  id: string;
  startedAt: number;
  type: BackupType;
  /** The backup this one needs to be restored (incremental: previous; differential: its full). */
  parentRunId: string | null;
}

/**
 * Which successful backups a policy no longer keeps. Pure.
 *
 * - No rule set: nothing is ever deleted.
 * - keepLast / keepDaily / keepWeekly / keepMonthly: a backup is kept when
 *   ANY rule keeps it (the newest backup of each day / ISO week / month).
 * - maxAgeDays: everything younger is kept; older backups go unless a
 *   count rule keeps them.
 * - The newest backup is always kept.
 * - Chains stay restorable: a kept incremental or differential keeps every
 *   backup it depends on, however old.
 */
export function selectExpired(
  candidates: readonly RetentionCandidate[],
  policy: RetentionPolicy,
  now: number,
): string[] {
  const hasCountRule =
    policy.keepLast !== undefined ||
    policy.keepDaily !== undefined ||
    policy.keepWeekly !== undefined ||
    policy.keepMonthly !== undefined;
  if (!hasCountRule && policy.maxAgeDays === undefined) return [];
  if (candidates.length === 0) return [];

  const sorted = [...candidates].sort((a, b) => b.startedAt - a.startedAt);
  const keep = new Set<string>([sorted[0]!.id]);

  if (hasCountRule) {
    if (policy.keepLast) for (const c of sorted.slice(0, policy.keepLast)) keep.add(c.id);
    const bucketKeep = (count: number | undefined, bucket: (at: number) => string) => {
      if (!count) return;
      const seen = new Set<string>();
      for (const c of sorted) {
        const key = bucket(c.startedAt);
        if (seen.has(key)) continue;
        seen.add(key);
        keep.add(c.id);
        if (seen.size >= count) break;
      }
    };
    bucketKeep(policy.keepDaily, dayKey);
    bucketKeep(policy.keepWeekly, weekKey);
    bucketKeep(policy.keepMonthly, monthKey);
  }
  if (policy.maxAgeDays !== undefined) {
    // Everything younger than the age limit is kept (together with the count rules).
    const cutoff = now - policy.maxAgeDays * 86_400_000;
    for (const c of sorted) if (c.startedAt >= cutoff) keep.add(c.id);
  }

  // Keep every ancestor of a kept backup.
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const stack = [...keep];
  while (stack.length > 0) {
    const id = stack.pop()!;
    const parent = byId.get(id)?.parentRunId;
    if (parent && byId.has(parent) && !keep.has(parent)) {
      keep.add(parent);
      stack.push(parent);
    }
  }
  return sorted.filter((c) => !keep.has(c.id)).map((c) => c.id);
}

const pad = (n: number) => String(n).padStart(2, '0');

function dayKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function monthKey(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

/** ISO week ("2026-W46"). */
function weekKey(at: number): string {
  const d = new Date(at);
  const day = (d.getDay() + 6) % 7; // Monday = 0
  const thursday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - day + 3);
  const firstThursday = new Date(thursday.getFullYear(), 0, 4);
  const week =
    1 +
    Math.round(
      ((thursday.getTime() - firstThursday.getTime()) / 86_400_000 -
        3 +
        ((firstThursday.getDay() + 6) % 7)) /
        7,
    );
  return `${thursday.getFullYear()}-W${pad(week)}`;
}
