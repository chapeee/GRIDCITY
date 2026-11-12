import {
  isMaintenance,
  type ThreatCoverage,
  type ThreatFinding,
  type ThreatSeverity,
  type ThreatsView,
} from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useFleetStore } from '../data/fleet-store';
import { threatsApi } from '../data/threats-api';
import { FindingActions } from './FindingActions';
import { useUiStore } from './ui-store';

const SOURCE_LABEL: Record<ThreatFinding['source'], string> = {
  builtin: 'GRIDCITY',
  crowdsec: 'CrowdSec',
  fail2ban: 'Fail2ban',
  wazuh: 'Wazuh',
  falco: 'Falco',
  guardduty: 'GuardDuty',
};

/** Findings that describe a state the user may have created on purpose. */
const CAN_EXPECT =
  /:(user|port|new-login|no-public-access-block|publicly-accessible|public-bucket):/;

function ago(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  return new Date(at).toLocaleString();
}

/**
 * Security: attacks and exposures found on every server and resource, worst
 * first, with what was seen, who did it, whether it is blocked and what to
 * do. Also says, per target, which checks could not run and why.
 */
export function SecurityPanel() {
  const open = useUiStore((store) => store.securityOpen);
  // Opened from a building: only that building. null: every server and resource.
  const targetId = useUiStore((store) => store.securityTarget);
  const live = useFleetStore((store) => store.threats);
  const names = useFleetStore(
    useShallow((store) => ({ hosts: store.hosts, resources: store.resources })),
  );
  const [view, setView] = useState<ThreatsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [showResolved, setShowResolved] = useState(false);

  const reload = useCallback(() => {
    threatsApi.load().then(
      (loaded) => {
        setView(loaded);
        setError(null);
      },
      (reason: unknown) => setError((reason as Error).message),
    );
  }, []);

  // Reload whenever the live list changes (an attack starts, grows or ends).
  useEffect(() => {
    if (open) reload();
  }, [open, live, reload]);

  const nameOf = (id: string) =>
    names.hosts.find((h) => h.id === id)?.name ??
    names.resources.find((r) => r.id === id)?.name ??
    id;

  const checkNow = async () => {
    setChecking(true);
    try {
      setView(await threatsApi.checkNow());
      setError(null);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setChecking(false);
    }
  };

  const allFindings = (view?.findings ?? []).filter((finding) => !isMaintenance(finding));
  const findings = targetId
    ? allFindings.filter((finding) => finding.targetId === targetId)
    : allFindings;
  const coverage = (view?.coverage ?? []).filter(
    (entry) => !targetId || entry.targetId === targetId,
  );
  const elsewhere = targetId
    ? allFindings.filter((f) => f.status === 'open' && f.targetId !== targetId).length
    : 0;
  const openFindings = findings.filter((f) => f.status === 'open');
  const resolved = findings.filter((f) => f.status === 'resolved');
  const counts = (['critical', 'high', 'medium', 'low'] as ThreatSeverity[]).map((severity) => ({
    severity,
    count: openFindings.filter((f) => f.severity === severity).length,
  }));

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="security-panel"
          aria-label={targetId ? `Security of ${nameOf(targetId)}` : 'Security'}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <header className="audit-header">
            <h2>{targetId ? `Security · ${nameOf(targetId)}` : 'Security'}</h2>
            <div className="audit-actions">
              {targetId && (
                <button
                  type="button"
                  onClick={() => useUiStore.getState().setSecurityOpen(true, null)}
                  title="Attacks and exposures on every server and resource"
                >
                  All servers{elsewhere > 0 ? ` (${elsewhere} more)` : ''}
                </button>
              )}
              {!view?.demo && (
                <button type="button" disabled={checking} onClick={() => void checkNow()}>
                  {checking ? 'Checking…' : 'Check now'}
                </button>
              )}
              <button type="button" onClick={() => useUiStore.getState().setSecurityOpen(false)}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
          </header>

          {view?.demo ? (
            <p className="audit-note">
              DEMO DATA: these attacks and exposures are simulated. On your servers they come from
              read-only checks and CrowdSec or Fail2ban.
            </p>
          ) : (
            <p className="security-intro">
              Attacks and exposures seen by GRIDCITY&apos;s read-only checks and by CrowdSec or
              Fail2ban where installed. These catch known patterns, not every attack: for deeper
              detection install CrowdSec, Wazuh or Falco on your servers.
            </p>
          )}
          {error && <p className="audit-error">{error}</p>}

          <div className="security-summary" role="status">
            {openFindings.length === 0 ? (
              <span className="security-clear">
                No open attacks or exposures{targetId ? ` on ${nameOf(targetId)}` : ''}.
              </span>
            ) : (
              counts
                .filter((entry) => entry.count > 0)
                .map((entry) => (
                  <span key={entry.severity} className={`security-chip is-${entry.severity}`}>
                    {entry.count} {entry.severity}
                  </span>
                ))
            )}
          </div>

          <ul className="security-list">
            {openFindings.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                targetName={nameOf(finding.targetId)}
                onView={setView}
                onError={setError}
              />
            ))}
          </ul>

          {resolved.length > 0 && (
            <div className="security-resolved">
              <button
                type="button"
                className="security-toggle"
                onClick={() => setShowResolved((v) => !v)}
              >
                {showResolved ? '▾' : '▸'} {resolved.length} ended or marked as expected
              </button>
              {showResolved && (
                <ul className="security-list is-resolved">
                  {resolved.map((finding) => (
                    <FindingRow
                      key={finding.id}
                      finding={finding}
                      targetName={nameOf(finding.targetId)}
                    />
                  ))}
                </ul>
              )}
            </div>
          )}

          {coverage.length > 0 && (
            <Coverage coverage={coverage} nameOf={nameOf} detailed={targetId !== null} />
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function FindingRow({
  finding,
  targetName,
  onView,
  onError,
}: {
  finding: ThreatFinding;
  targetName: string;
  onView?: (view: ThreatsView) => void;
  onError?: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(finding.severity === 'critical');
  const resolved = finding.status === 'resolved';
  return (
    <li className={`security-row is-${finding.severity}${resolved ? ' is-resolved' : ''}`}>
      <button
        type="button"
        className="security-row-head"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span className={`security-chip is-${finding.severity}`}>{finding.severity}</span>
        <strong>{finding.title}</strong>
        <span className="security-meta">
          {targetName} · {SOURCE_LABEL[finding.source]} ·{' '}
          {resolved
            ? `ended ${ago(finding.resolvedAt ?? finding.lastSeen)}`
            : ago(finding.lastSeen)}
        </span>
        {finding.blocked === true && <span className="security-badge is-blocked">blocked</span>}
        {finding.blocked === false && <span className="security-badge is-open">not blocked</span>}
      </button>
      {expanded && (
        <div className="security-body">
          <p>{finding.detail}</p>
          <dl className="security-facts">
            {finding.attackerIp && (
              <>
                <dt>From</dt>
                <dd>{finding.attackerIp}</dd>
              </>
            )}
            {finding.count > 1 && (
              <>
                <dt>Events</dt>
                <dd>{finding.count.toLocaleString()}</dd>
              </>
            )}
            <dt>First seen</dt>
            <dd>{new Date(finding.firstSeen).toLocaleString()}</dd>
            <dt>Last seen</dt>
            <dd>{new Date(finding.lastSeen).toLocaleString()}</dd>
          </dl>
          <p className="security-advice">
            <span>What to do</span> {finding.advice}
          </p>
          {!resolved && <FindingActions finding={finding} onView={onView} />}
          <div className="alerts-actions">
            <button
              type="button"
              onClick={() => {
                useUiStore.getState().showBuilding(finding.targetId);
              }}
            >
              Show building
            </button>
            <button
              type="button"
              onClick={() => useUiStore.getState().openHistory(finding.targetId)}
            >
              History
            </button>
            <button
              type="button"
              onClick={() =>
                useUiStore
                  .getState()
                  .openIncident({ at: finding.firstSeen, targetId: finding.targetId })
              }
            >
              What happened then
            </button>
            {!resolved && onView && CAN_EXPECT.test(`${finding.id}:`) && (
              <button
                type="button"
                onClick={() => {
                  threatsApi
                    .acknowledge(finding.id)
                    .then(onView, (reason: unknown) => onError?.((reason as Error).message));
                }}
              >
                Mark as expected
              </button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function Coverage({
  coverage,
  nameOf,
  detailed,
}: {
  coverage: ThreatCoverage[];
  nameOf: (id: string) => string;
  /** One building: list its checks by name, even when it is a resource. */
  detailed: boolean;
}) {
  // Servers: every check on its own line. Resources: one summary line, plus any that could not be checked.
  const servers = coverage.filter(
    (entry) => detailed || entry.checks.some((check) => check.name === 'SSH logins'),
  );
  const resources = coverage.filter((entry) => !servers.includes(entry));
  const checkedResources = resources.filter((entry) => entry.checks.every((check) => check.ok));
  const failedResources = resources.filter((entry) => entry.checks.some((check) => !check.ok));
  const kinds = new Map<string, number>();
  for (const entry of checkedResources) {
    for (const check of entry.checks) kinds.set(check.name, (kinds.get(check.name) ?? 0) + 1);
  }
  return (
    <div className="security-coverage">
      <h3>What was checked</h3>
      <ul>
        {servers.map((entry) => (
          <li key={entry.targetId}>
            <strong>{nameOf(entry.targetId)}</strong>
            <span className="security-checks">
              {entry.checks.map((check) => (
                <span
                  key={check.name}
                  className={`security-check${check.ok ? ' is-ok' : check.note === 'not installed' ? ' is-absent' : ' is-gap'}`}
                  title={check.note ?? undefined}
                >
                  {check.ok
                    ? 'checked'
                    : check.note === 'not installed'
                      ? 'not installed'
                      : 'not checked'}
                  : {check.name}
                </span>
              ))}
            </span>
            {entry.checks
              .filter((check) => !check.ok && check.note && check.note !== 'not installed')
              .map((check) => (
                <span key={check.name} className="security-gap">
                  {check.name}: {check.note}
                </span>
              ))}
          </li>
        ))}
        {checkedResources.length > 0 && (
          <li>
            <strong>
              {checkedResources.length} resource{checkedResources.length === 1 ? '' : 's'} checked
            </strong>
            <span className="security-checks">
              {[...kinds].map(([name, count]) => (
                <span key={name} className="security-check is-ok">
                  {name.toLowerCase()} ({count})
                </span>
              ))}
            </span>
          </li>
        )}
        {failedResources.map((entry) => (
          <li key={entry.targetId}>
            <strong>{nameOf(entry.targetId)}</strong>
            {entry.checks
              .filter((check) => !check.ok)
              .map((check) => (
                <span key={check.name} className="security-gap">
                  not checked: {check.note ?? check.name}
                </span>
              ))}
          </li>
        ))}
      </ul>
      {servers.some((entry) => entry.checks.some((check) => check.note === 'not installed')) && (
        <p className="settings-help">
          CrowdSec (free, open source) blocks brute force and scans; where it is installed GRIDCITY
          shows what it catches.
        </p>
      )}
    </div>
  );
}
