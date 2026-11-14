import type { RunSummary } from '@app/shared';
import { useState } from 'react';
import { backupApi, type BackupOptions } from '../../data/backup-api';
import {
  Empty,
  formatBytes,
  formatDate,
  formatDuration,
  formatWhen,
  LogView,
  StatusBadge,
  useLoad,
} from './shared';

export function HistoryTab({
  options,
  onRestore,
}: {
  options: BackupOptions | null;
  onRestore: (runId: string) => void;
}) {
  const jobs = useLoad(() => backupApi.jobs());
  const [jobId, setJobId] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(50);
  const { data, error } = useLoad(
    () => backupApi.runs({ jobId, status, limit }),
    [jobId, status, limit],
  );
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="bk-section">
      <div className="bk-toolbar">
        <div className="bk-inline">
          <select value={jobId} onChange={(e) => setJobId(e.target.value)} aria-label="Job">
            <option value="">All jobs</option>
            {jobs.data?.map((j) => (
              <option key={j.id} value={j.id}>
                {j.name}
              </option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            <option value="">Any status</option>
            {['success', 'partial', 'failed', 'running', 'interrupted', 'cancelled', 'deleted'].map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ),
            )}
          </select>
        </div>
      </div>
      {error && <p className="bk-error">{error}</p>}
      {data && data.length === 0 && <Empty title="No backups yet" />}
      {data && data.length > 0 && (
        <div className="bk-table-wrap">
          <table className="bk-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Job</th>
                <th>Type</th>
                <th>Status</th>
                <th>Size</th>
                <th>Duration</th>
                <th>Stored on</th>
              </tr>
            </thead>
            <tbody>
              {data.map((run) => (
                <tr
                  key={run.id}
                  className={open === run.id ? 'is-open' : ''}
                  onClick={() => setOpen(open === run.id ? null : run.id)}
                  tabIndex={0}
                  onKeyDown={(e) => e.key === 'Enter' && setOpen(open === run.id ? null : run.id)}
                >
                  <td title={formatDate(run.startedAt)}>{formatWhen(run.startedAt)}</td>
                  <td>
                    {run.jobName}
                    <span className="bk-muted">
                      {' '}
                      · {options?.labels[run.sourceKind] ?? run.sourceKind}
                    </span>
                  </td>
                  <td>
                    {run.type}
                    {run.encrypted ? ' 🔒' : ''}
                  </td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td>{formatBytes(run.storedBytes)}</td>
                  <td>
                    {run.finishedAt ? formatDuration((run.finishedAt - run.startedAt) / 1000) : '—'}
                  </td>
                  <td>
                    {run.targets.map((t) => (
                      <StatusBadge
                        key={t.destinationId}
                        status={t.status}
                        label={t.destinationName}
                      />
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.length >= limit && (
            <button type="button" onClick={() => setLimit((l) => l + 50)}>
              Show more
            </button>
          )}
        </div>
      )}
      {open && <RunDetails runId={open} onClose={() => setOpen(null)} onRestore={onRestore} />}
    </section>
  );
}

export function RunDetails({
  runId,
  onClose,
  onRestore,
}: {
  runId: string;
  onClose: () => void;
  onRestore: (runId: string) => void;
}) {
  const { data, error, reload } = useLoad(() => backupApi.run(runId), [runId]);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run: RunSummary | undefined = data?.run;
  const usable = run && (run.status === 'success' || run.status === 'partial');

  const verify = async () => {
    setBusy(true);
    try {
      await backupApi.verifyRun(runId);
      setMessage({
        ok: true,
        text: 'Verification started: each copy is downloaded, its SHA-256 compared and read to the end. Follow it on the dashboard.',
      });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (
      !run ||
      !window.confirm(
        `Delete this backup (${run.fileName}) from every destination?\n\nThis cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      const result = await backupApi.deleteRun(runId);
      setMessage(
        result.failed.length
          ? { ok: false, text: `Could not delete on: ${result.failed.join(', ')}` }
          : { ok: true, text: 'Deleted.' },
      );
      reload();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="bk-drawer" aria-label="Backup details">
      <header>
        <h3>{run?.fileName ?? 'Backup'}</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {error && <p className="bk-error">{error}</p>}
      {run && (
        <>
          <dl className="bk-kv">
            <div>
              <dt>Job</dt>
              <dd>{run.jobName}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <StatusBadge status={run.status} />{' '}
                {run.error && <span className="bk-error">{run.error}</span>}
              </dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>
                {run.type}
                {run.parentRunId ? ' (needs the earlier backups of its chain)' : ''}
              </dd>
            </div>
            <div>
              <dt>Started</dt>
              <dd>
                {formatDate(run.startedAt)} · {run.trigger}
              </dd>
            </div>
            <div>
              <dt>Source data</dt>
              <dd>{formatBytes(run.rawBytes)}</dd>
            </div>
            <div>
              <dt>Stored file</dt>
              <dd>
                {formatBytes(run.storedBytes)} · {run.compression}
                {run.encrypted ? ' · AES-256-GCM' : ''}
              </dd>
            </div>
            <div>
              <dt>SHA-256</dt>
              <dd className="bk-mono bk-break">{run.sha256 ?? '—'}</dd>
            </div>
            {data?.manifest && (
              <div>
                <dt>Format</dt>
                <dd>
                  {data.manifest.source.contentFormat}
                  {data.manifest.fileCount !== undefined
                    ? ` · ${data.manifest.fileCount} entries`
                    : ''}
                </dd>
              </div>
            )}
          </dl>
          <h4>Copies</h4>
          <ul className="bk-list">
            {run.targets.map((t) => (
              <li key={t.destinationId}>
                <StatusBadge status={t.status} /> <strong>{t.destinationName}</strong>
                <span className="bk-muted bk-mono"> {t.remoteKey}</span>
                {t.error && <p className="bk-error">{t.error}</p>}
              </li>
            ))}
          </ul>
          <div className="bk-actions">
            <button
              type="button"
              className="button-primary"
              disabled={!usable}
              onClick={() => onRestore(run.id)}
            >
              Restore…
            </button>
            <button type="button" disabled={!usable || busy} onClick={() => void verify()}>
              Verify integrity
            </button>
            <button
              type="button"
              disabled={busy || run.status === 'running' || run.status === 'deleted'}
              onClick={() => void remove()}
            >
              Delete backup
            </button>
          </div>
          {message && <p className={message.ok ? 'bk-ok' : 'bk-error'}>{message.text}</p>}
          <h4>Log</h4>
          {data && <LogView lines={data.logs} tall />}
        </>
      )}
    </aside>
  );
}
