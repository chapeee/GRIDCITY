import type { DestinationInput, DestinationKind, DestinationView } from '@app/shared';
import { useEffect, useRef, useState } from 'react';
import { backupApi, type BackupOptions, type BrowseResult } from '../../data/backup-api';
import { useUiStore } from '../ui-store';
import { Empty, Field, formatBytes, useLoad } from './shared';

const KIND_LABELS: Record<DestinationKind, string> = {
  local: 'Local folder',
  s3: 'S3 / S3-compatible',
  sftp: 'SFTP (a connected server)',
};

/** The editable part of a saved destination. */
export function toInput(d: DestinationView): DestinationInput {
  if (d.kind === 'local') return { kind: 'local', name: d.name, path: d.path };
  if (d.kind === 's3')
    return {
      kind: 's3',
      name: d.name,
      resourceId: d.resourceId,
      bucket: d.bucket,
      prefix: d.prefix,
    };
  return { kind: 'sftp', name: d.name, hostId: d.hostId, path: d.path };
}

export function describeDestination(d: DestinationInput, options: BackupOptions | null): string {
  if (d.kind === 'local') return d.path;
  if (d.kind === 's3') {
    const account = options?.resources.find((r) => r.id === d.resourceId)?.name ?? d.resourceId;
    return `${account} · s3://${d.bucket}/${d.prefix}`;
  }
  const host = options?.hosts.find((h) => h.id === d.hostId)?.name ?? d.hostId;
  return `${host}:${d.path}`;
}

/**
 * Re-reads options whenever a dialog of the main app closes (a server or a
 * storage account added from here shows up at once).
 */
export function useOptionsRefresh(reload: () => void) {
  const addHost = useUiStore((s) => s.addHostOpen);
  const connect = useUiStore((s) => s.connectResourceOpen);
  const was = useRef(false);
  const open = addHost || connect;
  useEffect(() => {
    if (was.current && !open) reload();
    was.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
}

export function DestinationsTab({
  options,
  reloadOptions,
}: {
  options: BackupOptions | null;
  reloadOptions: () => void;
}) {
  const { data, error, reload } = useLoad(() => backupApi.destinations());
  const [editing, setEditing] = useState<DestinationView | 'new' | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const remove = async (d: DestinationView) => {
    if (!window.confirm(`Remove "${d.name}"? Backups already stored there are NOT deleted.`))
      return;
    setBusy(d.id);
    try {
      await backupApi.removeDestination(d.id);
      reload();
    } catch (reason) {
      setMessage((reason as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const test = async (d: DestinationView) => {
    setBusy(d.id);
    const result = await backupApi
      .testDestination(toInput(d))
      .catch((e: Error) => ({ ok: false, message: e.message }));
    setMessage(`${d.name}: ${result.ok ? '✓ ' : '✗ '}${result.message}`);
    setBusy(null);
  };

  if (editing) {
    return (
      <DestinationForm
        options={options}
        reloadOptions={reloadOptions}
        initial={editing === 'new' ? null : editing}
        onDone={() => {
          setEditing(null);
          reload();
        }}
        onCancel={() => setEditing(null)}
      />
    );
  }

  return (
    <section className="bk-section">
      <div className="bk-toolbar">
        <p className="bk-muted">
          Where backups are stored. One backup can go to several places; each upload is tracked on
          its own.
        </p>
        <button type="button" className="button-primary" onClick={() => setEditing('new')}>
          Add destination
        </button>
      </div>
      {error && <p className="bk-error">{error}</p>}
      {message && <p className="bk-note">{message}</p>}
      {data && data.length === 0 && (
        <Empty title="No destinations yet">
          <p>
            Add a local folder, an S3 bucket (your connected storage accounts are reused) or a
            folder on a connected server over SFTP.
          </p>
        </Empty>
      )}
      <div className="bk-cards">
        {data?.map((d) => (
          <article key={d.id} className="bk-card">
            <header>
              <strong>{d.name}</strong>
              <span className="bk-chip">{KIND_LABELS[d.kind]}</span>
            </header>
            <p className="bk-mono">{describeDestination(d, options)}</p>
            <dl className="bk-kv">
              <div>
                <dt>Stored</dt>
                <dd>
                  {formatBytes(d.storedBytes)} in {d.backupCount} backup
                  {d.backupCount === 1 ? '' : 's'}
                </dd>
              </div>
              <div>
                <dt>Used by</dt>
                <dd>{d.usedBy.length ? d.usedBy.join(', ') : 'no job'}</dd>
              </div>
            </dl>
            <footer>
              <button type="button" disabled={busy === d.id} onClick={() => void test(d)}>
                Test
              </button>
              <button type="button" onClick={() => setEditing(d)}>
                Edit
              </button>
              <button
                type="button"
                disabled={busy === d.id || d.usedBy.length > 0}
                title={d.usedBy.length ? 'In use by a job' : undefined}
                onClick={() => void remove(d)}
              >
                Remove
              </button>
            </footer>
          </article>
        ))}
      </div>
    </section>
  );
}

export function DestinationForm({
  options,
  reloadOptions,
  initial,
  onDone,
  onCancel,
}: {
  options: BackupOptions | null;
  reloadOptions: () => void;
  initial: DestinationView | null;
  onDone: (id: string) => void;
  onCancel: () => void;
}) {
  useOptionsRefresh(reloadOptions);
  const s3Accounts = options?.resources.filter((r) => r.kind === 's3') ?? [];
  const [kind, setKind] = useState<DestinationKind>(initial?.kind ?? 'local');
  const [name, setName] = useState(initial?.name ?? '');
  const [path, setPath] = useState(
    initial && initial.kind !== 's3' ? initial.path : (options?.defaultLocalDir ?? ''),
  );
  const [chosenResourceId, setResourceId] = useState(
    initial?.kind === 's3' ? initial.resourceId : '',
  );
  const resourceId = chosenResourceId || s3Accounts[0]?.id || '';
  const [bucket, setBucket] = useState(initial?.kind === 's3' ? initial.bucket : '');
  const [prefix, setPrefix] = useState(
    initial?.kind === 's3' ? initial.prefix : 'gridcity-backups',
  );
  const [chosenHostId, setHostId] = useState(initial?.kind === 'sftp' ? initial.hostId : '');
  const hostId = chosenHostId || options?.hosts[0]?.id || '';
  const [browsing, setBrowsing] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const input = (): DestinationInput => {
    const label =
      name.trim() ||
      (kind === 'local' ? 'Local folder' : kind === 's3' ? `S3 ${bucket}` : `SFTP ${hostId}`);
    if (kind === 'local') return { kind, name: label, path };
    if (kind === 's3')
      return { kind, name: label, resourceId, bucket, prefix: prefix.replace(/^\/+|\/+$/g, '') };
    return { kind, name: label, hostId, path };
  };

  const test = async () => {
    setBusy(true);
    setStatus(
      await backupApi
        .testDestination(input())
        .catch((e: Error) => ({ ok: false, message: e.message })),
    );
    setBusy(false);
  };

  const save = async () => {
    setBusy(true);
    try {
      const tested = await backupApi.testDestination(input());
      if (!tested.ok && !window.confirm(`The test failed: ${tested.message}\n\nSave anyway?`))
        return;
      const { id } = await backupApi.saveDestination(initial?.id ?? null, input());
      onDone(id);
    } catch (reason) {
      setStatus({ ok: false, message: (reason as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const browseQuery =
    kind === 's3'
      ? { kind, resourceId, path: bucket ? `${bucket}/${prefix}` : '' }
      : kind === 'sftp'
        ? { kind, hostId, path }
        : { kind, path };

  return (
    <section className="bk-section bk-form">
      <h3>{initial ? `Edit ${initial.name}` : 'New destination'}</h3>
      {initial && initial.backupCount > 0 && (
        <p className="bk-note">
          Backups already stored stay where they are; changing the location applies to new backups
          only.
        </p>
      )}
      <div className="bk-segmented" role="radiogroup" aria-label="Destination type">
        {(['local', 's3', 'sftp'] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={kind === k}
            className={kind === k ? 'is-selected' : ''}
            onClick={() => {
              if (k !== kind)
                setPath(
                  k === 'local'
                    ? (options?.defaultLocalDir ?? '')
                    : k === 'sftp'
                      ? '/srv/backups'
                      : '',
                );
              setKind(k);
              setStatus(null);
              setBrowsing(false);
            }}
          >
            {KIND_LABELS[k]}
          </button>
        ))}
      </div>
      <div className="bk-grid">
        <Field label="Name" hint="Shown in jobs and history">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              kind === 'local' ? 'Backup disk' : kind === 's3' ? 'Offsite S3' : 'NAS over SFTP'
            }
            maxLength={80}
          />
        </Field>
        {kind === 's3' && (
          <Field label="Storage account" hint="Reuses the access keys saved for it">
            <div className="bk-inline">
              <select
                value={resourceId}
                onChange={(e) => {
                  setResourceId(e.target.value);
                  setBucket('');
                }}
              >
                {s3Accounts.length === 0 && <option value="">No storage account connected</option>}
                {s3Accounts.map((r) => (
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
        {kind === 'sftp' && (
          <Field label="Server" hint="Reuses its SSH connection; no new login">
            <div className="bk-inline">
              <select value={hostId} onChange={(e) => setHostId(e.target.value)}>
                {options?.hosts.length === 0 && <option value="">No server connected</option>}
                {options?.hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                    {h.connected ? '' : ' (offline)'}
                  </option>
                ))}
              </select>
              <button type="button" onClick={() => useUiStore.getState().setAddHostOpen(true)}>
                Add server…
              </button>
            </div>
          </Field>
        )}
        {kind === 's3' ? (
          <>
            <Field label="Bucket">
              <input
                value={bucket}
                onChange={(e) => setBucket(e.target.value.trim())}
                placeholder="my-backups"
              />
            </Field>
            <Field label="Folder (prefix)" hint="Created on the first upload">
              <input
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
                placeholder="gridcity-backups"
              />
            </Field>
          </>
        ) : (
          <Field
            label="Folder"
            hint={
              kind === 'local' ? 'On the machine GRIDCITY runs on' : 'Absolute path on the server'
            }
            wide
          >
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder={kind === 'local' ? options?.defaultLocalDir : '/srv/backups'}
            />
          </Field>
        )}
      </div>
      <div className="bk-actions">
        <button
          type="button"
          onClick={() => setBrowsing((b) => !b)}
          disabled={(kind === 's3' && !resourceId) || (kind === 'sftp' && !hostId)}
        >
          {browsing ? 'Hide browser' : kind === 's3' ? 'Browse buckets…' : 'Browse folders…'}
        </button>
      </div>
      {browsing && (
        <FolderBrowser
          query={browseQuery}
          onPick={(picked) => {
            if (kind === 's3') {
              const [b = '', ...rest] = picked.split('/');
              setBucket(b);
              setPrefix(rest.filter(Boolean).join('/'));
            } else setPath(picked);
            setBrowsing(false);
          }}
        />
      )}
      {status && (
        <p className={status.ok ? 'bk-ok' : 'bk-error'}>
          {status.ok ? '✓ ' : '✗ '}
          {status.message}
        </p>
      )}
      <div className="bk-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" disabled={busy} onClick={() => void test()}>
          {busy ? 'Working…' : 'Test connection'}
        </button>
        <button
          type="button"
          className="button-primary"
          disabled={
            busy || (kind === 's3' ? !resourceId || !bucket : !path) || (kind === 'sftp' && !hostId)
          }
          onClick={() => void save()}
        >
          Save destination
        </button>
      </div>
    </section>
  );
}

/** Lists folders (or buckets and prefixes); create a folder; pick one. */
export function FolderBrowser({
  query,
  onPick,
}: {
  query: { kind: DestinationKind; path: string; resourceId?: string; hostId?: string };
  onPick: (path: string) => void;
}) {
  const [path, setPath] = useState(query.path);
  const [result, setResult] = useState<BrowseResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  useEffect(() => {
    let cancelled = false;
    backupApi.browse({ ...query, path }).then(
      (r) => {
        if (cancelled) return;
        setResult(r);
        setError(null);
      },
      (e: Error) => {
        if (!cancelled) setError(e.message);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, query.kind, query.resourceId, query.hostId]);

  const child = (name: string) => {
    if (!result) return name;
    if (query.kind === 's3') return result.path ? `${result.path}${name}/` : `${name}/`;
    if (!result.path) return name; // a Windows drive
    const sep = result.path.includes('\\') ? '\\' : '/';
    return result.path.endsWith(sep) ? `${result.path}${name}` : `${result.path}${sep}${name}`;
  };

  const create = async () => {
    try {
      const made = await backupApi.mkdir({
        ...query,
        path: result?.path ?? path,
        name: newName.trim(),
      });
      setNewName('');
      setPath(made.path);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const canPick = query.kind === 's3' ? Boolean(result?.path) : Boolean(result?.path);
  return (
    <div className="bk-browser">
      <div className="bk-browser-bar">
        <button
          type="button"
          disabled={result?.parent === null || result?.parent === undefined}
          onClick={() => setPath(result?.parent ?? '')}
          aria-label="Up one folder"
        >
          ↑
        </button>
        <code>
          {result?.path ||
            (query.kind === 's3' ? 'Buckets' : query.kind === 'local' ? 'Drives' : '…')}
        </code>
        {result?.freeBytes ? (
          <span className="bk-muted">{formatBytes(result.freeBytes)} free</span>
        ) : null}
      </div>
      {error && (
        <p className="bk-error">
          {error}{' '}
          {path !== '' && (
            <button type="button" className="bk-link" onClick={() => setPath('')}>
              {query.kind === 's3' ? 'Show buckets' : 'Go to the home folder'}
            </button>
          )}
        </p>
      )}
      <ul className="bk-browser-list">
        {result?.entries.length === 0 && <li className="bk-muted">Empty</li>}
        {result?.entries.map((e) =>
          e.type === 'dir' ? (
            <li key={e.name}>
              <button
                type="button"
                className="bk-link"
                onClick={() =>
                  setPath(query.kind === 's3' ? child(e.name).replace(/\/$/, '') : child(e.name))
                }
              >
                ▸ {e.name}
              </button>
            </li>
          ) : (
            <li key={e.name} className="bk-muted">
              {e.name} <span>{formatBytes(e.size)}</span>
            </li>
          ),
        )}
      </ul>
      <div className="bk-browser-bar">
        {(result?.path || query.kind !== 's3') && (
          <span className="bk-inline">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New folder name"
              aria-label="New folder name"
            />
            <button
              type="button"
              disabled={!newName.trim() || !result?.path}
              onClick={() => void create()}
            >
              Create
            </button>
          </span>
        )}
        <button
          type="button"
          className="button-primary"
          disabled={!canPick}
          onClick={() => onPick(result!.path)}
        >
          Use this {query.kind === 's3' && !result?.path.includes('/') ? 'bucket' : 'folder'}
        </button>
      </div>
    </div>
  );
}
