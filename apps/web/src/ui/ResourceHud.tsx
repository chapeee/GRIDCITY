import {
  isManageable,
  DEFAULT_RESOURCE_THRESHOLDS,
  isStale,
  linksOf,
  RESOURCE_KIND_LABELS,
  type ResourceMetric,
  type ResourceState,
} from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { durations, neutrals, statusGlowColor } from '../design/tokens';
import { formatBytes, formatLastSeen, formatPercent, UNKNOWN } from './format';
import { Sparkline } from './Sparkline';
import { StatusDot } from './StatusDot';
import { useNow } from './use-now';
import { useUiStore } from './ui-store';
import { BlastRadiusLine, DoctorHintLine } from './DoctorHintLine';
import { HudThreats } from './HudThreats';

/**
 * Focus panel for databases, RDS instances and buckets. It lists whatever
 * the connector reported (one line per metric, dashes for unknown), the
 * status reason, and one sparkline of the value that drives the building's
 * light. There is no "Jack in": these resources have no shell.
 */
export function ResourceHud() {
  const focusedId = useUiStore((store) => store.focusedHostId);
  const focusHost = useUiStore((store) => store.focusHost);
  const inTerminal = useUiStore((store) => store.terminal !== null);
  const resource = useFleetStore((store) => store.resources.find((r) => r.id === focusedId));
  const state = useFleetStore((store) => (focusedId ? store.resourceStates[focusedId] : undefined));
  const history = useFleetStore((store) =>
    focusedId ? store.resourceHistory[focusedId] : undefined,
  );
  const dataMode = useFleetStore((store) => store.dataMode);
  const links = useFleetStore((store) => store.links);
  const hosts = useFleetStore((store) => store.hosts);
  const resources = useFleetStore((store) => store.resources);
  const nameOf = (id: string) =>
    hosts.find((h) => h.id === id)?.name ?? resources.find((r) => r.id === id)?.name ?? id;
  const { uses, usedBy } = linksOf(links, focusedId ?? '');
  const now = useNow(1000);

  const series = useMemo(
    () => ({
      times: (history ?? []).map((s) => s.at),
      values: (history ?? []).map((s) => s.value),
    }),
    [history],
  );

  const status = state?.status ?? 'unknown';
  const stale = state
    ? state.stale ||
      isStale(state.lastSeenAt, now, {
        pollIntervalMs: state.pollIntervalMs,
        staleAfterPolls: DEFAULT_RESOURCE_THRESHOLDS.staleAfterPolls,
      })
    : false;
  const chartColor = (stale ? null : statusGlowColor[status]) ?? neutrals.muted;

  return (
    <AnimatePresence mode="wait">
      {resource && !inTerminal && (
        <motion.aside
          key={resource.id}
          className={`focus-hud${stale ? ' is-stale' : ''} status-${status}`}
          aria-label={`Details for ${resource.name}`}
          initial={{ opacity: 0, x: 24, scaleY: 0.92 }}
          animate={{ opacity: 1, x: 0, scaleY: 1 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: durations.hudUnfold / 1000, ease: [0.215, 0.61, 0.355, 1] }}
        >
          <header className="hud-header">
            <div>
              <h2>
                <StatusDot status={status} stale={stale} /> {resource.name}
              </h2>
              <p className="hud-subtitle">
                {resource.engine} ·{' '}
                <button
                  type="button"
                  className="hud-link"
                  title="Frame this district"
                  onClick={() => useUiStore.getState().focusDistrict(resource.district)}
                >
                  {resource.district}
                </button>
              </p>
              <p className="hud-subtitle">{resource.target}</p>
            </div>
            <span className="hud-status">{stale ? 'stale' : status}</span>
          </header>

          <p
            className={`hud-reason${status === 'degraded' ? ' is-warning' : ''}${status === 'offline' && state?.error ? ' is-error' : ''}`}
          >
            {statusLine(state, stale, now)}
          </p>
          {state?.error && state.error !== state.statusReason && (
            <p className="hud-error">{state.error}</p>
          )}

          <DoctorHintLine hint={state?.hint} targetId={resource.id} />
          <HudThreats targetId={resource.id} />
          <BlastRadiusLine targetId={resource.id} />

          <dl className="hud-metrics">
            {(state?.metrics ?? []).map((entry) => (
              <div
                key={entry.key}
                className={`hud-metric${entry.unit === 'text' ? ' is-wide' : ''}`}
              >
                <dt>{entry.label}</dt>
                <dd>{formatMetric(entry)}</dd>
              </div>
            ))}
          </dl>
          {(state?.metrics.length ?? 0) === 0 && <p className="hud-muted">Metrics: {UNKNOWN}</p>}

          <section className="hud-charts" aria-label="Recent history">
            <div className="hud-chart-row">
              <span>{headlineLabel(resource.kind)}</span>
              <Sparkline
                label={`${headlineLabel(resource.kind)} history`}
                times={series.times}
                values={series.values}
                color={chartColor}
              />
            </div>
          </section>

          {(uses.length > 0 || usedBy.length > 0) && (
            <section className="hud-list" aria-label="Topology">
              <h3>Talks to</h3>
              <ul>
                {uses.map((link) => (
                  <li key={link.id}>
                    <button type="button" className="hud-link" onClick={() => focusHost(link.to)}>
                      {nameOf(link.to)}
                    </button>
                    <small>
                      {' '}
                      {link.kind}
                      {link.label ? ` ${link.label}` : ''}
                    </small>
                  </li>
                ))}
                {usedBy.map((link) => (
                  <li key={link.id}>
                    <small>used by </small>
                    <button type="button" className="hud-link" onClick={() => focusHost(link.from)}>
                      {nameOf(link.from)}
                    </button>
                    <small>
                      {' '}
                      {link.kind}
                      {link.label ? ` ${link.label}` : ''}
                    </small>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <p className="hud-os">
            {RESOURCE_KIND_LABELS[resource.kind]} · polled every{' '}
            {Math.round((state?.pollIntervalMs ?? 0) / 1000)} s · monitoring is read-only
          </p>

          <footer className="hud-actions">
            {dataMode === 'real' && isManageable(resource.kind) && (
              <button
                type="button"
                className="button-primary"
                onClick={() =>
                  useUiStore.getState().openManage({
                    id: resource.sourceId,
                    bucket:
                      resource.kind === 's3' && resource.id !== resource.sourceId
                        ? resource.name
                        : undefined,
                  })
                }
              >
                Manage <kbd>M</kbd>
              </button>
            )}
            <button type="button" onClick={() => useUiStore.getState().openHistory(resource.id)}>
              History <kbd>H</kbd>
            </button>
            {dataMode === 'real' && (
              <button
                type="button"
                onClick={() => useUiStore.getState().setEditResourceId(resource.sourceId)}
              >
                Edit <kbd>E</kbd>
              </button>
            )}
            <button type="button" onClick={() => focusHost(null)}>
              Overview <kbd>Esc</kbd>
            </button>
          </footer>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

function headlineLabel(kind: string): string {
  if (kind === 'rds') return 'CPU %';
  if (kind === 's3' || kind === 'sqlite') return 'Size';
  return 'Ops/s';
}

function statusLine(state: ResourceState | undefined, stale: boolean, now: number): string {
  if (!state) return 'waiting for first poll';
  if (stale) return `Data frozen · ${formatLastSeen(state.lastSeenAt, now)}`;
  return state.statusReason ?? UNKNOWN;
}

/** Formats one metric line; unknown is always a dash, capped counts read "≥". */
export function formatMetric(entry: ResourceMetric): string {
  if (entry.unit === 'text') return entry.text || UNKNOWN;
  if (entry.value === null) return UNKNOWN;
  const prefix = entry.atLeast ? '≥ ' : '';
  const value = entry.value;
  switch (entry.unit) {
    case 'percent':
      return prefix + formatPercent(value);
    case 'bytes':
      return prefix + formatBytes(value);
    case 'bytesPerHour':
      return `${value < 0 ? '−' : '+'}${formatBytes(Math.abs(value))}/h`;
    case 'perSec':
      return `${prefix}${formatNumber(value)}/s`;
    case 'perHour':
      return `${prefix}${formatNumber(value)}/h`;
    case 'seconds':
      return `${prefix}${formatNumber(value)} s`;
    case 'ms':
      return `${prefix}${Math.round(value)} ms`;
    case 'days':
      return value < 0 ? `expired ${-Math.round(value)} d ago` : `${Math.round(value)} d`;
    case 'count':
      return prefix + Math.round(value).toLocaleString('en-US');
  }
}

function formatNumber(value: number): string {
  if (value >= 100) return Math.round(value).toLocaleString('en-US');
  if (value >= 10) return value.toFixed(1);
  return value.toFixed(2);
}
