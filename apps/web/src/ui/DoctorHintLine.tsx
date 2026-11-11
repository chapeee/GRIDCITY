import { blastRadius, type DoctorHint } from '@app/shared';
import { useMemo } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { useUiStore } from './ui-store';

/** The Doctor's first guess for an offline building, with the way into a full diagnosis. */
export function DoctorHintLine({
  hint,
  targetId,
}: {
  hint: DoctorHint | null | undefined;
  targetId: string;
}) {
  if (!hint) return null;
  return (
    <div className="hud-doctor">
      <span className="hud-doctor-label">Doctor</span>
      <span>
        {hint.title}
        {hint.action ? ` → ${hint.action}` : ''}
      </span>
      <button type="button" onClick={() => useUiStore.getState().openDoctor(targetId)}>
        Diagnose <kbd>D</kbd>
      </button>
    </div>
  );
}

/** What goes down with this building: everything that depends on it, nearest first. */
export function BlastRadiusLine({ targetId }: { targetId: string }) {
  const links = useFleetStore((store) => store.links);
  const hosts = useFleetStore((store) => store.hosts);
  const resources = useFleetStore((store) => store.resources);
  const dependents = useMemo(() => blastRadius(links, targetId), [links, targetId]);
  if (dependents.length === 0) return null;
  const nameOf = (id: string) =>
    hosts.find((h) => h.id === id)?.name ?? resources.find((r) => r.id === id)?.name ?? id;
  return (
    <p className="hud-blast" title="Everything that depends on it, directly or through others">
      <span className="hud-blast-label">Blast radius</span> {dependents.length} depend on it:{' '}
      {dependents
        .slice(0, 5)
        .map((d) => nameOf(d.id))
        .join(', ')}
      {dependents.length > 5 ? ` +${dependents.length - 5}` : ''}
    </p>
  );
}
