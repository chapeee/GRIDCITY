import type { AuditEntry } from '../storage/audit-log';
import type { HostStatus, ThreatFinding } from '@app/shared';

/** One line of the incident timeline. */
export interface IncidentEvent {
  at: number;
  kind: 'status' | 'finding' | 'finding-ended' | 'command' | 'change' | 'alert' | 'connection';
  targetId: string | null;
  title: string;
  detail: string | null;
  /** offline/critical: alert; degraded/high/medium: warning; recovered: ok. */
  tone: 'alert' | 'warning' | 'ok' | 'neutral';
}

const COMMAND_KINDS = new Set([
  'agent_command_run',
  'agent_command_denied',
  'runbook_run',
  'fleet_command_run',
  'threat_fixed',
  'terminal_opened',
  'terminal_closed',
]);
const CHANGE_KINDS = new Set([
  'settings_changed',
  'host_added',
  'hosts_imported',
  'host_edited',
  'host_removed',
  'resource_added',
  'resource_edited',
  'resource_removed',
  'resource_changed',
  'threat_acknowledged',
  'key_created',
  'key_imported',
  'key_installed',
  'host_key_trusted',
]);
const CONNECTION_KINDS = new Set([
  'connection_opened',
  'connection_lost',
  'connection_failed',
  'host_key_refused',
  'resource_unreachable',
  'resource_reachable',
]);
/** Already shown from their own sources (status events and findings). */
const SKIPPED_KINDS = new Set(['threat_opened', 'threat_resolved']);

/**
 * Everything around a moment, in order: status changes, attacks and other
 * findings starting and ending, commands people and AI agents ran, changes to
 * settings and resources, connections and alerts. Built from what GRIDCITY
 * already records; nothing new is collected for it.
 */
export function buildIncidentTimeline(input: {
  since: number;
  until: number;
  targetId: string | null;
  statuses: { targetId: string; at: number; status: HostStatus; reason: string | null }[];
  findings: ThreatFinding[];
  audit: AuditEntry[];
}): IncidentEvent[] {
  const { since, until, targetId } = input;
  const mine = (id: string | null) => targetId === null || id === targetId;
  const events: IncidentEvent[] = [];
  for (const s of input.statuses) {
    if (!mine(s.targetId)) continue;
    events.push({
      at: s.at,
      kind: 'status',
      targetId: s.targetId,
      title: s.status === 'online' ? 'back online' : s.status,
      detail: s.reason,
      tone:
        s.status === 'offline'
          ? 'alert'
          : s.status === 'degraded'
            ? 'warning'
            : s.status === 'online'
              ? 'ok'
              : 'neutral',
    });
  }
  for (const f of input.findings) {
    if (!mine(f.targetId)) continue;
    if (f.firstSeen >= since && f.firstSeen <= until) {
      events.push({
        at: f.firstSeen,
        kind: 'finding',
        targetId: f.targetId,
        title: f.title,
        detail: f.attackerIp ? `${f.severity} · from ${f.attackerIp}` : f.severity,
        tone:
          f.severity === 'critical' || f.severity === 'high'
            ? 'alert'
            : f.severity === 'medium'
              ? 'warning'
              : 'neutral',
      });
    }
    if (f.resolvedAt !== null && f.resolvedAt >= since && f.resolvedAt <= until) {
      events.push({
        at: f.resolvedAt,
        kind: 'finding-ended',
        targetId: f.targetId,
        title: `ended: ${f.title}`,
        detail: null,
        tone: 'ok',
      });
    }
  }
  for (const entry of input.audit) {
    if (SKIPPED_KINDS.has(entry.kind) || !mine(entry.hostId)) continue;
    const kind: IncidentEvent['kind'] = COMMAND_KINDS.has(entry.kind)
      ? 'command'
      : CHANGE_KINDS.has(entry.kind)
        ? 'change'
        : CONNECTION_KINDS.has(entry.kind)
          ? 'connection'
          : entry.kind === 'alert_sent'
            ? 'alert'
            : 'change';
    events.push({
      at: entry.at,
      kind,
      targetId: entry.hostId,
      title: entry.kind.replace(/_/g, ' '),
      detail: entry.detail,
      tone: /lost|failed|refused|unreachable|denied/.test(entry.kind) ? 'warning' : 'neutral',
    });
  }
  return events.sort((a, b) => a.at - b.at).slice(0, 1500);
}
