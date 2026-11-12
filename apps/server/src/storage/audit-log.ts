import type { AppDatabase } from './database';

/**
 * What the audit log records. Honest scope: terminal sessions are recorded
 * as opened/closed with host and time; the keystrokes and commands typed
 * inside a PTY are NOT captured (not reliably possible, and not claimed).
 */
export type AuditKind =
  | 'server_started'
  | 'server_stopped'
  | 'connection_opened'
  | 'connection_lost'
  | 'connection_failed'
  | 'host_key_refused'
  | 'hosts_imported'
  | 'host_added'
  | 'key_created'
  | 'key_imported'
  | 'host_key_trusted'
  | 'key_installed'
  | 'terminal_opened'
  | 'terminal_closed'
  // AI agents: every command they run on a server, with who allowed it.
  | 'agent_command_run'
  | 'agent_command_denied'
  | 'agent_started'
  | 'agent_stopped'
  // Databases, RDS and buckets: reachability transitions only.
  | 'resource_reachable'
  | 'resource_unreachable'
  // Settings and Edit (the change, never secrets).
  | 'settings_changed'
  | 'host_edited'
  | 'host_removed'
  | 'resource_added'
  | 'resource_edited'
  | 'resource_removed'
  // Changes made from the Manage view (rows, keys, documents, objects); never values or secrets.
  | 'resource_changed'
  // Runbooks and fleet-wide commands the user ran (command, hosts, exit codes).
  | 'runbook_run'
  | 'fleet_command_run'
  // Alerts sent to the webhook (what, never the URL).
  | 'alert_sent'
  // Attacks and exposures found, ended, or marked as expected by the user.
  | 'threat_opened'
  | 'threat_resolved'
  | 'threat_acknowledged'
  | 'threat_fixed'
  // Log searches across servers (the query, never the results).
  | 'logs_searched';

export interface AuditEntry {
  id: number;
  at: number;
  kind: AuditKind;
  hostId: string | null;
  detail: string | null;
}

/** Append-only audit trail (the table rejects UPDATE and DELETE). */
export class AuditLog {
  private readonly insert;
  private readonly selectRecent;
  private readonly selectBetween;

  constructor(
    db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {
    this.insert = db.prepare(
      'INSERT INTO audit_log (at, kind, host_id, detail) VALUES (?, ?, ?, ?)',
    );
    this.selectRecent = db.prepare(
      'SELECT id, at, kind, host_id AS hostId, detail FROM audit_log ORDER BY id DESC LIMIT ?',
    );
    this.selectBetween = db.prepare(
      'SELECT id, at, kind, host_id AS hostId, detail FROM audit_log WHERE at BETWEEN ? AND ? ORDER BY at LIMIT ?',
    );
  }

  /** Never pass secrets in `detail`. */
  append(kind: AuditKind, hostId: string | null = null, detail: string | null = null): void {
    this.insert.run(this.now(), kind, hostId, detail);
  }

  /** Oldest first, within a time range (the incident timeline). */
  between(since: number, until: number, limit = 1000): AuditEntry[] {
    return this.selectBetween.all(since, until, Math.max(1, Math.min(limit, 5000))) as AuditEntry[];
  }

  /** Newest first. */
  recent(limit = 200): AuditEntry[] {
    return this.selectRecent.all(Math.max(1, Math.min(limit, 5000))) as AuditEntry[];
  }
}
