import { isMaintenance, sortFindings } from '@app/shared';
import { useMemo } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { useUiStore } from './ui-store';

/** Open attacks and exposures on one building, in its HUD; nothing when there are none. */
export function HudThreats({ targetId }: { targetId: string }) {
  const threats = useFleetStore((store) => store.threats);
  const mine = useMemo(
    () =>
      sortFindings(
        threats.filter((finding) => finding.targetId === targetId && !isMaintenance(finding)),
      ),
    [threats, targetId],
  );
  if (mine.length === 0) return null;
  return (
    <section className="hud-threats" aria-label="Security findings">
      <h3>Security</h3>
      <ul>
        {mine.slice(0, 4).map((finding) => (
          <li key={finding.id}>
            <span className={`security-chip is-${finding.severity}`}>{finding.severity}</span>
            <span>{finding.title}</span>
            {finding.blocked === true && <span className="security-badge is-blocked">blocked</span>}
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => useUiStore.getState().setSecurityOpen(true, targetId)}>
        {mine.length > 4 ? `All ${mine.length} findings` : 'Details'} <kbd>S</kbd>
      </button>
    </section>
  );
}
