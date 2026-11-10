import { incidentTotals, type HistoryIncident, type HistoryResponse } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { fetchHistory } from '../data/history-api';
import { accents, neutrals } from '../design/tokens';
import { formatDurationShort, formatRate } from './format';
import { HistoryChart } from './HistoryChart';
import { useUiStore } from './ui-store';

const RANGES = [
  { days: 1, label: '24 h' },
  { days: 3, label: '3 days' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
] as const;

const PERCENT: [number, number] = [0, 100];
const formatPercentTick = (value: number) => `${Math.round(value)}%`;
const formatRateTick = (value: number) => formatRate(value);

const formatWhen = (at: number) =>
  new Date(at).toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

/**
 * When was a server overloaded or down? Incidents are the periods it was
 * degraded (over a warning threshold) or offline, recorded as they happened;
 * the charts are the stored metric buckets. Gaps mean "no data", never zero.
 * With no target it lists every incident in the fleet.
 */
export function HistoryPanel() {
  const target = useUiStore((store) => store.historyTarget);
  const open = target !== undefined;
  const targetId = target ?? null;
  const hosts = useFleetStore((store) => store.hosts);
  const resources = useFleetStore((store) => store.resources);
  const thresholds = useFleetStore((store) => store.thresholds);
  const dataMode = useFleetStore((store) => store.dataMode);
  const [days, setDays] = useState(7);
  const [loaded, setLoaded] = useState<{ key: string; data: HistoryResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const nameOf = useCallback(
    (id: string) =>
      hosts.find((h) => h.id === id)?.name ?? resources.find((r) => r.id === id)?.name ?? id,
    [hosts, resources],
  );
  const host = hosts.find((h) => h.id === targetId);
  const hostThresholds = { ...thresholds, ...(host?.thresholds ?? {}) };

  // Results are tagged with what was asked, so a previous server's history never shows.
  const requestKey = `${targetId ?? '*'}|${days}`;
  const load = useCallback(() => {
    fetchHistory(targetId, days)
      .then((data) => {
        setLoaded({ key: `${targetId ?? '*'}|${days}`, data });
        setError(null);
      })
      .catch((reason: unknown) => setError((reason as Error).message));
  }, [targetId, days]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);
  const history = loaded?.key === requestKey ? loaded.data : null;

  const series = useMemo(() => {
    const points = history?.points ?? [];
    return {
      times: points.map((p) => p.at),
      cpu: points.map((p) => p.cpuPercent),
      memory: points.map((p) => p.memoryPercent),
      disk: points.map((p) => p.maxDiskPercent),
      network: points.map((p) => p.networkBytesPerSec),
    };
  }, [history]);

  const totals = history ? incidentTotals(history.incidents, history.since, history.until) : null;
  const close = () => useUiStore.getState().openHistory(undefined);
  const maxDays = history?.retentionDays ?? 7;

  return (
    <AnimatePresence>
      {open && (
        <motion.section
          className="history-panel"
          aria-label={targetId ? `History of ${nameOf(targetId)}` : 'Fleet history'}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 12 }}
          transition={{ duration: 0.18 }}
        >
          <header className="audit-header">
            <h2>{targetId ? `History · ${nameOf(targetId)}` : 'Fleet history'}</h2>
            <div className="audit-actions">
              <div className="segmented" role="group" aria-label="Time range">
                {RANGES.map((range) => (
                  <button
                    key={range.days}
                    type="button"
                    aria-pressed={days === range.days}
                    disabled={range.days > maxDays}
                    title={
                      range.days > maxDays
                        ? `History is kept for ${maxDays} days (Settings)`
                        : undefined
                    }
                    onClick={() => setDays(range.days)}
                  >
                    {range.label}
                  </button>
                ))}
              </div>
              {targetId && (
                <button type="button" onClick={() => useUiStore.getState().openHistory(null)}>
                  All servers
                </button>
              )}
              <button type="button" onClick={close}>
                Close <kbd>Esc</kbd>
              </button>
            </div>
          </header>

          {dataMode === 'demo' && (
            <p className="audit-note">DEMO DATA: generated history, not a real server.</p>
          )}
          {error && <p className="audit-error">{error}</p>}

          {history && totals && (
            <>
              <p className="history-summary">
                {totals.degraded + totals.offline === 0
                  ? `No incidents in the last ${days === 1 ? '24 hours' : `${days} days`}.`
                  : [
                      totals.degraded > 0 &&
                        `over a threshold for ${formatDurationShort(totals.degraded)}`,
                      totals.offline > 0 && `offline for ${formatDurationShort(totals.offline)}`,
                    ]
                      .filter(Boolean)
                      .join(' · ') + ` in the last ${days === 1 ? '24 hours' : `${days} days`}`}
              </p>
              <IncidentTimeline history={history} />

              {targetId && host && (
                <section className="history-charts" aria-label="Metrics over time">
                  <ChartBlock label="CPU">
                    <HistoryChart
                      label="CPU %"
                      times={series.times}
                      values={series.cpu}
                      color={accents.online}
                      range={PERCENT}
                      format={formatPercentTick}
                      threshold={{
                        value: hostThresholds.cpuDegradedPercent,
                        color: accents.degraded,
                      }}
                    />
                  </ChartBlock>
                  <ChartBlock label="Memory">
                    <HistoryChart
                      label="Memory %"
                      times={series.times}
                      values={series.memory}
                      color={accents.online}
                      range={PERCENT}
                      format={formatPercentTick}
                      threshold={{
                        value: hostThresholds.memoryDegradedPercent,
                        color: accents.degraded,
                      }}
                    />
                  </ChartBlock>
                  <ChartBlock label="Fullest disk">
                    <HistoryChart
                      label="Fullest disk %"
                      times={series.times}
                      values={series.disk}
                      color={accents.online}
                      range={PERCENT}
                      format={formatPercentTick}
                      threshold={{
                        value: hostThresholds.diskDegradedPercent,
                        color: accents.degraded,
                      }}
                    />
                  </ChartBlock>
                  <ChartBlock label="Network">
                    <HistoryChart
                      label="Network"
                      times={series.times}
                      values={series.network}
                      color={accents.online}
                      format={formatRateTick}
                    />
                  </ChartBlock>
                  {series.times.length === 0 && (
                    <p className="audit-empty">No stored samples in this range yet.</p>
                  )}
                </section>
              )}

              <h3 className="history-heading">Incidents</h3>
              {history.incidents.length === 0 ? (
                <p className="audit-empty">None in this range.</p>
              ) : (
                <ol className="history-incidents">
                  {[...history.incidents].reverse().map((incident) => (
                    <IncidentRow
                      key={`${incident.targetId}-${incident.startedAt}`}
                      incident={incident}
                      name={targetId ? null : nameOf(incident.targetId)}
                      until={history.until}
                      onOpen={() => useUiStore.getState().openHistory(incident.targetId)}
                    />
                  ))}
                </ol>
              )}
              <p className="audit-note">
                Kept for {history.retentionDays} days (change it in Settings). Thresholds that
                decide “over a threshold” are set per server in Edit, or for all in Settings.
              </p>
            </>
          )}
        </motion.section>
      )}
    </AnimatePresence>
  );
}

function ChartBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="history-chart-block">
      <span>{label}</span>
      {children}
    </div>
  );
}

/** A strip over the whole range: amber = over a threshold, dark with red edge = offline. */
function IncidentTimeline({ history }: { history: HistoryResponse }) {
  const span = history.until - history.since;
  return (
    <div className="history-timeline" role="img" aria-label="Incidents over time">
      {history.incidents.map((incident) => {
        const start = Math.max(history.since, incident.startedAt);
        const end = Math.min(history.until, incident.endedAt ?? history.until);
        if (end <= start) return null;
        return (
          <span
            key={`${incident.targetId}-${incident.startedAt}`}
            className={`history-segment is-${incident.status}`}
            style={{
              left: `${((start - history.since) / span) * 100}%`,
              width: `max(2px, ${((end - start) / span) * 100}%)`,
            }}
            title={`${incident.status === 'offline' ? 'Offline' : 'Over a threshold'}: ${incident.reason ?? ''}`}
          />
        );
      })}
      <span className="history-timeline-label is-start">{formatWhen(history.since)}</span>
      <span className="history-timeline-label is-end">now</span>
    </div>
  );
}

function IncidentRow({
  incident,
  name,
  until,
  onOpen,
}: {
  incident: HistoryIncident;
  name: string | null;
  until: number;
  onOpen(): void;
}) {
  const ongoing = incident.endedAt === null;
  const duration = (incident.endedAt ?? until) - incident.startedAt;
  return (
    <li className={`is-${incident.status}`}>
      <span
        className="history-chip"
        style={{ color: incident.status === 'offline' ? accents.alert : accents.degraded }}
      >
        {incident.status === 'offline' ? 'offline' : 'overloaded'}
      </span>
      {name && (
        <button type="button" className="history-target" onClick={onOpen}>
          {name}
        </button>
      )}
      <span className="history-reason">{incident.reason ?? '—'}</span>
      <time dateTime={new Date(incident.startedAt).toISOString()}>
        {formatWhen(incident.startedAt)}
      </time>
      <span
        className="history-duration"
        style={{ color: ongoing ? neutrals.textBright : undefined }}
      >
        {ongoing ? `ongoing · ${formatDurationShort(duration)}` : formatDurationShort(duration)}
      </span>
    </li>
  );
}
