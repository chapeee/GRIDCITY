import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useFleetStore } from '../data/fleet-store';
import { useServerLink } from '../data/server-link';
import { useUiStore } from './ui-store';

interface IncidentEvent {
  at: number;
  kind: 'status' | 'finding' | 'finding-ended' | 'command' | 'change' | 'alert' | 'connection';
  targetId: string | null;
  title: string;
  detail: string | null;
  tone: 'alert' | 'warning' | 'ok' | 'neutral';
}

const KIND_LABEL: Record<IncidentEvent['kind'], string> = {
  status: 'Status',
  finding: 'Found',
  'finding-ended': 'Ended',
  command: 'Command',
  change: 'Change',
  alert: 'Alert',
  connection: 'Connection',
};

const WINDOWS = [15, 30, 60, 180];

/**
 * What happened around a moment: status changes, attacks and other findings,
 * commands people and AI agents ran, changes and alerts, in order. Opened
 * from a finding, from time travel, or from history.
 */
export function IncidentPanel() {
  const incident = useUiStore((store) => store.incident);
  const names = useFleetStore(
    useShallow((store) => ({ hosts: store.hosts, resources: store.resources })),
  );
  const [minutes, setMinutes] = useState(30);
  const [onlyTarget, setOnlyTarget] = useState(true);
  const [events, setEvents] = useState<IncidentEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Opened again from a building: start with just that building, not the last choice.
  const [shown, setShown] = useState(incident);
  if (incident !== shown) {
    setShown(incident);
    setOnlyTarget(true);
  }

  useEffect(() => {
    if (!incident || useServerLink.getState().source !== 'server') return;
    let cancelled = false;
    const query = new URLSearchParams({
      at: String(Math.round(incident.at)),
      minutes: String(minutes),
    });
    if (incident.targetId && onlyTarget) query.set('target', incident.targetId);
    fetch(`/api/incident?${query.toString()}`, { credentials: 'same-origin' })
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(new Error(`incident failed (${response.status})`)),
      )
      .then(
        (body: { events: IncidentEvent[] }) => {
          if (cancelled) return;
          setEvents(body.events);
          setError(null);
        },
        (reason: unknown) => {
          if (!cancelled) setError((reason as Error).message);
        },
      );
    return () => {
      cancelled = true;
    };
  }, [incident, minutes, onlyTarget]);

  const nameOf = (id: string | null) =>
    id === null
      ? 'GRIDCITY'
      : (names.hosts.find((h) => h.id === id)?.name ??
        names.resources.find((r) => r.id === id)?.name ??
        id);
  const time = (at: number) =>
    new Date(at).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  return (
    <AnimatePresence>
      {incident && (
        <motion.section
          className="security-panel incident-panel"
          aria-label="What happened"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <header className="audit-header">
            <h2>
              What happened around {new Date(incident.at).toLocaleString()}
              {incident.targetId && onlyTarget ? ` · ${nameOf(incident.targetId)}` : ''}
            </h2>
            <div className="audit-actions">
              <button type="button" onClick={() => useUiStore.getState().openIncident(null)}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
          </header>
          <div className="incident-controls">
            <span className="segmented">
              {WINDOWS.map((value) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={minutes === value}
                  onClick={() => setMinutes(value)}
                >
                  ±{value < 60 ? `${value} min` : `${value / 60} h`}
                </button>
              ))}
            </span>
            {incident.targetId && (
              <label className="alerts-check">
                <input
                  type="checkbox"
                  checked={onlyTarget}
                  onChange={(event) => setOnlyTarget(event.target.checked)}
                />
                <span>only {nameOf(incident.targetId)}</span>
              </label>
            )}
          </div>
          {error && <p className="audit-error">{error}</p>}
          {events && events.length === 0 && (
            <p className="alerts-empty">Nothing was recorded in this window.</p>
          )}
          <ol className="incident-list">
            {events?.map((event, index) => (
              <li
                key={`${event.at}-${index}`}
                className={`incident-row is-${event.tone}${Math.abs(event.at - incident.at) < 60_000 ? ' is-moment' : ''}`}
              >
                <time>{time(event.at)}</time>
                <span className="incident-kind">{KIND_LABEL[event.kind]}</span>
                <button
                  type="button"
                  className="hud-link"
                  onClick={() =>
                    event.targetId && useUiStore.getState().showBuilding(event.targetId)
                  }
                >
                  {nameOf(event.targetId)}
                </button>
                <span className="incident-title">{event.title}</span>
                {event.detail && <span className="incident-detail">{event.detail}</span>}
              </li>
            ))}
          </ol>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
