import type { HistoryIncident, HostStatus } from '@app/shared';
import type { AppDatabase } from './database';

interface EventRow {
  targetId: string;
  at: number;
  status: HostStatus;
  reason: string | null;
}

/**
 * Status transitions of hosts and resources, the source of incidents
 * ("when was this server overloaded"). Only real changes between online,
 * degraded and offline are written; `unknown` (never measured) is not a
 * status change worth remembering.
 */
export class StatusEvents {
  private readonly last = new Map<string, HostStatus>();
  private readonly insert;

  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {
    this.insert = db.prepare(
      'INSERT INTO status_events (target_id, at, status, reason) VALUES (?, ?, ?, ?)',
    );
    // Continue from what was recorded before a restart.
    const rows = db
      .prepare(
        `SELECT target_id AS targetId, status FROM status_events e
         WHERE id = (SELECT MAX(id) FROM status_events WHERE target_id = e.target_id)`,
      )
      .all() as { targetId: string; status: HostStatus }[];
    for (const row of rows) this.last.set(row.targetId, row.status);
  }

  /** Records a transition if the status really changed. Returns true when written. */
  record(targetId: string, status: HostStatus, reason: string | null, at = this.now()): boolean {
    if (status === 'unknown' || this.last.get(targetId) === status) return false;
    this.last.set(targetId, status);
    this.insert.run(targetId, at, status, reason);
    return true;
  }

  prune(olderThan: number): void {
    // Keep the newest event per target so a long incident still has its start.
    this.db
      .prepare(
        `DELETE FROM status_events WHERE at < ?
         AND id NOT IN (SELECT MAX(id) FROM status_events GROUP BY target_id)`,
      )
      .run(olderThan);
  }

  /** Every target's recorded status at a moment (its last transition at or before it). */
  statusAt(at: number): Map<string, { status: HostStatus; reason: string | null }> {
    const rows = this.db
      .prepare(
        `SELECT target_id AS targetId, status, reason FROM status_events e
         WHERE id = (SELECT MAX(id) FROM status_events WHERE target_id = e.target_id AND at <= ?)`,
      )
      .all(at) as { targetId: string; status: HostStatus; reason: string | null }[];
    return new Map(rows.map((row) => [row.targetId, { status: row.status, reason: row.reason }]));
  }

  /** Incidents (degraded or offline periods) overlapping [since, until], oldest first. */
  incidents(targetId: string | null, since: number, until: number): HistoryIncident[] {
    const rows = (
      targetId === null
        ? this.db
            .prepare(
              'SELECT target_id AS targetId, at, status, reason FROM status_events WHERE at <= ? ORDER BY target_id, at, id',
            )
            .all(until)
        : this.db
            .prepare(
              'SELECT target_id AS targetId, at, status, reason FROM status_events WHERE target_id = ? AND at <= ? ORDER BY at, id',
            )
            .all(targetId, until)
    ) as EventRow[];
    return toIncidents(rows).filter((incident) => (incident.endedAt ?? Infinity) >= since);
  }
}

/** Pure: consecutive events per target -> periods spent degraded or offline. */
export function toIncidents(rows: readonly EventRow[]): HistoryIncident[] {
  const incidents: HistoryIncident[] = [];
  const open = new Map<string, HistoryIncident>();
  for (const row of rows) {
    const current = open.get(row.targetId);
    if (current) {
      current.endedAt = row.at;
      open.delete(row.targetId);
    }
    if (row.status === 'degraded' || row.status === 'offline') {
      const incident: HistoryIncident = {
        targetId: row.targetId,
        status: row.status,
        reason: row.reason,
        startedAt: row.at,
        endedAt: null,
      };
      incidents.push(incident);
      open.set(row.targetId, incident);
    }
  }
  return incidents.sort((a, b) => a.startedAt - b.startedAt);
}
