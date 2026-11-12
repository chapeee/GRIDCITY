import { SEVERITY_RANK, type ThreatFinding } from '@app/shared';
import type { AppDatabase } from '../storage/database';
import type { HostBaseline, ThreatDraft } from './detect';

interface Row {
  id: string;
  target_id: string;
  scope: string;
  source: ThreatFinding['source'];
  severity: ThreatFinding['severity'];
  category: ThreatFinding['category'];
  title: string;
  detail: string;
  advice: string;
  attacker_ip: string | null;
  count: number;
  first_seen: number;
  last_seen: number;
  blocked: number | null;
  status: 'open' | 'resolved';
  resolved_at: number | null;
  acknowledged_at: number | null;
}

export interface ApplyResult {
  opened: ThreatFinding[];
  /** Open findings whose severity went up (worth a new alert). */
  escalated: ThreatFinding[];
  resolved: ThreatFinding[];
  /** Anything changed that the browser should see. */
  changed: boolean;
}

const toFinding = (row: Row): ThreatFinding => ({
  id: row.id,
  targetId: row.target_id,
  source: row.source,
  severity: row.severity,
  category: row.category,
  title: row.title,
  detail: row.detail,
  advice: row.advice,
  attackerIp: row.attacker_ip,
  count: row.count,
  firstSeen: row.first_seen,
  lastSeen: row.last_seen,
  blocked: row.blocked === null ? null : row.blocked === 1,
  status: row.status,
  resolvedAt: row.resolved_at,
});

/**
 * Findings and baselines in SQLite. A check's drafts are applied as a whole:
 * new ones open, known ones update, and open ones that a check which ran no
 * longer reports are resolved. A finding the user marked as expected stays
 * resolved until the attack shows activity newer than that.
 */
export class ThreatStore {
  constructor(private readonly db: AppDatabase) {}

  apply(
    targetId: string,
    drafts: readonly ThreatDraft[],
    checkedScopes: readonly string[],
    now: number,
  ): ApplyResult {
    const result: ApplyResult = { opened: [], escalated: [], resolved: [], changed: false };
    const existing = new Map(
      (
        this.db.prepare('SELECT * FROM threat_findings WHERE target_id = ?').all(targetId) as Row[]
      ).map((row) => [row.id, row]),
    );
    const upsert = this.db.prepare(
      `INSERT INTO threat_findings (id, target_id, scope, source, severity, category, title, detail, advice,
         attacker_ip, count, first_seen, last_seen, blocked, status, resolved_at, acknowledged_at)
       VALUES (@id, @target_id, @scope, @source, @severity, @category, @title, @detail, @advice,
         @attacker_ip, @count, @first_seen, @last_seen, @blocked, @status, @resolved_at, @acknowledged_at)
       ON CONFLICT(id) DO UPDATE SET scope = excluded.scope, source = excluded.source, severity = excluded.severity,
         category = excluded.category, title = excluded.title, detail = excluded.detail, advice = excluded.advice,
         attacker_ip = excluded.attacker_ip, count = excluded.count, first_seen = excluded.first_seen,
         last_seen = excluded.last_seen, blocked = excluded.blocked, status = excluded.status,
         resolved_at = excluded.resolved_at, acknowledged_at = excluded.acknowledged_at`,
    );

    const reported = new Set<string>();
    this.db.transaction(() => {
      for (const draft of drafts) {
        const id = `${targetId}:${draft.key}`;
        reported.add(id);
        const before = existing.get(id);
        const acknowledged = before?.acknowledged_at ?? null;
        // Marked as expected and nothing new since: stays quiet.
        if (
          before &&
          before.status === 'resolved' &&
          acknowledged !== null &&
          draft.lastSeen <= acknowledged
        )
          continue;
        const reopening = !before || before.status === 'resolved';
        const row: Row = {
          id,
          target_id: targetId,
          scope: draft.scope,
          source: draft.source,
          severity: draft.severity,
          category: draft.category,
          title: draft.title,
          detail: draft.detail,
          advice: draft.advice,
          attacker_ip: draft.attackerIp,
          count: draft.count,
          first_seen: reopening ? draft.firstSeen : Math.min(before.first_seen, draft.firstSeen),
          last_seen: Math.max(draft.lastSeen, before && !reopening ? before.last_seen : 0),
          blocked: draft.blocked === null ? null : draft.blocked ? 1 : 0,
          status: 'open',
          resolved_at: null,
          acknowledged_at: reopening ? null : acknowledged,
        };
        if (!reopening && sameContent(before, row)) continue;
        upsert.run(row);
        result.changed = true;
        if (reopening) result.opened.push(toFinding(row));
        else if (SEVERITY_RANK[row.severity] > SEVERITY_RANK[before.severity])
          result.escalated.push(toFinding(row));
      }
      for (const row of existing.values()) {
        if (row.status !== 'open' || reported.has(row.id)) continue;
        if (!row.scope.split('+').some((scope) => checkedScopes.includes(scope))) continue;
        const resolved: Row = { ...row, status: 'resolved', resolved_at: now };
        upsert.run(resolved);
        result.changed = true;
        result.resolved.push(toFinding(resolved));
      }
    })();
    return result;
  }

  /** Remembers that an alert went out (survives restarts, so the end is reported too). */
  markAlerted(id: string, alerted: boolean): void {
    this.db.prepare('UPDATE threat_findings SET alerted = ? WHERE id = ?').run(alerted ? 1 : 0, id);
  }

  wasAlerted(id: string): boolean {
    const row = this.db.prepare('SELECT alerted FROM threat_findings WHERE id = ?').get(id) as
      { alerted: number } | undefined;
    return row?.alerted === 1;
  }

  /** "Mark as expected": resolved now, and reopened only by newer activity. */
  acknowledge(id: string, now: number): ThreatFinding | null {
    const row = this.db.prepare('SELECT * FROM threat_findings WHERE id = ?').get(id) as
      Row | undefined;
    if (!row) return null;
    const updated: Row = { ...row, status: 'resolved', resolved_at: now, acknowledged_at: now };
    this.db
      .prepare(
        'UPDATE threat_findings SET status = ?, resolved_at = ?, acknowledged_at = ? WHERE id = ?',
      )
      .run('resolved', now, now, id);
    return toFinding(updated);
  }

  /** Open findings, and resolved ones since `since`. */
  list(since: number): ThreatFinding[] {
    return (
      this.db
        .prepare(
          "SELECT * FROM threat_findings WHERE status = 'open' OR resolved_at >= ? ORDER BY last_seen DESC",
        )
        .all(since) as Row[]
    ).map(toFinding);
  }

  /** Every finding active at some point in [since, until], for the timeline. */
  between(since: number, until: number): ThreatFinding[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM threat_findings
           WHERE first_seen <= ? AND (status = 'open' OR resolved_at >= ?) ORDER BY first_seen`,
        )
        .all(until, since) as Row[]
    ).map(toFinding);
  }

  /** Removes findings of targets that no longer exist and old resolved ones. */
  prune(olderThan: number, liveTargets?: ReadonlySet<string>): void {
    this.db
      .prepare("DELETE FROM threat_findings WHERE status = 'resolved' AND resolved_at < ?")
      .run(olderThan);
    if (liveTargets) {
      for (const row of this.db.prepare('SELECT DISTINCT target_id FROM threat_findings').all() as {
        target_id: string;
      }[]) {
        if (!liveTargets.has(row.target_id)) {
          this.db.prepare('DELETE FROM threat_findings WHERE target_id = ?').run(row.target_id);
          this.db.prepare('DELETE FROM threat_baselines WHERE target_id = ?').run(row.target_id);
        }
      }
    }
  }

  /** Small JSON values kept next to the baselines (RDAP answers, package lists…). */
  getJson<T>(key: string): T | null {
    const row = this.db
      .prepare('SELECT data FROM threat_baselines WHERE target_id = ?')
      .get(`cache:${key}`) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown, now: number): void {
    this.saveRaw(`cache:${key}`, JSON.stringify(value), now);
  }

  private saveRaw(id: string, data: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO threat_baselines (target_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(target_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(id, data, now);
  }

  baseline(targetId: string): HostBaseline | null {
    const row = this.db
      .prepare('SELECT data FROM threat_baselines WHERE target_id = ?')
      .get(targetId) as { data: string } | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.data) as HostBaseline;
    } catch {
      return null;
    }
  }

  saveBaseline(targetId: string, baseline: HostBaseline, now: number): void {
    this.db
      .prepare(
        `INSERT INTO threat_baselines (target_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(target_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      )
      .run(targetId, JSON.stringify(baseline), now);
  }
}

/**
 * Nothing worth writing changed. `last_seen` alone does not count: checks
 * that describe a state (a public bucket, a new account) see it "now" on
 * every round, while a real attack also raises its count.
 */
function sameContent(before: Row, after: Row): boolean {
  return (
    before.severity === after.severity &&
    before.count === after.count &&
    before.blocked === after.blocked &&
    before.title === after.title &&
    before.scope === after.scope &&
    before.source === after.source
  );
}
