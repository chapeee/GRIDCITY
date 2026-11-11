import { rootCauses, type DoctorReport, type Fix } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyDoctorFix,
  diagnose,
  fetchDoctorOverview,
  type DoctorOverview,
} from '../data/doctor-api';
import { useFleetStore } from '../data/fleet-store';
import { useReplayStore } from '../data/replay-store';
import { useServerLink } from '../data/server-link';
import { DoctorReportView } from './DoctorReportView';
import { StatusDot } from './StatusDot';
import { useUiStore } from './ui-store';

/**
 * The Doctor panel. With a target: a full diagnosis of one server or
 * resource (ladder, causes, proven fixes; a proven settings fix applies with
 * one click, after one more real test). Without: the machine's own health,
 * the likely root causes of whatever is failing, and every target in trouble.
 */
export function DoctorPanel() {
  const target = useUiStore((store) => store.doctorTarget);
  return (
    <AnimatePresence>
      {target !== undefined && <DoctorPanelBody key={target ?? '*'} target={target} />}
    </AnimatePresence>
  );
}

function DoctorPanelBody({ target }: { target: string | null }) {
  const hosts = useFleetStore((store) => store.hosts);
  const resources = useFleetStore((store) => store.resources);
  const dataMode = useFleetStore((store) => store.dataMode);
  const live = useServerLink((store) => store.source) === 'server' && dataMode === 'real';
  const close = () => useUiStore.getState().openDoctor(undefined);
  const nameOf = useCallback(
    (id: string) =>
      hosts.find((h) => h.id === id)?.name ?? resources.find((r) => r.id === id)?.name ?? id,
    [hosts, resources],
  );

  return (
    <motion.section
      className="doctor-panel"
      aria-label="Doctor"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 12 }}
      transition={{ duration: 0.18 }}
    >
      <header className="audit-header">
        <h2>{target ? `Doctor · ${nameOf(target)}` : 'Doctor'}</h2>
        <div className="audit-actions">
          {target && (
            <button type="button" onClick={() => useUiStore.getState().openDoctor(null)}>
              Check everything
            </button>
          )}
          <button type="button" onClick={close}>
            Close <kbd>Esc</kbd>
          </button>
        </div>
      </header>
      {!live && (
        <p className="audit-note">
          DEMO DATA: the Doctor diagnoses real servers and resources. Below is what it can infer
          from the demo city alone.
        </p>
      )}
      {target ? (
        <TargetDiagnosis target={target} live={live} />
      ) : (
        <Overview live={live} nameOf={nameOf} />
      )}
    </motion.section>
  );
}

function TargetDiagnosis({ target, live }: { target: string; live: boolean }) {
  const isHost = useFleetStore((store) => store.hosts.some((h) => h.id === target));
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [applied, setApplied] = useState<string | null>(null);

  const run = useCallback(() => {
    if (!live) return;
    setRunning(true);
    setError(null);
    diagnose(target, isHost ? 'host' : 'resource')
      .then(setReport, (reason: Error) => setError(reason.message))
      .finally(() => setRunning(false));
  }, [target, isHost, live]);

  useEffect(() => {
    // Deferred one tick so the effect itself sets no state (the panel opens first).
    const timer = setTimeout(run, 0);
    return () => clearTimeout(timer);
  }, [run]);

  const apply = async (fix: Fix) => {
    if (!fix.patch) return;
    setApplying(fix.id);
    setError(null);
    try {
      await applyDoctorFix(target, fix.patch);
      setApplied(`${fix.label}: proven again and saved. The city reconnects with it now.`);
      run();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setApplying(null);
    }
  };

  if (!live)
    return <p className="settings-help">Start the app with your real servers to run the Doctor.</p>;
  return (
    <>
      {running && (
        <p className="doctor-running">
          Checking DNS, the port and TLS, then trying likely fixes against the real target…
        </p>
      )}
      {error && <p className="audit-error">{error}</p>}
      {applied && <p className="settings-saved">{applied}</p>}
      {report && !running && (
        <DoctorReportView
          report={report}
          onApply={isHost ? undefined : apply}
          applying={applying}
        />
      )}
      {report && !running && (
        <footer className="hud-actions">
          <button type="button" onClick={run}>
            Diagnose again
          </button>
        </footer>
      )}
    </>
  );
}

function Overview({ live, nameOf }: { live: boolean; nameOf(id: string): string }) {
  const links = useFleetStore((store) => store.links);
  const states = useFleetStore((store) => store.states);
  const resourceStates = useFleetStore((store) => store.resourceStates);
  const [overview, setOverview] = useState<DoctorOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!live) return;
    fetchDoctorOverview().then(setOverview, (reason: Error) => setError(reason.message));
  }, [live]);

  const failing = useMemo(
    () =>
      new Set(
        [
          ...Object.values(states).map((s) => [s.hostId, s.status] as const),
          ...Object.values(resourceStates).map((s) => [s.resourceId, s.status] as const),
        ]
          .filter(([, status]) => status === 'offline' || status === 'degraded')
          .map(([id]) => id),
      ),
    [states, resourceStates],
  );
  const roots = useMemo(() => rootCauses(links, failing), [links, failing]);
  const troubles = useMemo(() => {
    if (overview) return overview.troubles;
    return [
      ...Object.values(states).map((s) => ({
        id: s.hostId,
        status: s.stale ? 'stale' : s.status,
        reason: s.statusReason,
        hint: s.hint ?? null,
        kind: 'server',
      })),
      ...Object.values(resourceStates).map((s) => ({
        id: s.resourceId,
        status: s.stale ? 'stale' : s.status,
        reason: s.statusReason,
        hint: s.hint ?? null,
        kind: 'resource',
      })),
    ].filter((t) => t.status !== 'online');
  }, [overview, states, resourceStates]);

  return (
    <>
      {error && <p className="audit-error">{error}</p>}
      {overview && (
        <section className="doctor-section">
          <h3>This machine</h3>
          {overview.environment.length === 0 ? (
            <p className="doctor-ok">
              Node, the data folder, disk space, ssh-agent and known_hosts look fine.
            </p>
          ) : (
            <DoctorReportView
              report={{
                targetId: null,
                targetName: 'machine',
                ok: false,
                error: null,
                ladder: [],
                diagnoses: overview.environment,
                at: 0,
              }}
            />
          )}
        </section>
      )}

      {roots.length > 0 && (
        <section className="doctor-section">
          <h3>Likely root causes</h3>
          <ul className="doctor-roots">
            {roots.map((root) => (
              <li key={root.id}>
                <button
                  type="button"
                  className="hud-link"
                  onClick={() => useUiStore.getState().focusHost(root.id)}
                >
                  {nameOf(root.id)}
                </button>
                {root.explains.length > 0 ? (
                  <span>
                    {' '}
                    explains {root.explains.length} other failure
                    {root.explains.length === 1 ? '' : 's'}: {root.explains.map(nameOf).join(', ')}
                  </span>
                ) : (
                  <span> fails on its own</span>
                )}
                {live && (
                  <button type="button" onClick={() => useUiStore.getState().openDoctor(root.id)}>
                    Diagnose
                  </button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="doctor-section">
        <h3>Needs attention</h3>
        {troubles.length === 0 ? (
          <p className="doctor-ok">Everything is online.</p>
        ) : (
          <ul className="doctor-troubles">
            {troubles.map((trouble) => (
              <li key={trouble.id}>
                <StatusDot
                  status={trouble.status === 'stale' ? 'online' : (trouble.status as 'online')}
                  stale={trouble.status === 'stale'}
                />
                <button
                  type="button"
                  className="hud-link"
                  onClick={() => useUiStore.getState().focusHost(trouble.id)}
                >
                  {nameOf(trouble.id)}
                </button>
                <span className="doctor-trouble-reason">
                  {trouble.hint
                    ? `${trouble.hint.title}${trouble.hint.action ? ` → ${trouble.hint.action}` : ''}`
                    : (trouble.reason ?? trouble.status)}
                </span>
                {live && trouble.status === 'offline' && (
                  <button
                    type="button"
                    onClick={() => useUiStore.getState().openDoctor(trouble.id)}
                  >
                    Diagnose
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/**
 * Shown above the city when two or more things fail at once: the failure
 * that explains the others, so the eye goes to the cause, not the symptoms.
 */
export function IncidentBanner() {
  const replaying = useReplayStore((store) => store.active);
  const links = useFleetStore((store) => store.links);
  const states = useFleetStore((store) => store.states);
  const resourceStates = useFleetStore((store) => store.resourceStates);
  const hosts = useFleetStore((store) => store.hosts);
  const resources = useFleetStore((store) => store.resources);
  const root = useMemo(() => {
    const failing = new Set(
      [
        ...Object.values(states).map((s) => [s.hostId, s.status] as const),
        ...Object.values(resourceStates).map((s) => [s.resourceId, s.status] as const),
      ]
        .filter(([, status]) => status === 'offline' || status === 'degraded')
        .map(([id]) => id),
    );
    return rootCauses(links, failing).find((r) => r.explains.length > 0) ?? null;
  }, [links, states, resourceStates]);
  if (!root || replaying) return null; // live analysis; hidden while showing the past
  const nameOf = (id: string) =>
    hosts.find((h) => h.id === id)?.name ?? resources.find((r) => r.id === id)?.name ?? id;
  return (
    <button
      type="button"
      className="incident-banner"
      onClick={() => useUiStore.getState().openDoctor(null)}
    >
      <span className="incident-label">LIKELY ROOT CAUSE</span> {nameOf(root.id)} · explains{' '}
      {root.explains.length} other failure{root.explains.length === 1 ? '' : 's'} · open the Doctor
    </button>
  );
}
