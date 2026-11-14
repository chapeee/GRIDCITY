import type { LogLine, OperationProgress, RunStatus, TargetStatus } from '@app/shared';
import { useEffect, useRef, useState } from 'react';
import { backupApi, useBackupLive } from '../../data/backup-api';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min`;
}

export function formatWhen(at: number | null | undefined): string {
  if (!at) return '—';
  const diff = Date.now() - at;
  const abs = Math.abs(diff);
  const rel =
    abs < 60_000
      ? 'just now'
      : abs < 3_600_000
        ? `${Math.round(abs / 60_000)} min`
        : abs < 86_400_000
          ? `${Math.round(abs / 3_600_000)} h`
          : `${Math.round(abs / 86_400_000)} d`;
  if (rel === 'just now') return rel;
  return diff >= 0 ? `${rel} ago` : `in ${rel}`;
}

export const formatDate = (at: number | null | undefined) =>
  at ? new Date(at).toLocaleString() : '—';

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'bad' | 'muted' | 'live'> = {
  success: 'ok',
  verified: 'ok',
  uploaded: 'ok',
  partial: 'warn',
  failed: 'bad',
  interrupted: 'bad',
  missing: 'bad',
  cancelled: 'muted',
  deleted: 'muted',
  pending: 'muted',
  running: 'live',
  uploading: 'live',
};

export function StatusBadge({
  status,
  label,
}: {
  status: RunStatus | TargetStatus | string;
  label?: string;
}) {
  return <span className={`bk-badge is-${STATUS_TONE[status] ?? 'muted'}`}>{label ?? status}</span>;
}

/** A bar that is honest: a percentage when measurable, a moving stripe otherwise. */
export function ProgressBar({ percent, estimate }: { percent: number | null; estimate?: boolean }) {
  if (percent === null) {
    return (
      <div
        key="indeterminate"
        className="bk-bar is-indeterminate"
        role="progressbar"
        aria-label="In progress (size unknown)"
      >
        <span />
      </div>
    );
  }
  return (
    <div
      key="determinate"
      className="bk-bar"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span style={{ width: `${percent}%` }} />
      {estimate && <i className="bk-bar-note">≈</i>}
    </div>
  );
}

export function OperationCard({
  op,
  showLog = true,
}: {
  op: OperationProgress;
  showLog?: boolean;
}) {
  const logs = useBackupLive((s) => s.logs[op.id]);
  const [cancelling, setCancelling] = useState(false);
  const running = op.status === 'running';
  return (
    <article className={`bk-op is-${op.status}`} aria-live="polite">
      <header>
        <div>
          <strong>{op.title}</strong>
          <span className="bk-muted">
            {op.kind} · started {formatWhen(op.startedAt)}
          </span>
        </div>
        {running ? (
          <button
            type="button"
            disabled={cancelling}
            onClick={() => {
              setCancelling(true);
              void backupApi.cancel(op.id).finally(() => setCancelling(false));
            }}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : (
          <StatusBadge status={op.status} />
        )}
      </header>
      <div className="bk-op-stage">
        <span>{op.stageLabel}</span>
        <span className="bk-muted">
          {op.percent !== null
            ? `${op.totalIsEstimate ? '≈' : ''}${op.percent}%`
            : running
              ? 'size unknown'
              : ''}
        </span>
      </div>
      {running && <ProgressBar percent={op.percent} estimate={op.totalIsEstimate} />}
      <dl className="bk-op-stats">
        <div>
          <dt>Processed</dt>
          <dd>
            {formatBytes(op.processedBytes)}
            {op.totalBytes !== null &&
              ` of ${op.totalIsEstimate ? '≈' : ''}${formatBytes(op.totalBytes)}`}
          </dd>
        </div>
        <div>
          <dt>Speed</dt>
          <dd>{op.bytesPerSec !== null ? `${formatBytes(op.bytesPerSec)}/s` : '—'}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{op.etaSeconds !== null ? formatDuration(op.etaSeconds) : '—'}</dd>
        </div>
      </dl>
      {op.destinations.length > 0 && (
        <ul className="bk-op-dests">
          {op.destinations.map((d) => (
            <li key={d.destinationId}>
              <div className="bk-op-dest-line">
                <span>{d.name}</span>
                <StatusBadge status={d.status} />
                <span className="bk-muted">
                  {d.percent !== null ? `${d.percent}%` : ''}
                  {d.bytesPerSec ? ` · ${formatBytes(d.bytesPerSec)}/s` : ''}
                  {d.etaSeconds ? ` · ${formatDuration(d.etaSeconds)} left` : ''}
                </span>
              </div>
              {(d.status === 'uploading' || d.status === 'pending') && (
                <ProgressBar percent={d.percent} />
              )}
              {d.error && <p className="bk-error">{d.error}</p>}
            </li>
          ))}
        </ul>
      )}
      {op.error && <p className="bk-error">{op.error}</p>}
      {showLog && logs && logs.length > 0 && <LogView lines={logs} />}
    </article>
  );
}

export function LogView({ lines, tall }: { lines: LogLine[]; tall?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);
  return (
    <pre ref={ref} className={`bk-log${tall ? ' is-tall' : ''}`} aria-label="Log">
      {lines.map((l, i) => (
        <span key={i} className={`is-${l.level}`}>
          {new Date(l.at).toLocaleTimeString()} {l.message}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

/** Loads data and reloads it whenever the server says something changed. */
export function useLoad<T>(
  load: () => Promise<T>,
  deps: unknown[] = [],
): {
  data: T | null;
  error: string | null;
  reload: () => void;
} {
  const version = useBackupLive((s) => s.version);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (value) => {
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      },
      (reason: Error) => {
        if (!cancelled) setError(reason.message);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, tick, ...deps]);
  return { data, error, reload: () => setTick((t) => t + 1) };
}

export function Field({
  label,
  hint,
  children,
  wide,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`bk-field${wide ? ' is-wide' : ''}`}>
      <span className="bk-field-label">{label}</span>
      {children}
      {hint && <span className="bk-field-hint">{hint}</span>}
    </label>
  );
}

export function Empty({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="bk-empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}
