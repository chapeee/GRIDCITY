import {
  BUILTIN_RUNBOOKS,
  RUNBOOKS_FOR_FINDING,
  type ThreatFinding,
  type ThreatsView,
} from '@app/shared';
import { useEffect, useState } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { threatsApi, type FixOption } from '../data/threats-api';
import { useUiStore } from './ui-store';

/**
 * Under an open finding: the runbooks that help look into it (servers), and
 * the fixes GRIDCITY can apply. A fix shows exactly what it runs and needs a
 * second click; the result is shown and written to the audit log.
 */
export function FindingActions({
  finding,
  onView,
}: {
  finding: ThreatFinding;
  onView?: (view: ThreatsView) => void;
}) {
  const isHost = useFleetStore((store) => store.hosts.some((h) => h.id === finding.targetId));
  const [fixes, setFixes] = useState<FixOption[]>([]);
  const [confirming, setConfirming] = useState<FixOption | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string; output: string } | null>(
    null,
  );

  useEffect(() => {
    if (finding.status !== 'open') return;
    let cancelled = false;
    threatsApi.fixes(finding.id).then(
      (result) => {
        if (!cancelled) setFixes(result.fixes);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [finding.id, finding.status, finding.blocked, finding.severity]);

  // A finding that ended has nothing left to fix.
  const shownFixes = finding.status === 'open' ? fixes : [];
  const runbooks = isHost
    ? (RUNBOOKS_FOR_FINDING[finding.category] ?? [])
        .map((id) => BUILTIN_RUNBOOKS.find((runbook) => runbook.id === id))
        .filter((runbook) => runbook !== undefined)
    : [];

  const run = async (option: FixOption) => {
    setBusy(true);
    setOutcome(null);
    try {
      const result = await threatsApi.fix(finding.id, option.id);
      setOutcome(result.outcome);
      onView?.(result.view);
    } catch (reason) {
      setOutcome({ ok: false, message: (reason as Error).message, output: '' });
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  if (runbooks.length === 0 && shownFixes.length === 0 && !outcome) return null;
  return (
    <div className="finding-actions">
      {runbooks.length > 0 && (
        <div className="finding-actions-row">
          <span className="finding-actions-label">Look into it</span>
          {runbooks.map((runbook) => (
            <button
              key={runbook.id}
              type="button"
              title={runbook.description ?? undefined}
              onClick={() => useUiStore.getState().openRunbooks([finding.targetId], runbook.id)}
            >
              {runbook.name}
            </button>
          ))}
        </div>
      )}
      {shownFixes.length > 0 && !confirming && (
        <div className="finding-actions-row">
          <span className="finding-actions-label">Fix</span>
          {shownFixes.map((option) => (
            <button
              key={option.id}
              type="button"
              className="button-danger"
              onClick={() => setConfirming(option)}
            >
              {option.label}…
            </button>
          ))}
        </div>
      )}
      {confirming && (
        <div className="finding-confirm">
          <p>
            <strong>{confirming.label}</strong>: {confirming.description}
          </p>
          <pre>{confirming.preview}</pre>
          <div className="alerts-actions">
            <button
              type="button"
              className="button-danger"
              disabled={busy}
              onClick={() => void run(confirming)}
            >
              {busy ? 'Running…' : 'Yes, run it'}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {outcome && (
        <div className={outcome.ok ? 'settings-saved' : 'audit-error'} role="status">
          <p>{outcome.message}</p>
          {outcome.output && !outcome.ok && <pre className="finding-output">{outcome.output}</pre>}
        </div>
      )}
    </div>
  );
}
