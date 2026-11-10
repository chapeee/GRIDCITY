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
  | 'agent_stopped';

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
  }

  /** Never pass secrets in `detail`. */
  append(kind: AuditKind, hostId: string | null = null, detail: string | null = null): void {
    this.insert.run(this.now(), kind, hostId, detail);
  }

  /** Newest first. */
  recent(limit = 200): AuditEntry[] {
    return this.selectRecent.all(Math.max(1, Math.min(limit, 5000))) as AuditEntry[];
  }
}
