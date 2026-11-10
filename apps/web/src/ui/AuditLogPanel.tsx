import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { fetchAuditLog, type AuditEntry } from '../data/server-api';
import { useServerLink } from '../data/server-link';
import { useUiStore } from './ui-store';

/** Human wording for each audit event kind. */
const KIND_LABEL: Record<string, string> = {
  server_started: 'server started',
  server_stopped: 'server stopped',
  connection_opened: 'connected',
  connection_lost: 'connection lost',
  connection_failed: 'connection failed',
  host_key_refused: 'host key refused',
  hosts_imported: 'hosts imported',
  host_added: 'host added',
  terminal_opened: 'terminal opened',
  terminal_closed: 'terminal closed',
  key_created: 'key created',
  key_imported: 'key imported',
  host_key_trusted: 'host key trusted',
  key_installed: 'key installed',
  agent_command_run: 'AI ran command',
  agent_command_denied: 'AI command denied',
  agent_started: 'agent started',
  agent_stopped: 'agent stopped',
  resource_reachable: 'resource reachable',
  resource_unreachable: 'resource unreachable',
};

/** Kinds that deserve the alert accent. */
const ALERT_KINDS = new Set([
  'host_key_refused',
  'connection_lost',
  'connection_failed',
  'agent_command_denied',
  'resource_unreachable',
]);

const formatTime = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

/**
 * The server's append-only audit trail: connections, host key refusals and
 * terminal sessions (opened/closed). It never contains what was typed in a
 * terminal, and says so.
 */
export function AuditLogPanel() {
  const open = useUiStore((store) => store.auditLogOpen);
  const source = useServerLink((store) => store.source);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchAuditLog(300)
      .then((loaded) => {
        setEntries(loaded);
        setError(null);
      })
      .catch((reason: unknown) => setError((reason as Error).message));
  }, []);

  useEffect(() => {
    if (open && source === 'server') load();
  }, [open, source, load]);

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="audit-panel"
          aria-label="Audit log"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <header className="audit-header">
            <h2>Audit log</h2>
            <div className="audit-actions">
              {source === 'server' && (
                <button type="button" onClick={load}>
                  Refresh
                </button>
              )}
              <button type="button" onClick={() => useUiStore.getState().setAuditLogOpen(false)}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
          </header>
          <p className="audit-note">
            Append-only. Records connections, host key refusals, when terminal sessions open and
            close, and every command an AI agent ran or was denied. Never what you type in a
            terminal.
          </p>
          {source !== 'server' && (
            <p className="audit-empty">
              This page runs demo data in the browser; the audit log lives on the server.
            </p>
          )}
          {error && <p className="audit-error">{error}</p>}
          {source === 'server' && entries?.length === 0 && (
            <p className="audit-empty">Nothing recorded yet.</p>
          )}
          {entries && entries.length > 0 && (
            <ol className="audit-list">
              {entries.map((entry) => (
                <li key={entry.id} className={ALERT_KINDS.has(entry.kind) ? 'is-alert' : undefined}>
                  <time dateTime={new Date(entry.at).toISOString()}>{formatTime(entry.at)}</time>
                  <span className="audit-kind">{KIND_LABEL[entry.kind] ?? entry.kind}</span>
                  <span className="audit-host">{entry.hostId ?? ''}</span>
                  <span className="audit-detail">{entry.detail ?? ''}</span>
                </li>
              ))}
            </ol>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}
