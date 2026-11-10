import { isStale, thresholdsForHost, usagePercent, type HostState } from '@app/shared';
import { AnimatePresence, motion } from 'motion/react';
import { useMemo } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { accents, durations, neutrals, statusGlowColor } from '../design/tokens';
import {
  formatBytes,
  formatLastSeen,
  formatPercent,
  formatRate,
  formatUptime,
  UNKNOWN,
} from './format';
import { Sparkline } from './Sparkline';
import { StatusDot } from './StatusDot';
import { useNow } from './use-now';
import { useUiStore } from './ui-store';

const PERCENT_RANGE: [number, number] = [0, 100];

/**
 * The panel that unfolds next to a focused tower: live numbers, sparklines,
 * OS, uptime and the status reason. Unknown values show a dash; stale data
 * is desaturated and labelled, exactly like the tower.
 */
export function FocusHud({ onJackIn }: { onJackIn(hostId: string): void }) {
  const focusedHostId = useUiStore((store) => store.focusedHostId);
  const focusHost = useUiStore((store) => store.focusHost);
  // The HUD folds away while diving into (or working inside) the terminal.
  const inTerminal = useUiStore((store) => store.terminal !== null);
  const host = useFleetStore((store) => store.hosts.find((h) => h.id === focusedHostId));
  const state = useFleetStore((store) => (focusedHostId ? store.states[focusedHostId] : undefined));
  const history = useFleetStore((store) =>
    focusedHostId ? store.history[focusedHostId] : undefined,
  );
  const fileThresholds = useFleetStore((store) => store.thresholds);
  const dataMode = useFleetStore((store) => store.dataMode);
  // This host's own warning thresholds (Edit) on top of the file-wide ones.
  const thresholds = thresholdsForHost(fileThresholds, host);
  const refusal = useFleetStore((store) =>
    focusedHostId ? store.hostKeyRefusals[focusedHostId] : undefined,
  );
  const now = useNow(1000);

  const series = useMemo(() => {
    const samples = history ?? [];
    return {
      times: samples.map((s) => s.at),
      cpu: samples.map((s) => s.cpuPercent),
      memory: samples.map((s) => s.memoryPercent),
      network: samples.map((s) => s.networkBytesPerSec),
    };
  }, [history]);

  const status = state?.status ?? 'unknown';
  const stale = state ? state.stale || isStale(state.lastSeenAt, now, thresholds) : false;
  const chartColor = (stale ? null : statusGlowColor[status]) ?? neutrals.muted;

  return (
    // "wait": the previous host's panel finishes leaving before the next one
    // unfolds, so two panels never overlap when jumping between hosts.
    <AnimatePresence mode="wait">
      {host && !inTerminal && (
        <motion.aside
          key={host.id}
          className={`focus-hud${stale ? ' is-stale' : ''} status-${status}`}
          aria-label={`Details for ${host.name}`}
          initial={{ opacity: 0, x: 24, scaleY: 0.92 }}
          animate={{ opacity: 1, x: 0, scaleY: 1 }}
          exit={{ opacity: 0, x: 24 }}
          transition={{ duration: durations.hudUnfold / 1000, ease: [0.215, 0.61, 0.355, 1] }}
        >
          <header className="hud-header">
            <div>
              <h2>
                <StatusDot status={status} stale={stale} /> {host.name}
              </h2>
              <p className="hud-subtitle">{host.district}</p>
              <p className="hud-subtitle">
                {host.user}@{host.address}:{host.port}
              </p>
            </div>
            <span className="hud-status">{stale ? 'stale' : status}</span>
          </header>

          {/* A refused host key gets its own panel below instead of the raw reason. */}
          {!refusal && (
            <p
              className={`hud-reason${status === 'degraded' ? ' is-warning' : ''}${status === 'offline' && state?.error ? ' is-error' : ''}`}
            >
              {statusLine(state, stale, now)}
            </p>
          )}
          {host && refusal && (
            <section className="hud-refusal" role="alert" aria-label="Host key refused">
              <h3>{refusal.reason === 'changed' ? 'Host key CHANGED' : 'Unknown host key'}</h3>
              <p>
                <code>{refusal.fingerprint}</code>
              </p>
              <p>
                {refusal.reason === 'changed'
                  ? 'This could be a man-in-the-middle attack, or the server was reinstalled. Do not trust it until you have verified the new fingerprint with the server owner. Then remove the old entry: '
                  : 'Verify this fingerprint out of band (console, provider dashboard), then connect once with ssh to add it: '}
                <code>
                  {refusal.reason === 'changed'
                    ? `ssh-keygen -R ${knownHostsName(host.address, host.port)}`
                    : `ssh -p ${host.port} ${host.user}@${host.address}`}
                </code>
              </p>
            </section>
          )}
          {/* The error is often the status reason itself; show it once. */}
          {state?.error && state.error !== state.statusReason && (
            <p className="hud-error">{state.error}</p>
          )}

          <dl className="hud-metrics">
            <Metric label="CPU" value={formatPercent(state?.cpuPercent ?? null)} />
            <Metric
              label="Load"
              value={
                state?.load
                  ? `${state.load.one} · ${state.load.five} · ${state.load.fifteen}`
                  : UNKNOWN
              }
            />
            <Metric label="Memory" value={usageText(state?.memory ?? null)} />
            <Metric label="Swap" value={usageText(state?.swap ?? null)} />
            <Metric label="Uptime" value={formatUptime(state?.uptimeSeconds ?? null)} />
            <Metric label="Network" value={networkText(state)} wide />
          </dl>

          <section className="hud-charts" aria-label="Recent history">
            <ChartRow label="CPU %">
              <Sparkline
                label="CPU history"
                times={series.times}
                values={series.cpu}
                color={chartColor}
                range={PERCENT_RANGE}
              />
            </ChartRow>
            <ChartRow label="Mem %">
              <Sparkline
                label="Memory history"
                times={series.times}
                values={series.memory}
                color={chartColor}
                range={PERCENT_RANGE}
              />
            </ChartRow>
            <ChartRow label="Net">
              <Sparkline
                label="Network history"
                times={series.times}
                values={series.network}
                color={chartColor}
              />
            </ChartRow>
          </section>

          <section className="hud-disks" aria-label="Disks">
            {(state?.disks ?? []).map((disk) => {
              const percent = usagePercent(disk);
              const over = percent !== null && percent > thresholds.diskDegradedPercent;
              return (
                <div key={disk.mount} className="hud-disk">
                  <span className="hud-disk-mount">{disk.mount}</span>
                  <span className="hud-disk-bar">
                    <span
                      style={{
                        width: `${percent ?? 0}%`,
                        background: over ? accents.degraded : chartColor,
                      }}
                    />
                  </span>
                  <span className="hud-disk-value">
                    {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)}
                  </span>
                </div>
              );
            })}
            {state?.disks.length === 0 && <p className="hud-muted">Disks: {UNKNOWN}</p>}
          </section>

          <p className="hud-os">{state?.os ?? `OS ${UNKNOWN}`}</p>
          {host.thresholds && (
            <p className="hud-muted">Own warnings: {describeOverrides(host.thresholds)}</p>
          )}

          <footer className="hud-actions">
            <button
              type="button"
              className="button-primary"
              onClick={() => onJackIn(host.id)}
              disabled={!canOpenTerminal(status)}
              title={canOpenTerminal(status) ? undefined : `No SSH connection: host is ${status}`}
            >
              Jack in <kbd>Enter</kbd>
            </button>
            <button type="button" onClick={() => useUiStore.getState().openHistory(host.id)}>
              History <kbd>H</kbd>
            </button>
            {dataMode === 'real' && (
              <button type="button" onClick={() => useUiStore.getState().setEditHostId(host.id)}>
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

function describeOverrides(
  overrides: NonNullable<import('@app/shared').Host['thresholds']>,
): string {
  const parts: string[] = [];
  if (overrides.cpuDegradedPercent !== undefined) {
    parts.push(
      `CPU > ${overrides.cpuDegradedPercent}%${overrides.cpuDegradedPolls ? ` for ${overrides.cpuDegradedPolls} polls` : ''}`,
    );
  } else if (overrides.cpuDegradedPolls !== undefined) {
    parts.push(`CPU for ${overrides.cpuDegradedPolls} polls`);
  }
  if (overrides.memoryDegradedPercent !== undefined)
    parts.push(`memory > ${overrides.memoryDegradedPercent}%`);
  if (overrides.diskDegradedPercent !== undefined)
    parts.push(`disk > ${overrides.diskDegradedPercent}%`);
  return parts.join(' · ');
}

/** A terminal needs a live SSH connection. */
export function canOpenTerminal(status: HostState['status']): boolean {
  return status === 'online' || status === 'degraded';
}

/** known_hosts name: host on port 22, [host]:port otherwise. */
function knownHostsName(address: string, port: number): string {
  return port === 22 ? address : `[${address}]:${port}`;
}

function Metric({ label, value, wide = false }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={`hud-metric${wide ? ' is-wide' : ''}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function ChartRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="hud-chart-row">
      <span>{label}</span>
      {children}
    </div>
  );
}

function statusLine(state: HostState | undefined, stale: boolean, now: number): string {
  if (!state) return 'waiting for first poll';
  if (stale) return `Data frozen · ${formatLastSeen(state.lastSeenAt, now)}`;
  return state.statusReason ?? UNKNOWN;
}

function usageText(usage: { usedBytes: number; totalBytes: number } | null): string {
  if (!usage) return UNKNOWN;
  return `${formatBytes(usage.usedBytes)} / ${formatBytes(usage.totalBytes)} (${formatPercent(usagePercent(usage))})`;
}

function networkText(state: HostState | undefined): string {
  if (!state || state.network.length === 0) return UNKNOWN;
  const rx = state.network.reduce((sum, rate) => sum + rate.rxBytesPerSec, 0);
  const tx = state.network.reduce((sum, rate) => sum + rate.txBytesPerSec, 0);
  return `↓ ${formatRate(rx)}  ↑ ${formatRate(tx)}`;
}
