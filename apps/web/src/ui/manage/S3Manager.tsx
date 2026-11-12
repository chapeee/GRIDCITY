import type {
  ExploreInfo,
  S3BucketInfo,
  S3BucketSettings,
  S3ListResult,
  S3ObjectDetail,
  S3UsageResult,
} from '@app/shared';
import { useCallback, useEffect, useMemo, useState, type DragEvent } from 'react';
import type { ExploreApi } from '../../data/explore-api';
import { formatBytes } from '../format';
import { CodeEditor } from './CodeEditor';
import { DeleteButton } from './DataGrid';

type Tab = 'objects' | 'settings' | 'usage';

export function S3Manager({
  api,
  info,
  initialBucket,
}: {
  api: ExploreApi;
  info: ExploreInfo;
  initialBucket?: string;
}) {
  const [buckets, setBuckets] = useState<S3BucketInfo[]>([]);
  const [bucket, setBucket] = useState<string | null>(initialBucket ?? null);
  const [tab, setTab] = useState<Tab>('objects');
  const [error, setError] = useState<string | null>(null);
  const [newBucket, setNewBucket] = useState('');
  const writable = info.mode === 'write';

  const loadBuckets = useCallback(() => {
    api.s3
      .buckets()
      .then(({ buckets: list }) => {
        setBuckets(list);
        setBucket((current) => current ?? list[0]?.name ?? null);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api]);
  useEffect(loadBuckets, [loadBuckets]);

  const bucketAction = async (action: 'createBucket' | 'deleteBucket', name: string) => {
    setError(null);
    try {
      await api.s3.action({ bucket: name, action });
      if (action === 'deleteBucket') setBucket(null);
      else setBucket(name);
      loadBuckets();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <div className="manage-split">
      <nav className="manage-sidebar" aria-label="Buckets">
        <p className="manage-muted">{buckets.length} buckets</p>
        <div className="tree">
          {buckets.map((b) => (
            <button
              key={b.name}
              type="button"
              className={`tree-item ${bucket === b.name ? 'is-active' : ''}`}
              onClick={() => setBucket(b.name)}
              title={b.createdAt ? `created ${new Date(b.createdAt).toLocaleString()}` : b.name}
            >
              <span>🪣 {b.name}</span>
            </button>
          ))}
        </div>
        {writable && (
          <form
            className="manage-toolbar is-tight"
            onSubmit={(event) => {
              event.preventDefault();
              if (newBucket)
                void bucketAction('createBucket', newBucket).then(() => setNewBucket(''));
            }}
          >
            <input
              value={newBucket}
              onChange={(event) => setNewBucket(event.target.value.toLowerCase())}
              placeholder="new-bucket-name"
              aria-label="New bucket name"
            />
            <button type="submit" disabled={!newBucket}>
              Create
            </button>
          </form>
        )}
      </nav>
      <div className="manage-main">
        {error && (
          <p className="manage-error" role="alert">
            {error}
          </p>
        )}
        {bucket ? (
          <>
            <header className="table-view-header">
              <h3>
                🪣 <strong>{bucket}</strong>
              </h3>
              <div className="segmented" role="tablist">
                {(['objects', 'settings', 'usage'] as const).map((name) => (
                  <button
                    key={name}
                    type="button"
                    role="tab"
                    aria-pressed={tab === name}
                    onClick={() => setTab(name)}
                  >
                    {name[0]!.toUpperCase() + name.slice(1)}
                  </button>
                ))}
              </div>
              {writable && (
                <DeleteButton
                  label="Delete bucket"
                  onDelete={() => bucketAction('deleteBucket', bucket)}
                />
              )}
            </header>
            {tab === 'objects' && (
              <ObjectsTab key={bucket} api={api} bucket={bucket} writable={writable} />
            )}
            {tab === 'settings' && (
              <SettingsTab key={bucket} api={api} bucket={bucket} writable={writable} />
            )}
            {tab === 'usage' && <UsageTab key={bucket} api={api} bucket={bucket} />}
          </>
        ) : (
          <p className="manage-muted">No bucket selected.</p>
        )}
      </div>
    </div>
  );
}

function ObjectsTab({
  api,
  bucket,
  writable,
}: {
  api: ExploreApi;
  bucket: string;
  writable: boolean;
}) {
  const [prefix, setPrefix] = useState('');
  const [listing, setListing] = useState<S3ListResult | null>(null);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [uploads, setUploads] = useState<{ name: string; progress: number; error?: string }[]>([]);
  const [newFolder, setNewFolder] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const load = useCallback(
    async (token?: string) => {
      try {
        const page = await api.s3.list(bucket, prefix, token);
        setListing((current) =>
          token && current
            ? {
                ...page,
                folders: [...current.folders, ...page.folders],
                objects: [...current.objects, ...page.objects],
              }
            : page,
        );
        setError(null);
      } catch (reason) {
        setError((reason as Error).message);
      }
    },
    [api, bucket, prefix],
  );

  useEffect(() => {
    setSelected(new Set());
    setOpenKey(null);
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = filter.toLowerCase();
    return {
      folders: (listing?.folders ?? []).filter((f) => f.toLowerCase().includes(needle)),
      objects: (listing?.objects ?? []).filter((o) => o.key.toLowerCase().includes(needle)),
    };
  }, [listing, filter]);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    setUploads(list.map((f) => ({ name: f.name, progress: 0 })));
    for (const [index, file] of list.entries()) {
      try {
        await api.s3.upload(bucket, `${prefix}${file.name}`, file, (progress) =>
          setUploads((u) => u.map((item, i) => (i === index ? { ...item, progress } : item))),
        );
        setUploads((u) => u.map((item, i) => (i === index ? { ...item, progress: 1 } : item)));
      } catch (reason) {
        setUploads((u) =>
          u.map((item, i) => (i === index ? { ...item, error: (reason as Error).message } : item)),
        );
      }
    }
    void load();
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (writable && event.dataTransfer.files.length > 0) void upload(event.dataTransfer.files);
  };

  const act = async (body: Parameters<ExploreApi['s3']['action']>[0]) => {
    setError(null);
    try {
      await api.s3.action(body);
      setSelected(new Set());
      await load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  const crumbs = prefix.split('/').filter(Boolean);
  const name = (key: string) => key.slice(prefix.length);

  return (
    <div
      className={`objects-tab ${dragging ? 'is-dragging' : ''}`}
      onDragOver={(event) => {
        if (!writable) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <nav className="breadcrumbs" aria-label="Folder">
        <button type="button" className="link-button" onClick={() => setPrefix('')}>
          {bucket}
        </button>
        {crumbs.map((part, i) => (
          <span key={i}>
            {' / '}
            <button
              type="button"
              className="link-button"
              onClick={() => setPrefix(`${crumbs.slice(0, i + 1).join('/')}/`)}
            >
              {part}
            </button>
          </span>
        ))}
      </nav>
      <div className="manage-toolbar">
        <input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter this folder…"
          aria-label="Filter objects"
        />
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
        {writable && (
          <>
            <label className="button-like">
              Upload files
              <input
                type="file"
                multiple
                hidden
                onChange={(event) => event.target.files && void upload(event.target.files)}
              />
            </label>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (newFolder)
                  void act({
                    bucket,
                    action: 'folder',
                    prefix: `${prefix}${newFolder.replace(/\/+$/, '')}/`,
                  }).then(() => setNewFolder(''));
              }}
            >
              <input
                className="is-narrow"
                value={newFolder}
                onChange={(event) => setNewFolder(event.target.value)}
                placeholder="folder name"
                aria-label="New folder name"
              />
              <button type="submit" disabled={!newFolder}>
                New folder
              </button>
            </form>
            {selected.size > 0 && (
              <DeleteButton
                label={`Delete ${selected.size} selected`}
                onDelete={() => act({ bucket, action: 'delete', keys: [...selected] })}
              />
            )}
          </>
        )}
        <span className="manage-muted">
          {writable
            ? 'Drop files here to upload into this folder.'
            : 'Read-only: switch Changes on to upload or delete.'}
        </span>
      </div>
      {uploads.length > 0 && (
        <ul className="upload-list">
          {uploads.map((u, i) => (
            <li key={i} className={u.error ? 'is-error' : undefined}>
              {u.name} —{' '}
              {u.error ?? (u.progress >= 1 ? 'done' : `${Math.round(u.progress * 100)}%`)}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
      <div className="manage-split is-inner">
        <table className="data-grid objects-grid">
          <thead>
            <tr>
              {writable && <th className="grid-check" aria-label="Select" />}
              <th>Name</th>
              <th>Size</th>
              <th>Modified</th>
              <th>Class</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {prefix && (
              <tr>
                {writable && <td className="grid-check" />}
                <td colSpan={5}>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() =>
                      setPrefix(crumbs.length > 1 ? `${crumbs.slice(0, -1).join('/')}/` : '')
                    }
                  >
                    ↩ ..
                  </button>
                </td>
              </tr>
            )}
            {visible.folders.map((folder) => (
              <tr key={folder}>
                {writable && <td className="grid-check" />}
                <td>
                  <button type="button" className="link-button" onClick={() => setPrefix(folder)}>
                    📁 {name(folder)}
                  </button>
                </td>
                <td className="manage-muted">folder</td>
                <td />
                <td />
                <td className="grid-actions">
                  {writable && (
                    <DeleteButton
                      label="Delete folder"
                      onDelete={() => act({ bucket, action: 'delete', prefix: folder })}
                    />
                  )}
                </td>
              </tr>
            ))}
            {visible.objects.map((object) => (
              <tr key={object.key} className={openKey === object.key ? 'is-selected' : undefined}>
                {writable && (
                  <td className="grid-check">
                    <input
                      type="checkbox"
                      aria-label={`Select ${object.key}`}
                      checked={selected.has(object.key)}
                      onChange={(event) =>
                        setSelected((current) => {
                          const next = new Set(current);
                          if (event.target.checked) next.add(object.key);
                          else next.delete(object.key);
                          return next;
                        })
                      }
                    />
                  </td>
                )}
                <td>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setOpenKey(object.key)}
                  >
                    📄 {name(object.key)}
                  </button>
                </td>
                <td className="is-number">{formatBytes(object.size)}</td>
                <td>{object.lastModified ? new Date(object.lastModified).toLocaleString() : ''}</td>
                <td className="manage-muted">{object.storageClass ?? ''}</td>
                {/* Downloading is a read: available in read-only mode too. */}
                <td className="grid-actions">
                  <a className="button-like" href={api.s3.downloadUrl(bucket, object.key)} download>
                    Download
                  </a>
                </td>
              </tr>
            ))}
            {listing && visible.folders.length === 0 && visible.objects.length === 0 && (
              <tr>
                <td colSpan={6} className="grid-empty">
                  {filter ? 'Nothing matches the filter.' : 'This folder is empty.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
        {openKey && (
          <ObjectDrawer
            key={openKey}
            api={api}
            bucket={bucket}
            objectKey={openKey}
            writable={writable}
            onClose={() => setOpenKey(null)}
            onChanged={() => {
              setOpenKey(null);
              void load();
            }}
          />
        )}
      </div>
      {listing?.nextToken && (
        <button type="button" onClick={() => void load(listing.nextToken ?? undefined)}>
          Load more…
        </button>
      )}
    </div>
  );
}

function ObjectDrawer({
  api,
  bucket,
  objectKey,
  writable,
  onClose,
  onChanged,
}: {
  api: ExploreApi;
  bucket: string;
  objectKey: string;
  writable: boolean;
  onClose(): void;
  onChanged(): void;
}) {
  const [detail, setDetail] = useState<S3ObjectDetail | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [target, setTarget] = useState(objectKey);
  const [tagsText, setTagsText] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.s3
      .object(bucket, objectKey)
      .then((d) => {
        setDetail(d);
        setTagsText(
          Object.entries(d.tags ?? {})
            .map(([k, v]) => `${k}=${v}`)
            .join('\n'),
        );
        const textual =
          /^(text\/|application\/(json|xml|yaml|x-yaml|javascript))/.test(d.contentType ?? '') ||
          /\.(txt|md|json|csv|log|ya?ml|xml|ini|conf|sql)$/i.test(objectKey);
        if (textual && d.size <= 256 * 1024) {
          fetch(api.s3.downloadUrl(bucket, objectKey, true), { credentials: 'same-origin' })
            .then((r) => r.text())
            .then(setText)
            .catch(() => setText(null));
        }
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api, bucket, objectKey]);

  const isImage = /^image\/(png|jpeg|gif|webp|avif|bmp)/.test(detail?.contentType ?? '');
  const act = async (body: Parameters<ExploreApi['s3']['action']>[0]) => {
    setError(null);
    try {
      await api.s3.action(body);
      onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <aside className="row-form object-drawer" aria-label={`Object ${objectKey}`}>
      <header>
        <h3 title={objectKey}>{objectKey.split('/').pop()}</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      {error && <p className="manage-error">{error}</p>}
      {detail && (
        <>
          <dl className="info-grid">
            <div>
              <dt>Key</dt>
              <dd>{detail.key}</dd>
            </div>
            <div>
              <dt>Size</dt>
              <dd>{formatBytes(detail.size)}</dd>
            </div>
            <div>
              <dt>Type</dt>
              <dd>{detail.contentType ?? '—'}</dd>
            </div>
            <div>
              <dt>Modified</dt>
              <dd>{detail.lastModified ? new Date(detail.lastModified).toLocaleString() : '—'}</dd>
            </div>
            <div>
              <dt>ETag</dt>
              <dd>{detail.etag}</dd>
            </div>
            {detail.versionId && (
              <div>
                <dt>Version</dt>
                <dd>{detail.versionId}</dd>
              </div>
            )}
            {Object.entries(detail.metadata).map(([k, v]) => (
              <div key={k}>
                <dt>meta {k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
          <a
            className="button-like button-primary"
            href={api.s3.downloadUrl(bucket, objectKey)}
            download
          >
            Download
          </a>
          {isImage && (
            <img
              className="object-preview"
              src={api.s3.downloadUrl(bucket, objectKey, true)}
              alt={objectKey}
            />
          )}
          {text !== null && <pre className="manage-code object-text">{text}</pre>}
          <h4>Tags</h4>
          <textarea
            rows={3}
            value={tagsText}
            readOnly={!writable}
            onChange={(event) => setTagsText(event.target.value)}
            placeholder="key=value, one per line"
            spellCheck={false}
            aria-label="Object tags"
          />
          {writable && (
            <>
              <button
                type="button"
                onClick={() =>
                  void act({
                    bucket,
                    action: 'tags',
                    key: objectKey,
                    tags: Object.fromEntries(
                      tagsText
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean)
                        .map((line) => [
                          line.split('=')[0]!.trim(),
                          line.slice(line.indexOf('=') + 1).trim(),
                        ]),
                    ),
                  })
                }
              >
                Save tags
              </button>
              <h4>Copy or move</h4>
              <input
                value={target}
                onChange={(event) => setTarget(event.target.value)}
                aria-label="Target key"
              />
              <div className="manage-toolbar">
                <button
                  type="button"
                  disabled={target === objectKey}
                  onClick={() => void act({ bucket, action: 'copy', from: objectKey, to: target })}
                >
                  Copy
                </button>
                <button
                  type="button"
                  disabled={target === objectKey}
                  onClick={() => void act({ bucket, action: 'move', from: objectKey, to: target })}
                >
                  Move / rename
                </button>
                <DeleteButton
                  onDelete={() => act({ bucket, action: 'delete', keys: [objectKey] })}
                />
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}

function SettingsTab({
  api,
  bucket,
  writable,
}: {
  api: ExploreApi;
  bucket: string;
  writable: boolean;
}) {
  const [settings, setSettings] = useState<S3BucketSettings | null>(null);
  const [policy, setPolicy] = useState('');
  const [cors, setCors] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const load = useCallback(() => {
    api.s3
      .settings(bucket)
      .then((s) => {
        setSettings(s);
        setPolicy(s.policy ?? '');
        setCors(s.cors ?? '');
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api, bucket]);
  useEffect(load, [load]);

  const save = async (
    setting: 'policy' | 'cors' | 'versioning',
    value: string | boolean | null,
  ) => {
    setError(null);
    setSaved(null);
    try {
      await api.s3.setSetting(bucket, setting, value);
      setSaved(`${setting} saved`);
      load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  if (!settings)
    return error ? (
      <p className="manage-error">{error}</p>
    ) : (
      <p className="manage-muted">Loading…</p>
    );
  const pab = settings.publicAccessBlock;

  return (
    <div className="settings-tab">
      {error && <p className="manage-error">{error}</p>}
      {saved && <p className="manage-ok">{saved}</p>}
      <dl className="info-grid">
        <div>
          <dt>Region</dt>
          <dd>{settings.region ?? '—'}</dd>
        </div>
        <div>
          <dt>Versioning</dt>
          <dd>
            {settings.versioning ?? 'not supported'}
            {writable && settings.versioning !== null && (
              <button
                type="button"
                onClick={() => void save('versioning', settings.versioning !== 'Enabled')}
              >
                {settings.versioning === 'Enabled' ? 'Suspend' : 'Enable'}
              </button>
            )}
          </dd>
        </div>
        <div>
          <dt>Default encryption</dt>
          <dd>{settings.encryption ?? 'none'}</dd>
        </div>
        <div>
          <dt>Public access</dt>
          <dd>
            {pab
              ? Object.values(pab).every(Boolean)
                ? 'fully blocked'
                : `partly open (${Object.entries(pab)
                    .filter(([, v]) => !v)
                    .map(([k]) => k)
                    .join(', ')} off)`
              : 'no block configured'}
          </dd>
        </div>
      </dl>
      {settings.acl && (
        <>
          <h4>Access control list</h4>
          <table className="data-grid">
            <thead>
              <tr>
                <th>Grantee</th>
                <th>Permission</th>
              </tr>
            </thead>
            <tbody>
              {settings.acl.map((grant, i) => (
                <tr key={i}>
                  <td>{grant.grantee}</td>
                  <td>{grant.permission}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <h4>Bucket policy</h4>
      <CodeEditor
        value={policy}
        onChange={setPolicy}
        language="json"
        readOnly={!writable}
        placeholder="No policy (only the owner's keys have access)"
        minHeight={120}
        ariaLabel="Bucket policy"
      />
      {writable && (
        <div className="manage-toolbar">
          <button
            type="button"
            className="button-primary"
            onClick={() => void save('policy', policy)}
          >
            Save policy
          </button>
          {settings.policy && (
            <DeleteButton label="Remove policy" onDelete={() => save('policy', null)} />
          )}
        </div>
      )}
      <h4>CORS rules</h4>
      <CodeEditor
        value={cors}
        onChange={setCors}
        language="json"
        readOnly={!writable}
        placeholder='[{"AllowedMethods":["GET"],"AllowedOrigins":["https://example.com"]}]'
        minHeight={90}
        ariaLabel="CORS rules"
      />
      {writable && (
        <div className="manage-toolbar">
          <button type="button" onClick={() => void save('cors', cors)}>
            Save CORS
          </button>
          {settings.cors && (
            <DeleteButton label="Remove CORS" onDelete={() => save('cors', null)} />
          )}
        </div>
      )}
      {settings.lifecycle && (
        <>
          <h4>Lifecycle rules</h4>
          <pre className="manage-code">{settings.lifecycle}</pre>
        </>
      )}
      {settings.notes.length > 0 && (
        <p className="manage-muted">Could not read: {settings.notes.join(' · ')}</p>
      )}
    </div>
  );
}

function UsageTab({ api, bucket }: { api: ExploreApi; bucket: string }) {
  const [usage, setUsage] = useState<S3UsageResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // State changes only in the promise callbacks, so this also runs from the effect.
  const count = useCallback(() => {
    api.s3
      .usage(bucket)
      .then((result) => {
        setUsage(result);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [api, bucket]);
  const measure = () => {
    setLoading(true);
    count();
  };
  useEffect(() => {
    count();
  }, [count]);
  const max = Math.max(1, ...(usage?.byPrefix.map((p) => p.bytes) ?? [1]));
  return (
    <div className="usage-tab">
      <div className="manage-toolbar">
        <button type="button" onClick={measure} disabled={loading}>
          {loading ? 'Counting…' : 'Measure again'}
        </button>
        {usage && (
          <span className="manage-muted">
            {usage.capped ? 'at least ' : ''}
            {usage.totalObjects.toLocaleString()} objects · {formatBytes(usage.totalBytes)}
          </span>
        )}
      </div>
      {error && <p className="manage-error">{error}</p>}
      {usage && (
        <ul className="usage-bars">
          {usage.byPrefix.map((p) => (
            <li key={p.prefix}>
              <span className="usage-label">{p.prefix}</span>
              <span
                className="usage-bar"
                style={{ width: `${Math.max(1, (p.bytes / max) * 100)}%` }}
              />
              <span className="manage-muted">
                {formatBytes(p.bytes)} · {p.objects.toLocaleString()} objects
              </span>
            </li>
          ))}
          {usage.byPrefix.length === 0 && <li className="manage-muted">The bucket is empty.</li>}
        </ul>
      )}
    </div>
  );
}
