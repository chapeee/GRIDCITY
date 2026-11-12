import { SEVERITY_RANK, type HistoryIncident, type ThreatFinding } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { fetchHistory } from '../data/history-api';
import { PLAY_SPEEDS, useReplayStore } from '../data/replay-store';
import { threatsApi } from '../data/threats-api';
import { useUiStore } from './ui-store';

const formatWhen = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * Time travel: drag through the recorded past and watch the whole city as it
 * was, or press play. Incidents are marked on the track; the arrows jump
 * between them. Everything is labelled REPLAY: this is never live data.
 */
export function TimelineBar() {
  const active = useReplayStore((store) => store.active);
  return <AnimatePresence>{active && <TimelineBody key="timeline" />}</AnimatePresence>;
}

function TimelineBody() {
  const { at, since, until, playing, speed, loading, error, frame } = useReplayStore();
  const { seek, setPlaying, setSpeed, close } = useReplayStore.getState();
  const hosts = useFleetStore((store) => store.hosts);
  const resources = useFleetStore((store) => store.resources);
  const [incidents, setIncidents] = useState<HistoryIncident[]>([]);
  const [threats, setThreats] = useState<ThreatFinding[]>([]);

  useEffect(() => {
    const days = Math.max(1, Math.ceil((until - since) / 86_400_000));
    fetchHistory(null, Math.min(days, 90))
      .then((history) => setIncidents(history.incidents))
      .catch(() => setIncidents([]));
    threatsApi
      .timeline(since, until)
      .then((result) =>
        // Medium and up: low findings would only add noise to the track.
        setThreats(
          result.findings.filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK.medium),
        ),
      )
      .catch(() => setThreats([]));
  }, [since, until]);

  // Playback: advance the clock in small steps; stop at the present.
  useEffect(() => {
    if (!playing) return;
    const stepMs = 100;
    const timer = setInterval(() => {
      const next = useReplayStore.getState().at + (PLAY_SPEEDS[speed]!.msPerSecond * stepMs) / 1000;
      if (next >= until) {
        seek(until);
        setPlaying(false);
      } else {
        seek(next);
      }
    }, stepMs);
    return () => clearInterval(timer);
  }, [playing, speed, until, seek, setPlaying]);

  const span = Math.max(1, until - since);
  const nameOf = (id: string) =>
    hosts.find((h) => h.id === id)?.name ?? resources.find((r) => r.id === id)?.name ?? id;
  const sorted = useMemo(
    () => [...incidents].sort((a, b) => a.startedAt - b.startedAt),
    [incidents],
  );
  const jump = (direction: 1 | -1) => {
    const target =
      direction > 0
        ? sorted.find((i) => i.startedAt > at + 1000)
        : [...sorted].reverse().find((i) => i.startedAt < at - 1000);
    if (target) seek(target.startedAt + 30_000);
  };
  const happening = sorted.filter((i) => at >= i.startedAt && at <= (i.endedAt ?? until));
  const attacked = threats.filter((f) => at >= f.firstSeen && at <= (f.resolvedAt ?? until));
  const measured = frame ? Object.keys(frame.hosts).length : 0;

  return (
    <motion.section
      className="timeline-bar"
      aria-label="Time travel"
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 16 }}
      transition={{ duration: 0.2 }}
    >
      <div className="timeline-head">
        <span className="timeline-badge">REPLAY</span>
        <strong className="timeline-when">{formatWhen(at)}</strong>
        <span className="timeline-meta">
          {loading
            ? 'loading…'
            : error
              ? error
              : `${measured} of ${hosts.length} servers measured then`}
        </span>
        <div className="timeline-controls">
          <button type="button" onClick={() => jump(-1)} title="Previous incident">
            ◀ incident
          </button>
          <button type="button" className="button-primary" onClick={() => setPlaying(!playing)}>
            {playing ? 'Pause' : 'Play'}
          </button>
          <button type="button" onClick={() => jump(1)} title="Next incident">
            incident ▶
          </button>
          <button
            type="button"
            onClick={() => setSpeed((speed + 1) % PLAY_SPEEDS.length)}
            title="Playback speed"
          >
            {PLAY_SPEEDS[speed]!.label}
          </button>
          <button
            type="button"
            onClick={() => {
              const ui = useUiStore.getState();
              ui.openIncident({ at, targetId: ui.focusedHostId });
            }}
            title="Everything recorded around this moment"
          >
            What happened
          </button>
          <button type="button" onClick={close}>
            Back to live <kbd>T</kbd>
          </button>
        </div>
      </div>
      <div className="timeline-track">
        {sorted.map((incident, index) => {
          const left = ((incident.startedAt - since) / span) * 100;
          const width = Math.max(
            0.3,
            (((incident.endedAt ?? until) - incident.startedAt) / span) * 100,
          );
          if (left > 100 || left + width < 0) return null;
          return (
            <span
              key={`${incident.targetId}-${incident.startedAt}-${index}`}
              className={`timeline-incident is-${incident.status}`}
              style={{ left: `${Math.max(0, left)}%`, width: `${width}%` }}
              title={`${nameOf(incident.targetId)} ${incident.status}: ${incident.reason ?? ''} · ${formatWhen(incident.startedAt)}`}
            />
          );
        })}
        {threats.map((finding) => {
          const left = ((finding.firstSeen - since) / span) * 100;
          const width = Math.max(
            0.3,
            (((finding.resolvedAt ?? until) - finding.firstSeen) / span) * 100,
          );
          if (left > 100 || left + width < 0) return null;
          return (
            <span
              key={`threat-${finding.id}-${finding.firstSeen}`}
              className={`timeline-threat is-${finding.severity}`}
              style={{ left: `${Math.max(0, left)}%`, width: `${width}%` }}
              title={`${nameOf(finding.targetId)}: ${finding.title} · ${formatWhen(finding.firstSeen)}`}
            />
          );
        })}
        <input
          type="range"
          className="timeline-range"
          min={since}
          max={until}
          step={30_000}
          value={at}
          aria-label="Moment to show"
          onChange={(event) => {
            setPlaying(false);
            seek(Number(event.target.value));
          }}
        />
      </div>
      <div className="timeline-foot">
        <span>{formatWhen(since)}</span>
        {happening.length > 0 ? (
          <span className="timeline-happening">
            {happening.slice(0, 3).map((i) => (
              <button
                key={`${i.targetId}-${i.startedAt}`}
                type="button"
                className="hud-link"
                onClick={() => useUiStore.getState().focusHost(i.targetId)}
              >
                {nameOf(i.targetId)} {i.status}
              </button>
            ))}
            {happening.length > 3 ? ` +${happening.length - 3}` : ''}
          </span>
        ) : (
          <span className="timeline-quiet">no incident at this moment</span>
        )}
        <span>now</span>
      </div>
      {attacked.length > 0 && (
        <p className="timeline-attacks">
          <span>Under attack then</span>
          {attacked.slice(0, 3).map((f) => (
            <button
              key={f.id}
              type="button"
              className="hud-link"
              onClick={() => useUiStore.getState().showBuilding(f.targetId)}
            >
              {nameOf(f.targetId)}: {f.title}
            </button>
          ))}
          {attacked.length > 3 ? ` +${attacked.length - 3}` : ''}
        </p>
      )}
    </motion.section>
  );
}
