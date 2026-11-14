import type { SourceConfig } from '@app/shared';
import { useEffect, useState } from 'react';
import { backupApi, type BackupOptions, type RestorePlan } from '../../data/backup-api';
import { Empty, Field, formatBytes, formatDate, formatWhen, StatusBadge, useLoad } from './shared';

/**
 * Restore Center: pick a backup, choose where it goes (the original or
 * somewhere else), see what will happen, type the target's name, restore.
 * Every file is downloaded and proven intact before anything is changed.
 */
export function RestoreTab({
  options,
  runId,
  setRunId,
}: {
  options: BackupOptions | null;
  runId: string | null;
  setRunId: (id: string | null) => void;
}) {
  const runs = useLoad(() => backupApi.runs({ limit: 200 }));
  const restores = useLoad(() => backupApi.restores());
  const usable = runs.data?.filter((r) => r.status === 'success' || r.status === 'partial') ?? [];
  const run = usable.find((r) => r.id === runId) ?? null;

  return (
    <section className="bk-section">
      <div className="bk-split">
        <div>
          <h3>1 · Choose a backup</h3>
          {usable.length === 0 && <Empty title="No backup to restore yet" />}
          <ul className="bk-pick">
            {usable.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  className={r.id === runId ? 'is-selected' : ''}
                  onClick={() => setRunId(r.id)}
                >
                  <strong>{r.jobName}</strong>
                  <span className="bk-muted">
                    {formatDate(r.startedAt)} · {r.type} · {formatBytes(r.storedBytes)}
                    {r.encrypted ? ' · 🔒' : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div>
          {run ? (
            <RestoreForm
              key={run.id}
              options={options}
              runId={run.id}
              sourceKind={run.sourceKind}
              onStarted={() => restores.reload()}
            />
          ) : (
            <Empty title="Pick a backup on the left" />
          )}
        </div>
      </div>
      <h3>Restore history</h3>
      {restores.data && restores.data.length === 0 && <p className="bk-muted">No restore yet.</p>}
      <ul className="bk-list">
        {restores.data?.map((r) => (
          <li key={r.id}>
            <StatusBadge status={r.status} /> <strong>{r.jobName}</strong> → {r.targetLabel}
            <span className="bk-muted"> · {formatWhen(r.startedAt)}</span>
            {r.error && <p className="bk-error">{r.error}</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RestoreForm({
  options,
  runId,
  sourceKind,
  onStarted,
}: {
  options: BackupOptions | null;
  runId: string;
  sourceKind: SourceConfig['kind'];
  onStarted: () => void;
}) {
  const detail = useLoad(() => backupApi.run(runId), [runId]);
  const [where, setWhere] = useState<'original' | 'other'>('original');
  const [target, setTarget] = useState<Partial<SourceConfig>>({});
  const [plan, setPlan] = useState<RestorePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [applyDeletions, setApplyDeletions] = useState(false);
  const [createDatabase, setCreateDatabase] = useState(true);
  const [passphrase, setPassphrase] = useState('');
  const [targetPassword, setTargetPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const effective = where === 'original' ? {} : target;
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      backupApi.restorePlan(runId, effective).then(
        (p) => !cancelled && (setPlan(p), setPlanError(null)),
        (e: Error) => !cancelled && (setPlan(null), setPlanError(e.message)),
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, where, JSON.stringify(target)]);

  const set = (patch: Partial<SourceConfig>) => {
    setTarget((t) => ({
      ...t,
      ...patch,
      ...(patch.tool ? { tool: { ...(t.tool ?? {}), ...patch.tool } as SourceConfig['tool'] } : {}),
    }));
    setConfirm('');
  };
  const isDb = ['postgres', 'mysql', 'mongodb', 'redis', 'mssql', 'sqlite'].includes(sourceKind);
  const original = detail.data?.manifest?.source.details ?? {};

  const start = async () => {
    setBusy(true);
    setResult(null);
    try {
      await backupApi.restore({
        runId,
        target: effective,
        confirm,
        applyDeletions,
        createDatabase,
        ...(passphrase ? { passphrase } : {}),
        ...(targetPassword ? { targetPassword } : {}),
      });
      setResult({
        ok: true,
        text: 'Restore started. Every file is downloaded and checked first; follow the progress on the dashboard.',
      });
      setConfirm('');
      onStarted();
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bk-form">
      <h3>2 · Where to restore</h3>
      <div className="bk-segmented" role="radiogroup" aria-label="Restore target">
        <button
          type="button"
          role="radio"
          aria-checked={where === 'original'}
          className={where === 'original' ? 'is-selected' : ''}
          onClick={() => {
            setWhere('original');
            setConfirm('');
          }}
        >
          Original place
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={where === 'other'}
          className={where === 'other' ? 'is-selected' : ''}
          onClick={() => {
            setWhere('other');
            setConfirm('');
          }}
        >
          Somewhere else
        </button>
      </div>
      {where === 'other' && (
        <div className="bk-grid">
          {isDb && (
            <Field label="Connection" hint="Another database server of the same kind">
              <select
                value={target.resourceId ?? ''}
                onChange={(e) => set({ resourceId: e.target.value || undefined })}
              >
                <option value="">Same as the backup</option>
                {options?.resources
                  .filter((r) => r.kind === sourceKind)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
              </select>
            </Field>
          )}
          {['postgres', 'mysql', 'mongodb', 'mssql'].includes(sourceKind) && (
            <Field
              label="Database name"
              hint={`Backed up from "${String(original.database ?? 'default')}"`}
            >
              <input
                value={target.database ?? ''}
                onChange={(e) => set({ database: e.target.value || undefined })}
                placeholder={`${String(original.database ?? 'db')}_restored`}
              />
            </Field>
          )}
          {['files', 'sqlite', 'firebird'].includes(sourceKind) && (
            <Field label={sourceKind === 'files' ? 'Folder' : 'File'} wide>
              <input
                value={target.path ?? ''}
                onChange={(e) => set({ path: e.target.value || undefined })}
                placeholder={String(original.path ?? '')}
              />
            </Field>
          )}
          {['docker-volume', 'docker-container'].includes(sourceKind) && (
            <Field
              label={sourceKind === 'docker-volume' ? 'Volume (created if missing)' : 'Image name'}
            >
              <input
                value={target.dockerName ?? ''}
                onChange={(e) => set({ dockerName: e.target.value || undefined })}
              />
            </Field>
          )}
          {sourceKind === 'firebird' && (
            <Field label="Server address">
              <input
                value={target.host ?? ''}
                onChange={(e) => set({ host: e.target.value || undefined })}
              />
            </Field>
          )}
          <Field label="On" hint="Where the restore runs (the tool / Docker / files are there)">
            <select
              value={target.tool?.runner ?? ''}
              onChange={(e) => set({ tool: { runner: e.target.value || undefined } as never })}
            >
              <option value="">Same as the backup</option>
              <option value="local">This machine</option>
              {options?.hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.connected ? '' : ' (offline)'}
                </option>
              ))}
            </select>
          </Field>
          {['firebird', 'custom'].includes(sourceKind) && (
            <Field label="Password there" hint="Used once, not saved">
              <input
                type="password"
                autoComplete="off"
                value={targetPassword}
                onChange={(e) => setTargetPassword(e.target.value)}
              />
            </Field>
          )}
        </div>
      )}
      <div className="bk-checks">
        {sourceKind === 'files' && (
          <label className="bk-check">
            <input
              type="checkbox"
              checked={applyDeletions}
              onChange={(e) => setApplyDeletions(e.target.checked)}
            />{' '}
            Also delete files that were removed before this backup (incremental chains)
          </label>
        )}
        {['postgres', 'mysql'].includes(sourceKind) && (
          <label className="bk-check">
            <input
              type="checkbox"
              checked={createDatabase}
              onChange={(e) => setCreateDatabase(e.target.checked)}
            />{' '}
            Create the database if it does not exist
          </label>
        )}
      </div>
      {plan?.encrypted && (
        <Field
          label="Passphrase"
          hint="Only if it is not the one saved with the job (a backup from another install)"
        >
          <input
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
        </Field>
      )}

      <h3>3 · Check and confirm</h3>
      {planError && <p className="bk-error">{planError}</p>}
      {plan && (
        <>
          <ol className="bk-plan">
            {plan.chain.map((c) => (
              <li key={c.id}>
                {c.type} backup of {formatDate(c.startedAt)} · {formatBytes(c.storedBytes)}
              </li>
            ))}
          </ol>
          <p className="bk-muted">
            {plan.chain.length > 1 ? `${plan.chain.length} files are restored in order. ` : ''}
            Each file is downloaded, its SHA-256 checked{plan.encrypted
              ? ' and decrypted'
              : ''}{' '}
            before anything is written.
          </p>
          {plan.problems.length > 0 && <p className="bk-error">{plan.problems.join('; ')}</p>}
          <div className="bk-danger">
            <p>
              This replaces data in <strong>{plan.label}</strong>
              {sourceKind === 'sqlite'
                ? ' (the current file is kept next to it as .pre-restore-…)'
                : sourceKind === 'docker-container'
                  ? ' (a new image is created; nothing is replaced)'
                  : ''}
              . Type <code>{plan.label}</code> to confirm.
            </p>
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              aria-label="Type the target name to confirm"
              placeholder={plan.label}
            />
            <button
              type="button"
              className="is-danger"
              disabled={busy || confirm.trim() !== plan.label || plan.problems.length > 0}
              onClick={() => void start()}
            >
              {busy ? 'Starting…' : 'Restore now'}
            </button>
          </div>
        </>
      )}
      {result && <p className={result.ok ? 'bk-ok' : 'bk-error'}>{result.text}</p>}
    </div>
  );
}
