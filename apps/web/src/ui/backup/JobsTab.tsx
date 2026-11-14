import {
  BACKUP_SOURCE_KINDS,
  type BackupSourceKind,
  type BackupType,
  type Compression,
  type JobInput,
  type RetentionPolicy,
  type SourceConfig,
  type ToolMode,
} from '@app/shared';
import { useState } from 'react';
import { backupApi, type BackupOptions, type JobWithText } from '../../data/backup-api';
import { useUiStore } from '../ui-store';
import {
  DestinationForm,
  describeDestination,
  FolderBrowser,
  useOptionsRefresh,
} from './DestinationsTab';
import { Empty, Field, formatBytes, formatWhen, StatusBadge, useLoad } from './shared';

const DB_KINDS: BackupSourceKind[] = ['postgres', 'mysql', 'mongodb', 'redis', 'mssql', 'sqlite'];

const MODE_LABELS: Record<ToolMode, string> = {
  driver: 'GRIDCITY itself (no tool needed)',
  'docker-image': 'A temporary Docker container (official image)',
  'docker-exec': 'Inside the database container (docker exec)',
  native: 'The tool installed where it runs',
};

const SCHEDULE_PRESETS: { label: string; cron: string | null }[] = [
  { label: 'Manual only', cron: null },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every day at 02:00', cron: '0 2 * * *' },
  { label: 'Every Sunday at 03:00', cron: '0 3 * * 0' },
  { label: 'Monthly, 1st at 04:00', cron: '0 4 1 * *' },
];

export function defaultSource(kind: BackupSourceKind, options: BackupOptions | null): SourceConfig {
  const modes = options?.capabilities[kind].modes ?? ['native'];
  const resource = options?.resources.find((r) => r.kind === kind);
  return {
    kind,
    resourceId: DB_KINDS.includes(kind) ? resource?.id : undefined,
    tool: { runner: 'local', mode: modes[0]! },
    exclude: [],
  };
}

export function JobsTab({
  options,
  reloadOptions,
  draft,
  clearDraft,
}: {
  options: BackupOptions | null;
  reloadOptions: () => void;
  /** A source picked in Discover, to start a new job with. */
  draft: Partial<SourceConfig> | null;
  clearDraft: () => void;
}) {
  const { data, error, reload } = useLoad(() => backupApi.jobs());
  const destinations = useLoad(() => backupApi.destinations());
  const [editing, setEditing] = useState<JobWithText | 'new' | null>(draft ? 'new' : null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (job: JobWithText, type?: BackupType) => {
    setBusy(job.id);
    try {
      await backupApi.runJob(job.id, type);
      setMessage({ ok: true, text: `${job.name}: backup started. Follow it on the dashboard.` });
    } catch (e) {
      setMessage({ ok: false, text: `${job.name}: ${(e as Error).message}` });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (job: JobWithText) => {
    if (
      !window.confirm(
        `Remove the job "${job.name}"?\n\nIts backups stay in history and in storage, and can still be restored.`,
      )
    )
      return;
    try {
      await backupApi.removeJob(job.id);
      reload();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    }
  };

  if (editing) {
    return (
      <JobEditor
        options={options}
        reloadOptions={reloadOptions}
        initial={editing === 'new' ? null : editing}
        draft={editing === 'new' ? draft : null}
        onDone={() => {
          setEditing(null);
          clearDraft();
          reload();
          destinations.reload();
        }}
        onCancel={() => {
          setEditing(null);
          clearDraft();
        }}
      />
    );
  }

  return (
    <section className="bk-section">
      <div className="bk-toolbar">
        <p className="bk-muted">What to back up, where to, how often and how long to keep it.</p>
        <button type="button" className="button-primary" onClick={() => setEditing('new')}>
          New backup job
        </button>
      </div>
      {error && <p className="bk-error">{error}</p>}
      {message && <p className={message.ok ? 'bk-ok' : 'bk-error'}>{message.text}</p>}
      {data && data.length === 0 && (
        <Empty title="No backup jobs yet">
          <p>
            Start from Discover to see what your servers and databases offer, or create a job
            directly.
          </p>
        </Empty>
      )}
      <div className="bk-cards">
        {data?.map((job) => {
          const caps = options?.capabilities[job.source.kind];
          return (
            <article key={job.id} className={`bk-card${job.problems.length ? ' is-warn' : ''}`}>
              <header>
                <strong>{job.name}</strong>
                <span className="bk-chip">
                  {options?.labels[job.source.kind] ?? job.source.kind}
                </span>
              </header>
              <dl className="bk-kv">
                <div>
                  <dt>Schedule</dt>
                  <dd>
                    {job.schedule
                      ? `${job.scheduleText}${job.scheduleEnabled ? '' : ' (paused)'}`
                      : 'Manual only'}
                  </dd>
                </div>
                <div>
                  <dt>Next run</dt>
                  <dd>
                    {job.nextRunAt
                      ? `${new Date(job.nextRunAt).toLocaleString()} (${formatWhen(job.nextRunAt)})`
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt>Last backup</dt>
                  <dd>
                    {job.lastRun ? (
                      <>
                        <StatusBadge status={job.lastRun.status} />{' '}
                        {formatWhen(job.lastRun.startedAt)} · {job.lastRun.type} ·{' '}
                        {formatBytes(job.lastRun.storedBytes)}
                      </>
                    ) : (
                      'never'
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Strategy</dt>
                  <dd>
                    {job.strategy}
                    {job.strategy !== 'full' ? `, full every ${job.fullEvery}` : ''} ·{' '}
                    {job.compression}
                    {job.encrypt ? ' · encrypted' : ''}
                  </dd>
                </div>
                <div>
                  <dt>Destinations</dt>
                  <dd>
                    {job.destinationIds
                      .map((id) => destinations.data?.find((d) => d.id === id)?.name ?? id)
                      .join(', ')}
                  </dd>
                </div>
              </dl>
              {job.problems.length > 0 && <p className="bk-warn">{job.problems.join('; ')}</p>}
              {job.lastRun?.status === 'failed' && job.lastRun.error && (
                <p className="bk-error">{job.lastRun.error}</p>
              )}
              <footer>
                <button
                  type="button"
                  className="button-primary"
                  disabled={busy === job.id || job.problems.length > 0}
                  onClick={() => void run(job)}
                >
                  Back up now
                </button>
                {caps?.incremental || caps?.differential ? (
                  <button
                    type="button"
                    disabled={busy === job.id}
                    onClick={() => void run(job, 'full')}
                    title="Start a new chain with a full backup"
                  >
                    Full now
                  </button>
                ) : null}
                <button type="button" onClick={() => setEditing(job)}>
                  Edit
                </button>
                <button type="button" onClick={() => useUiStore.getState().openBackups('history')}>
                  History
                </button>
                <button type="button" onClick={() => void remove(job)}>
                  Remove
                </button>
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function numberOrUndefined(value: string): number | undefined {
  const n = Number(value);
  return value.trim() === '' || !Number.isFinite(n) || n < 1 ? undefined : Math.floor(n);
}

export function JobEditor({
  options,
  reloadOptions,
  initial,
  draft,
  onDone,
  onCancel,
}: {
  options: BackupOptions | null;
  reloadOptions: () => void;
  initial: JobWithText | null;
  draft: Partial<SourceConfig> | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  useOptionsRefresh(reloadOptions);
  const destinations = useLoad(() => backupApi.destinations());
  const startKind = draft?.kind ?? initial?.source.kind ?? 'postgres';
  const [source, setSource] = useState<SourceConfig>(
    () =>
      initial?.source ??
      ({
        ...defaultSource(startKind, options),
        ...draft,
        tool: { ...defaultSource(startKind, options).tool, ...(draft?.tool ?? {}) },
      } as SourceConfig),
  );
  const [name, setName] = useState(initial?.name ?? '');
  const [destinationIds, setDestinationIds] = useState<string[]>(initial?.destinationIds ?? []);
  const [addingDestination, setAddingDestination] = useState(false);
  const [schedule, setSchedule] = useState<string | null>(initial ? initial.schedule : '0 2 * * *');
  const [scheduleEnabled, setScheduleEnabled] = useState(initial?.scheduleEnabled ?? true);
  const [strategy, setStrategy] = useState<BackupType>(initial?.strategy ?? 'full');
  const [fullEvery, setFullEvery] = useState(String(initial?.fullEvery ?? 7));
  const [retention, setRetention] = useState<Record<keyof RetentionPolicy, string>>({
    keepLast: String(initial?.retention.keepLast ?? (initial ? '' : '14')),
    keepDaily: String(initial?.retention.keepDaily ?? ''),
    keepWeekly: String(initial?.retention.keepWeekly ?? ''),
    keepMonthly: String(initial?.retention.keepMonthly ?? ''),
    maxAgeDays: String(initial?.retention.maxAgeDays ?? ''),
  });
  const [compression, setCompression] = useState<Compression>(initial?.compression ?? 'gzip');
  const [encrypt, setEncrypt] = useState(initial?.encrypt ?? false);
  const [passphrase, setPassphrase] = useState('');
  const [passphrase2, setPassphrase2] = useState('');
  const [sourcePassword, setSourcePassword] = useState('');
  const [verifyAfterUpload, setVerify] = useState(initial?.verifyAfterUpload ?? true);
  const [notifyOnSuccess, setNotifySuccess] = useState(initial?.notifyOnSuccess ?? true);
  const [notifyOnFailure, setNotifyFailure] = useState(initial?.notifyOnFailure ?? true);
  const [browsing, setBrowsing] = useState(false);
  const [sourceStatus, setSourceStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const caps = options?.capabilities[source.kind];
  const resources = options?.resources.filter((r) => r.kind === source.kind) ?? [];
  const isDb = DB_KINDS.includes(source.kind);
  const usesRunnerForData = ['files', 'docker-volume', 'docker-container', 'custom'].includes(
    source.kind,
  );
  const set = (patch: Partial<SourceConfig>) => {
    setSource((s) => ({ ...s, ...patch, tool: { ...s.tool, ...(patch.tool ?? {}) } }));
    setSourceStatus(null);
  };
  const changeKind = (kind: BackupSourceKind) => {
    setSource(defaultSource(kind, options));
    setStrategy('full');
    setSourceStatus(null);
  };
  const isPreset = SCHEDULE_PRESETS.some((p) => p.cron === schedule);

  const testSource = async () => {
    setBusy(true);
    setSourceStatus(
      await backupApi.testSource(source).catch((e: Error) => ({ ok: false, message: e.message })),
    );
    setBusy(false);
  };

  const save = async () => {
    setError(null);
    if (encrypt && passphrase !== passphrase2)
      return setError('The two passphrases are not the same.');
    if (encrypt && !initial?.hasPassphrase && passphrase.length < 8)
      return setError('The passphrase needs at least 8 characters.');
    const input: JobInput = {
      name: name.trim() || defaultName(),
      source,
      destinationIds,
      schedule,
      scheduleEnabled,
      strategy,
      fullEvery: numberOrUndefined(fullEvery) ?? 7,
      retention: Object.fromEntries(
        Object.entries(retention)
          .map(([k, v]) => [k, numberOrUndefined(v)])
          .filter(([, v]) => v !== undefined),
      ),
      compression,
      encrypt,
      ...(passphrase ? { passphrase } : {}),
      ...(sourcePassword ? { sourcePassword } : {}),
      verifyAfterUpload,
      notifyOnSuccess,
      notifyOnFailure,
    };
    setBusy(true);
    try {
      await backupApi.saveJob(initial?.id ?? null, input);
      useUiStore.getState().showNotice(`Backup job "${input.name}" saved.`);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const defaultName = () => {
    const label = options?.labels[source.kind] ?? source.kind;
    const what =
      source.database ||
      options?.resources.find((r) => r.id === source.resourceId)?.name ||
      source.dockerName ||
      source.path ||
      '';
    return `${label}${what ? ` · ${what}` : ''}`.slice(0, 80);
  };

  const runnerSelect = (label: string, hint: string) => (
    <Field label={label} hint={hint}>
      <select
        value={source.tool.runner}
        onChange={(e) => set({ tool: { ...source.tool, runner: e.target.value } })}
      >
        <option value="local">This machine</option>
        {options?.hosts.map((h) => (
          <option key={h.id} value={h.id}>
            {h.name}
            {h.connected ? '' : ' (offline)'}
          </option>
        ))}
      </select>
    </Field>
  );

  return (
    <section className="bk-section bk-form">
      <h3>{initial ? `Edit ${initial.name}` : 'New backup job'}</h3>

      <fieldset className="bk-step">
        <legend>1 · What to back up</legend>
        <div className="bk-grid">
          <Field label="Source type">
            <select
              value={source.kind}
              onChange={(e) => changeKind(e.target.value as BackupSourceKind)}
              disabled={Boolean(initial)}
            >
              {BACKUP_SOURCE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {options?.labels[k] ?? k}
                </option>
              ))}
            </select>
          </Field>
          {isDb && (
            <Field label="Connection" hint="Its saved login is reused">
              <div className="bk-inline">
                <select
                  value={source.resourceId ?? ''}
                  onChange={(e) => set({ resourceId: e.target.value || undefined })}
                >
                  {resources.length === 0 && <option value="">None connected yet</option>}
                  {source.kind === 'sqlite' && <option value="">(a file path below)</option>}
                  {resources.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => useUiStore.getState().setConnectResourceOpen(true)}
                >
                  Connect new…
                </button>
              </div>
            </Field>
          )}
          {['postgres', 'mysql', 'mongodb', 'mssql'].includes(source.kind) && (
            <Field
              label="Database"
              hint="Empty: the connection's default (MySQL / MongoDB: all databases)"
            >
              <input
                value={source.database ?? ''}
                onChange={(e) => set({ database: e.target.value || undefined })}
                placeholder={resources.find((r) => r.id === source.resourceId)?.database ?? ''}
              />
            </Field>
          )}
          {source.kind === 'firebird' && (
            <>
              <Field label="Server address" hint="Empty with docker exec: the container itself">
                <input
                  value={source.host ?? ''}
                  onChange={(e) => set({ host: e.target.value || undefined })}
                  placeholder="10.0.0.5"
                />
              </Field>
              <Field label="Port">
                <input
                  type="number"
                  value={source.port ?? ''}
                  onChange={(e) =>
                    set({ port: e.target.value ? Number(e.target.value) : undefined })
                  }
                  placeholder="3050"
                />
              </Field>
              <Field label="User">
                <input
                  value={source.user ?? ''}
                  onChange={(e) => set({ user: e.target.value || undefined })}
                  placeholder="SYSDBA"
                />
              </Field>
              <Field
                label="Password"
                hint={
                  initial?.hasSourcePassword
                    ? 'Saved encrypted; leave empty to keep'
                    : 'Saved encrypted in the vault'
                }
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  value={sourcePassword}
                  onChange={(e) => setSourcePassword(e.target.value)}
                />
              </Field>
            </>
          )}
          {(source.kind === 'firebird' || source.kind === 'sqlite' || source.kind === 'files') && (
            <Field
              label={source.kind === 'files' ? 'Folder' : 'Database file'}
              wide
              hint={
                source.kind === 'files'
                  ? 'Everything inside is backed up'
                  : source.kind === 'sqlite'
                    ? "Overrides the connection's path (for a file on a server)"
                    : 'Path on the Firebird server'
              }
            >
              <div className="bk-inline">
                <input
                  value={source.path ?? ''}
                  onChange={(e) => set({ path: e.target.value || undefined })}
                  placeholder={
                    source.kind === 'files' ? '/srv/app' : '/var/lib/firebird/data/app.fdb'
                  }
                />
                {source.kind === 'files' && (
                  <button type="button" onClick={() => setBrowsing((b) => !b)}>
                    Browse…
                  </button>
                )}
              </div>
            </Field>
          )}
          {source.kind === 'files' && (
            <Field
              label="Leave out"
              hint="One pattern per line: node_modules, *.log, cache/**"
              wide
            >
              <textarea
                rows={3}
                value={source.exclude.join('\n')}
                onChange={(e) =>
                  set({
                    exclude: e.target.value
                      .split('\n')
                      .map((l) => l.trim())
                      .filter(Boolean),
                  })
                }
              />
            </Field>
          )}
          {(source.kind === 'docker-volume' || source.kind === 'docker-container') && (
            <Field
              label={source.kind === 'docker-volume' ? 'Volume' : 'Container'}
              hint="Discover lists them"
            >
              <input
                value={source.dockerName ?? ''}
                onChange={(e) => set({ dockerName: e.target.value || undefined })}
              />
            </Field>
          )}
          {source.kind === 'custom' && (
            <>
              <Field
                label="Backup command"
                hint="Writes the backup to stdout. $BACKUP_PASSWORD holds the saved password."
                wide
              >
                <textarea
                  rows={2}
                  value={source.backupCommand ?? ''}
                  onChange={(e) => set({ backupCommand: e.target.value })}
                  placeholder="pg_dumpall -U postgres"
                />
              </Field>
              <Field label="Restore command" hint="Reads the backup on stdin (optional)" wide>
                <textarea
                  rows={2}
                  value={source.restoreCommand ?? ''}
                  onChange={(e) => set({ restoreCommand: e.target.value })}
                  placeholder="psql -U postgres"
                />
              </Field>
              <Field label="Password" hint="Optional, available as $BACKUP_PASSWORD">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={sourcePassword}
                  onChange={(e) => setSourcePassword(e.target.value)}
                />
              </Field>
            </>
          )}
          {usesRunnerForData &&
            runnerSelect('On', 'This machine, or a server over its SSH connection')}
        </div>
        {browsing && source.kind === 'files' && (
          <FolderBrowser
            query={
              source.tool.runner === 'local'
                ? { kind: 'local', path: source.path ?? '' }
                : { kind: 'sftp', hostId: source.tool.runner, path: source.path ?? '' }
            }
            onPick={(p) => {
              set({ path: p });
              setBrowsing(false);
            }}
          />
        )}
        {!usesRunnerForData && caps && (caps.modes.length > 1 || caps.modes[0] !== 'driver') && (
          <div className="bk-grid">
            <Field label="How the backup is taken">
              <select
                value={source.tool.mode}
                onChange={(e) =>
                  set({ tool: { ...source.tool, mode: e.target.value as ToolMode } })
                }
              >
                {caps.modes.map((m) => (
                  <option key={m} value={m}>
                    {MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </Field>
            {source.tool.mode !== 'driver' &&
              runnerSelect('Runs on', 'Where Docker or the tool is')}
            {source.tool.mode === 'docker-image' && (
              <Field label="Image" hint="Match the server's major version">
                <input
                  value={source.tool.image ?? ''}
                  onChange={(e) =>
                    set({ tool: { ...source.tool, image: e.target.value || undefined } })
                  }
                  placeholder={
                    {
                      postgres: 'postgres:17-alpine',
                      mysql: 'mysql:8.4',
                      mongodb: 'mongo:8.0',
                      firebird: 'firebirdsql/firebird:5',
                    }[source.kind as string] ?? ''
                  }
                />
              </Field>
            )}
            {source.tool.mode === 'docker-exec' && (
              <Field label="Container" hint="The database's own container">
                <input
                  value={source.tool.container ?? ''}
                  onChange={(e) =>
                    set({ tool: { ...source.tool, container: e.target.value || undefined } })
                  }
                  placeholder="db"
                />
              </Field>
            )}
          </div>
        )}
        <div className="bk-actions">
          <button type="button" disabled={busy} onClick={() => void testSource()}>
            Test source
          </button>
          {sourceStatus && (
            <span className={sourceStatus.ok ? 'bk-ok' : 'bk-error'}>
              {sourceStatus.ok ? '✓ ' : '✗ '}
              {sourceStatus.message}
            </span>
          )}
        </div>
      </fieldset>

      <fieldset className="bk-step">
        <legend>2 · Where to store it</legend>
        {destinations.data && destinations.data.length === 0 && !addingDestination && (
          <p className="bk-muted">No destination yet: add one below.</p>
        )}
        <ul className="bk-checklist">
          {destinations.data?.map((d) => (
            <li key={d.id}>
              <label>
                <input
                  type="checkbox"
                  checked={destinationIds.includes(d.id)}
                  onChange={(e) =>
                    setDestinationIds((ids) =>
                      e.target.checked ? [...ids, d.id] : ids.filter((i) => i !== d.id),
                    )
                  }
                />
                <strong>{d.name}</strong>{' '}
                <span className="bk-muted">{describeDestination(d, options)}</span>
              </label>
            </li>
          ))}
        </ul>
        {addingDestination ? (
          <DestinationForm
            options={options}
            reloadOptions={reloadOptions}
            initial={null}
            onCancel={() => setAddingDestination(false)}
            onDone={(id) => {
              setAddingDestination(false);
              setDestinationIds((ids) => [...ids, id]);
              destinations.reload();
            }}
          />
        ) : (
          <button type="button" onClick={() => setAddingDestination(true)}>
            + New destination
          </button>
        )}
      </fieldset>

      <fieldset className="bk-step">
        <legend>3 · Schedule and retention</legend>
        <div className="bk-grid">
          <Field label="When">
            <select
              value={isPreset ? String(schedule) : 'custom'}
              onChange={(e) =>
                setSchedule(
                  e.target.value === 'custom'
                    ? (schedule ?? '30 1 * * *')
                    : e.target.value === 'null'
                      ? null
                      : e.target.value,
                )
              }
            >
              {SCHEDULE_PRESETS.map((p) => (
                <option key={p.label} value={String(p.cron)}>
                  {p.label}
                </option>
              ))}
              <option value="custom">Custom (cron)…</option>
            </select>
          </Field>
          {schedule !== null && (
            <Field label="Cron expression" hint="minute hour day month weekday, server time">
              <input
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="bk-mono"
              />
            </Field>
          )}
          {schedule !== null && (
            <label className="bk-check">
              <input
                type="checkbox"
                checked={scheduleEnabled}
                onChange={(e) => setScheduleEnabled(e.target.checked)}
              />{' '}
              Schedule active
            </label>
          )}
          <Field
            label="Backup type"
            hint={
              caps?.incremental || caps?.differential
                ? 'Incremental: changes since the last backup. Differential: since the last full.'
                : 'Only full backups for this source'
            }
          >
            <select value={strategy} onChange={(e) => setStrategy(e.target.value as BackupType)}>
              <option value="full">Full every time</option>
              {caps?.incremental && <option value="incremental">Incremental</option>}
              {caps?.differential && <option value="differential">Differential</option>}
            </select>
          </Field>
          {strategy !== 'full' && (
            <Field label="A full backup every" hint="runs">
              <input
                type="number"
                min={1}
                max={365}
                value={fullEvery}
                onChange={(e) => setFullEvery(e.target.value)}
              />
            </Field>
          )}
        </div>
        <p className="bk-muted">
          Keep (empty = no limit; with every field empty nothing is ever deleted). The newest backup
          and every backup a kept one depends on are always kept.
        </p>
        <div className="bk-grid is-compact">
          {(
            [
              ['keepLast', 'Last N backups'],
              ['keepDaily', 'Daily (days)'],
              ['keepWeekly', 'Weekly (weeks)'],
              ['keepMonthly', 'Monthly (months)'],
              ['maxAgeDays', 'Everything younger than (days)'],
            ] as const
          ).map(([key, label]) => (
            <Field key={key} label={label}>
              <input
                type="number"
                min={1}
                value={retention[key]}
                onChange={(e) => setRetention((r) => ({ ...r, [key]: e.target.value }))}
              />
            </Field>
          ))}
        </div>
      </fieldset>

      <fieldset className="bk-step">
        <legend>4 · Protection and notifications</legend>
        <div className="bk-grid">
          <Field label="Compression">
            <select
              value={compression}
              onChange={(e) => setCompression(e.target.value as Compression)}
            >
              <option value="gzip">gzip</option>
              {options?.zstd && <option value="zstd">zstd (faster, smaller)</option>}
              <option value="none">none</option>
            </select>
          </Field>
          <label className="bk-check">
            <input
              type="checkbox"
              checked={encrypt}
              onChange={(e) => setEncrypt(e.target.checked)}
            />{' '}
            Encrypt (AES-256-GCM)
          </label>
          {encrypt && (
            <>
              <Field
                label="Passphrase"
                hint={
                  initial?.hasPassphrase
                    ? 'Saved; type a new one only to change it (older backups keep working)'
                    : 'Write it down: without it a backup cannot be restored on another install'
                }
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                />
              </Field>
              <Field label="Passphrase again">
                <input
                  type="password"
                  autoComplete="new-password"
                  value={passphrase2}
                  onChange={(e) => setPassphrase2(e.target.value)}
                />
              </Field>
            </>
          )}
        </div>
        <div className="bk-checks">
          <label className="bk-check">
            <input
              type="checkbox"
              checked={verifyAfterUpload}
              onChange={(e) => setVerify(e.target.checked)}
            />{' '}
            Verify each upload (SHA-256 read back)
          </label>
          <label className="bk-check">
            <input
              type="checkbox"
              checked={notifyOnFailure}
              onChange={(e) => setNotifyFailure(e.target.checked)}
            />{' '}
            Email / chat on failure
          </label>
          <label className="bk-check">
            <input
              type="checkbox"
              checked={notifyOnSuccess}
              onChange={(e) => setNotifySuccess(e.target.checked)}
            />{' '}
            Email / chat on success
          </label>
        </div>
        <p className="bk-muted">
          Channels are set in Settings → Alerts (tick "Backups"). In-app notifications are always
          on.
        </p>
      </fieldset>

      <fieldset className="bk-step">
        <legend>5 · Name</legend>
        <Field label="Job name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={defaultName()}
            maxLength={80}
          />
        </Field>
      </fieldset>

      {error && <p className="bk-error">{error}</p>}
      <div className="bk-actions is-sticky">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="button-primary"
          disabled={busy || destinationIds.length === 0}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : initial ? 'Save changes' : 'Create job'}
        </button>
      </div>
    </section>
  );
}
