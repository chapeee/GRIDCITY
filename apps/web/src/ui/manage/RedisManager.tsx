import type { ExploreInfo, RedisKeyDetail, RedisKeySummary, RedisOverview } from '@app/shared';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ConfirmNeeded, type ExploreApi } from '../../data/explore-api';
import { formatBytes } from '../format';
import { DeleteButton } from './DataGrid';

type Tab = 'keys' | 'console' | 'activity' | 'info';
const TYPES = ['string', 'hash', 'list', 'set', 'zset', 'stream'] as const;

export function RedisManager({ api, info }: { api: ExploreApi; info: ExploreInfo }) {
  const [tab, setTab] = useState<Tab>('keys');
  const [db, setDb] = useState(0);
  const [overview, setOverview] = useState<RedisOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const writable = info.mode === 'write';

  const loadOverview = useCallback(() => {
    api.redis
      .overview(db)
      .then((o) => {
        setOverview(o);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api, db]);

  useEffect(loadOverview, [loadOverview]);

  const databaseCount = Number(
    overview?.info.keyspace ? Math.max(16, ...overview.databases.map((d) => d.index + 1)) : 16,
  );

  return (
    <div className="manage-stack">
      <div className="manage-toolbar">
        <label className="manage-field is-inline">
          <span>Database</span>
          <select
            value={db}
            onChange={(event) => setDb(Number(event.target.value))}
            aria-label="Redis database"
          >
            {Array.from({ length: databaseCount }, (_, i) => {
              const d = overview?.databases.find((x) => x.index === i);
              return (
                <option key={i} value={i}>
                  db{i}
                  {d ? ` (${d.keys} keys)` : ''}
                </option>
              );
            })}
          </select>
        </label>
        <div className="segmented" role="tablist">
          {(['keys', 'console', 'activity', 'info'] as const).map((name) => (
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
        {overview && <RedisVitals overview={overview} />}
      </div>
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
      {overview && overview.notes.length > 0 && (
        <p className="manage-muted">
          Not available to this user: {overview.notes.map((n) => n.split(':')[0]).join(', ')} (ACL
          permissions).
        </p>
      )}
      {tab === 'keys' && <KeysTab key={db} api={api} db={db} writable={writable} />}
      {tab === 'console' && <ConsoleTab api={api} db={db} writable={writable} />}
      {tab === 'activity' && (
        <ActivityTab api={api} db={db} overview={overview} onRefresh={loadOverview} />
      )}
      {tab === 'info' && overview && <InfoTab overview={overview} />}
    </div>
  );
}

function RedisVitals({ overview }: { overview: RedisOverview }) {
  const memory = overview.info.memory ?? {};
  const stats = overview.info.stats ?? {};
  const clients = overview.info.clients ?? {};
  const hits = Number(stats.keyspace_hits ?? 0);
  const misses = Number(stats.keyspace_misses ?? 0);
  return (
    <span className="manage-muted vitals">
      memory {memory.used_memory_human ?? '?'}
      {memory.maxmemory_human && memory.maxmemory !== '0' ? ` / ${memory.maxmemory_human}` : ''} ·
      clients {clients.connected_clients ?? '?'} · {stats.instantaneous_ops_per_sec ?? '?'} ops/s
      {hits + misses > 0 ? ` · hit ratio ${Math.round((hits / (hits + misses)) * 100)}%` : ''}
    </span>
  );
}

function KeysTab({ api, db, writable }: { api: ExploreApi; db: number; writable: boolean }) {
  const [pattern, setPattern] = useState('*');
  const [type, setType] = useState('');
  const [keys, setKeys] = useState<RedisKeySummary[]>([]);
  const [cursor, setCursor] = useState('0');
  const [dbSize, setDbSize] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const scan = useCallback(
    async (reset: boolean) => {
      setLoading(true);
      setError(null);
      try {
        const page = await fetchKeys(api, db, pattern, type, reset ? '0' : cursor);
        setKeys((current) => (reset ? page.keys : [...current, ...page.keys]));
        setCursor(page.cursor);
        setDbSize(page.dbSize);
      } catch (reason) {
        setError((reason as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [api, db, pattern, type, cursor],
  );

  // The first page when the view opens (it is remounted per database); later scans are
  // user-driven. State changes only in the promise callbacks.
  useEffect(() => {
    let cancelled = false;
    fetchKeys(api, db, '*', '', '0')
      .then((page) => {
        if (cancelled) return;
        setKeys(page.keys);
        setCursor(page.cursor);
        setDbSize(page.dbSize);
      })
      .catch((reason: Error) => !cancelled && setError(reason.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [api, db]);

  return (
    <div className="manage-split is-keys">
      <nav className="manage-sidebar is-wide" aria-label="Keys">
        <form
          className="manage-toolbar is-tight"
          onSubmit={(event) => {
            event.preventDefault();
            void scan(true);
          }}
        >
          <input
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
            aria-label="Key pattern"
            placeholder="pattern, e.g. user:*"
          />
          <select
            value={type}
            onChange={(event) => setType(event.target.value)}
            aria-label="Key type"
          >
            <option value="">all types</option>
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <button type="submit" disabled={loading}>
            Scan
          </button>
        </form>
        <p className="manage-muted">
          {keys.length} shown{dbSize !== null ? ` of ${dbSize} in db${db}` : ''}
          {writable && (
            <>
              {' · '}
              <button type="button" className="link-button" onClick={() => setCreating(true)}>
                + New key
              </button>
            </>
          )}
        </p>
        {error && (
          <p className="manage-error" role="alert">
            {error}
          </p>
        )}
        <div className="tree">
          {keys.map((k) => (
            <button
              key={k.key}
              type="button"
              className={`tree-item ${selected === k.key ? 'is-active' : ''}`}
              onClick={() => {
                setCreating(false);
                setSelected(k.key);
              }}
              title={k.key}
            >
              <span className="key-name">
                <span className={`type-badge type-${k.type}`}>{k.type}</span> {k.key}
              </span>
              {k.ttl !== null && k.ttl >= 0 && <span className="manage-muted">{k.ttl}s</span>}
            </button>
          ))}
          {cursor !== '0' && (
            <button
              type="button"
              className="tree-item"
              onClick={() => void scan(false)}
              disabled={loading}
            >
              {loading ? 'Scanning…' : 'Load more…'}
            </button>
          )}
        </div>
      </nav>
      <div className="manage-main">
        {creating ? (
          <NewKeyForm
            api={api}
            db={db}
            onDone={(key) => {
              setCreating(false);
              setSelected(key);
              void scan(true);
            }}
          />
        ) : selected ? (
          <KeyDetailView
            key={selected}
            api={api}
            db={db}
            name={selected}
            writable={writable}
            onGone={() => {
              setSelected(null);
              void scan(true);
            }}
            onRenamed={(to) => {
              setSelected(to);
              void scan(true);
            }}
          />
        ) : (
          <p className="manage-muted">Choose a key to see and edit its value.</p>
        )}
      </div>
    </div>
  );
}

/** SCAN may return few keys per call on big databases: keep going until a page is full. */
async function fetchKeys(api: ExploreApi, db: number, pattern: string, type: string, from: string) {
  let next = from;
  let keys: RedisKeySummary[] = [];
  let dbSize: number | null;
  let rounds = 0;
  do {
    const result = await api.redis.scan(db, pattern || '*', next, type || undefined);
    keys = [...keys, ...result.keys];
    next = result.cursor;
    dbSize = result.dbSize;
    rounds += 1;
  } while (next !== '0' && keys.length < 200 && rounds < 20);
  return { keys, cursor: next, dbSize };
}

function KeyDetailView({
  api,
  db,
  name,
  writable,
  onGone,
  onRenamed,
}: {
  api: ExploreApi;
  db: number;
  name: string;
  writable: boolean;
  onGone(): void;
  onRenamed(to: string): void;
}) {
  const [detail, setDetail] = useState<RedisKeyDetail | null>(null);
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ttlText, setTtlText] = useState('');
  const [renameText, setRenameText] = useState('');

  const [version, setVersion] = useState(0);
  const load = useCallback(() => {
    api.redis
      .key(db, name, offset)
      .then((d) => {
        setDetail(d);
        setVersion((v) => v + 1);
        setTtlText(d.ttl !== null && d.ttl >= 0 ? String(d.ttl) : '');
        setRenameText(d.key);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api, db, name, offset]);

  useEffect(() => {
    load();
  }, [load]);

  const edit = async (op: Record<string, unknown>) => {
    setError(null);
    try {
      await api.redis.edit(db, { key: name, ...op });
      load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  if (!detail)
    return error ? (
      <p className="manage-error">{error}</p>
    ) : (
      <p className="manage-muted">Loading…</p>
    );

  return (
    <div className="key-detail">
      <header className="table-view-header">
        <h3>
          <span className={`type-badge type-${detail.type}`}>{detail.type}</span> {detail.key}
        </h3>
        <span className="manage-muted">
          {detail.length !== null
            ? `${detail.length} ${detail.type === 'string' ? 'bytes' : 'items'}`
            : ''}
          {detail.memoryBytes !== null ? ` · ${formatBytes(detail.memoryBytes)} in memory` : ''}
          {detail.encoding ? ` · ${detail.encoding}` : ''} · TTL{' '}
          {detail.ttl === -1 ? 'none' : detail.ttl === null ? '?' : `${detail.ttl}s`}
        </span>
      </header>
      {writable && (
        <div className="manage-toolbar">
          <input
            className="is-narrow"
            value={ttlText}
            onChange={(event) => setTtlText(event.target.value)}
            placeholder="seconds"
            aria-label="TTL seconds"
          />
          <button
            type="button"
            // Nothing to remove when the key never expires and no seconds were typed.
            disabled={!ttlText && detail.ttl === -1}
            onClick={() => void edit({ op: 'expire', ttl: ttlText ? Number(ttlText) : null })}
          >
            {ttlText || detail.ttl === -1 ? 'Set TTL' : 'Remove TTL'}
          </button>
          <input
            value={renameText}
            onChange={(event) => setRenameText(event.target.value)}
            aria-label="New key name"
          />
          <button
            type="button"
            disabled={!renameText || renameText === detail.key}
            onClick={async () => {
              try {
                await api.redis.edit(db, { op: 'rename', key: name, to: renameText });
                onRenamed(renameText);
              } catch (reason) {
                setError((reason as Error).message);
              }
            }}
          >
            Rename
          </button>
          <DeleteButton
            label="Delete key"
            onDelete={async () => {
              await api.redis.edit(db, { op: 'delete', keys: [name] });
              onGone();
            }}
          />
          <button type="button" onClick={load}>
            Refresh
          </button>
        </div>
      )}
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
      <RedisValue key={version} detail={detail} writable={writable} edit={edit} />
      {detail.truncated && (
        <p className="manage-muted">
          Showing part of the value.{' '}
          {(detail.type === 'list' || detail.type === 'zset') && (
            <>
              <button
                type="button"
                className="link-button"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 200))}
              >
                ← previous 200
              </button>{' '}
              <button type="button" className="link-button" onClick={() => setOffset(offset + 200)}>
                next 200 →
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

function RedisValue({
  detail,
  writable,
  edit,
}: {
  detail: RedisKeyDetail;
  writable: boolean;
  edit(op: Record<string, unknown>): Promise<void>;
}) {
  // Remounted for every load (key={version}), so drafts start from the fresh value.
  const [draft, setDraft] = useState(() =>
    detail.type === 'string' && typeof detail.value === 'string' ? detail.value : '',
  );
  const [draft2, setDraft2] = useState('');

  switch (detail.type) {
    case 'string': {
      const binary = typeof detail.value !== 'string';
      const pretty = (() => {
        try {
          return JSON.stringify(JSON.parse(draft), null, 2);
        } catch {
          return null;
        }
      })();
      return (
        <div className="redis-string">
          {binary ? (
            <p className="manage-muted">
              Binary value ({formatBytes((detail.value as { bytes: number }).bytes)}): shown as
              base64, not editable here.
            </p>
          ) : (
            <>
              <textarea
                className="value-editor"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                readOnly={!writable}
                rows={10}
                spellCheck={false}
                aria-label="String value"
              />
              <div className="manage-toolbar">
                {writable && (
                  <button
                    type="button"
                    className="button-primary"
                    disabled={draft === detail.value || detail.truncated}
                    onClick={() => void edit({ op: 'set', value: draft })}
                  >
                    Save value
                  </button>
                )}
                {pretty && pretty !== draft && (
                  <button type="button" onClick={() => setDraft(pretty)}>
                    Format JSON
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      );
    }
    case 'hash': {
      const entries = Object.entries((detail.value ?? {}) as Record<string, string>);
      return (
        <table className="data-grid">
          <thead>
            <tr>
              <th>Field</th>
              <th>Value</th>
              {writable && <th />}
            </tr>
          </thead>
          <tbody>
            {entries.map(([field, value]) => (
              <EditableRow
                key={field}
                cells={[field]}
                value={value}
                writable={writable}
                onSave={(v) => edit({ op: 'hset', field, value: v })}
                onDelete={() => edit({ op: 'hdel', field })}
              />
            ))}
            {writable && (
              <tr>
                <td>
                  <input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    placeholder="new field"
                    aria-label="New field"
                  />
                </td>
                <td>
                  <input
                    value={draft2}
                    onChange={(event) => setDraft2(event.target.value)}
                    placeholder="value"
                    aria-label="New field value"
                  />
                </td>
                <td>
                  <button
                    type="button"
                    disabled={!draft}
                    onClick={() =>
                      void edit({ op: 'hset', field: draft, value: draft2 }).then(
                        () => (setDraft(''), setDraft2('')),
                      )
                    }
                  >
                    Add
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      );
    }
    case 'list':
      return (
        <>
          <table className="data-grid">
            <thead>
              <tr>
                <th>Index</th>
                <th>Item</th>
                {writable && <th />}
              </tr>
            </thead>
            <tbody>
              {((detail.value ?? []) as string[]).map((item, i) => (
                <EditableRow
                  key={`${i}-${item}`}
                  cells={[String(i)]}
                  value={item}
                  writable={writable}
                  onSave={(v) => edit({ op: 'lset', index: i, value: v })}
                  onDelete={() => edit({ op: 'lrem', value: item })}
                />
              ))}
            </tbody>
          </table>
          {writable && (
            <div className="manage-toolbar">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="new item"
                aria-label="New list item"
              />
              <button
                type="button"
                disabled={!draft}
                onClick={() => void edit({ op: 'lpush', value: draft }).then(() => setDraft(''))}
              >
                Push left
              </button>
              <button
                type="button"
                disabled={!draft}
                onClick={() => void edit({ op: 'rpush', value: draft }).then(() => setDraft(''))}
              >
                Push right
              </button>
            </div>
          )}
        </>
      );
    case 'set':
      return (
        <>
          <ul className="member-list">
            {((detail.value ?? []) as string[]).map((member) => (
              <li key={member}>
                <code>{member}</code>
                {writable && (
                  <DeleteButton
                    label="Remove"
                    onDelete={() => edit({ op: 'srem', value: member })}
                  />
                )}
              </li>
            ))}
          </ul>
          {writable && (
            <div className="manage-toolbar">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="new member"
                aria-label="New set member"
              />
              <button
                type="button"
                disabled={!draft}
                onClick={() => void edit({ op: 'sadd', value: draft }).then(() => setDraft(''))}
              >
                Add member
              </button>
            </div>
          )}
        </>
      );
    case 'zset':
      return (
        <>
          <table className="data-grid">
            <thead>
              <tr>
                <th>Member</th>
                <th>Score</th>
                {writable && <th />}
              </tr>
            </thead>
            <tbody>
              {((detail.value ?? []) as [string, number][]).map(([member, score]) => (
                <EditableRow
                  key={member}
                  cells={[member]}
                  value={String(score)}
                  writable={writable}
                  onSave={(v) => edit({ op: 'zadd', value: member, score: Number(v) })}
                  onDelete={() => edit({ op: 'zrem', value: member })}
                />
              ))}
            </tbody>
          </table>
          {writable && (
            <div className="manage-toolbar">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="member"
                aria-label="New member"
              />
              <input
                className="is-narrow"
                value={draft2}
                onChange={(event) => setDraft2(event.target.value)}
                placeholder="score"
                aria-label="New member score"
              />
              <button
                type="button"
                disabled={!draft || !Number.isFinite(Number(draft2))}
                onClick={() =>
                  void edit({ op: 'zadd', value: draft, score: Number(draft2) }).then(
                    () => (setDraft(''), setDraft2('')),
                  )
                }
              >
                Add
              </button>
            </div>
          )}
        </>
      );
    case 'stream':
      return (
        <>
          <table className="data-grid">
            <thead>
              <tr>
                <th>Entry id</th>
                <th>Fields</th>
                {writable && <th />}
              </tr>
            </thead>
            <tbody>
              {((detail.value ?? []) as [string, string[]][]).map(([id, fields]) => (
                <tr key={id}>
                  <td>
                    {id}
                    <span className="manage-muted">
                      {' '}
                      {new Date(Number(id.split('-')[0])).toLocaleString()}
                    </span>
                  </td>
                  <td>
                    {fields.map((part, i) =>
                      i % 2 === 0 ? (
                        <span key={i}>
                          <strong>{part}</strong>=
                        </span>
                      ) : (
                        <span key={i}>{part} </span>
                      ),
                    )}
                  </td>
                  {writable && (
                    <td>
                      <DeleteButton onDelete={() => edit({ op: 'xdel', id })} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {writable && (
            <div className="manage-toolbar">
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder='{"field": "value"}'
                aria-label="New stream entry fields"
              />
              <button
                type="button"
                onClick={() => {
                  try {
                    const fields = JSON.parse(draft) as Record<string, unknown>;
                    void edit({
                      op: 'xadd',
                      fields: Object.fromEntries(
                        Object.entries(fields).map(([k, v]) => [k, String(v)]),
                      ),
                    }).then(() => setDraft(''));
                  } catch {
                    /* the server explains */
                    void edit({ op: 'xadd', fields: {} });
                  }
                }}
              >
                Add entry
              </button>
            </div>
          )}
        </>
      );
    default:
      return (
        <p className="manage-muted">This type ({detail.type}) can be inspected in the console.</p>
      );
  }
}

function EditableRow({
  cells,
  value,
  writable,
  onSave,
  onDelete,
}: {
  cells: string[];
  value: string;
  writable: boolean;
  onSave(value: string): Promise<void>;
  onDelete(): Promise<void>;
}) {
  const [text, setText] = useState(value);
  const changed = text !== value;
  return (
    <tr>
      {cells.map((cell, i) => (
        <td key={i}>
          <code>{cell}</code>
        </td>
      ))}
      <td>
        {writable ? (
          <input
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-label={`Value of ${cells[0]}`}
          />
        ) : (
          value
        )}
      </td>
      {writable && (
        <td className="grid-actions">
          {changed && (
            <button type="button" onClick={() => void onSave(text)}>
              Save
            </button>
          )}
          <DeleteButton label="Remove" onDelete={onDelete} />
        </td>
      )}
    </tr>
  );
}

function NewKeyForm({
  api,
  db,
  onDone,
}: {
  api: ExploreApi;
  db: number;
  onDone(key: string): void;
}) {
  const [type, setType] = useState<(typeof TYPES)[number]>('string');
  const [key, setKey] = useState('');
  const [value, setValue] = useState('');
  const [extra, setExtra] = useState('');
  const [ttl, setTtl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    try {
      const existing = await api.redis
        .key(db, key)
        .then(() => true)
        .catch(() => false);
      if (existing) throw new Error(`"${key}" already exists`);
      const ops: Record<string, Record<string, unknown>> = {
        string: { op: 'set', value, ttl: ttl ? Number(ttl) : null },
        hash: { op: 'hset', field: extra || 'field', value },
        list: { op: 'rpush', value },
        set: { op: 'sadd', value },
        zset: { op: 'zadd', value, score: Number(extra || 0) },
        stream: { op: 'xadd', fields: { [extra || 'field']: value } },
      };
      await api.redis.edit(db, { key, ...ops[type] });
      if (ttl && type !== 'string')
        await api.redis.edit(db, { op: 'expire', key, ttl: Number(ttl) });
      onDone(key);
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <div className="new-key">
      <h3>New key</h3>
      <div className="form-grid">
        <label>
          Type
          <select
            value={type}
            onChange={(event) => setType(event.target.value as (typeof TYPES)[number])}
          >
            {TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </label>
        <label>
          Key
          <input
            value={key}
            onChange={(event) => setKey(event.target.value)}
            placeholder="e.g. user:42"
          />
        </label>
        {(type === 'hash' || type === 'stream' || type === 'zset') && (
          <label>
            {type === 'zset' ? 'Score' : 'Field'}
            <input value={extra} onChange={(event) => setExtra(event.target.value)} />
          </label>
        )}
        <label>
          {type === 'string' ? 'Value' : 'First value'}
          <textarea rows={3} value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        <label>
          TTL (seconds, optional)
          <input value={ttl} onChange={(event) => setTtl(event.target.value)} />
        </label>
      </div>
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="button-primary"
        disabled={!key}
        onClick={() => void create()}
      >
        Create key
      </button>
    </div>
  );
}

/** Splits a command line like redis-cli: quotes group words, backslash escapes in "…". */
export function parseCommandLine(line: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) current += line[++i];
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || current) args.push(current);
      current = '';
      has = false;
    } else {
      current += ch;
      has = true;
    }
  }
  if (has || current) args.push(current);
  return args;
}

function formatReply(reply: unknown, indent = ''): string {
  if (reply === null) return `${indent}(nil)`;
  if (typeof reply === 'number') return `${indent}(integer) ${reply}`;
  if (typeof reply === 'string') return `${indent}"${reply}"`;
  if (Array.isArray(reply)) {
    if (reply.length === 0) return `${indent}(empty array)`;
    return reply.map((item, i) => `${indent}${i + 1}) ${formatReply(item).trimStart()}`).join('\n');
  }
  return `${indent}${JSON.stringify(reply)}`;
}

function ConsoleTab({ api, db, writable }: { api: ExploreApi; db: number; writable: boolean }) {
  const [line, setLine] = useState('');
  const [log, setLog] = useState<{ command: string; output: string; error?: boolean }[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [confirm, setConfirm] = useState<{ args: string[]; message: string } | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  // Braces matter: newer browsers return a Promise from scrollIntoView, and React would
  // take a returned value as the effect's cleanup function.
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [log]);

  const execute = async (args: string[], confirmed = false) => {
    // Shown as typed: arguments with spaces or quotes stay quoted.
    const command = args
      .map((arg) => (/^[^\s"']+$/.test(arg) ? arg : JSON.stringify(arg)))
      .join(' ');
    try {
      const result = await api.redis.command(db, args, confirmed);
      setLog((l) => [
        ...l,
        { command, output: `${formatReply(result.reply)}\n(${result.durationMs} ms)` },
      ]);
    } catch (reason) {
      if (reason instanceof ConfirmNeeded) setConfirm({ args, message: reason.message });
      else
        setLog((l) => [
          ...l,
          { command, output: `(error) ${(reason as Error).message}`, error: true },
        ]);
    }
  };

  const submit = () => {
    const args = parseCommandLine(line.trim());
    if (args.length === 0) return;
    if (args[0]!.toLowerCase() === 'clear') {
      setLog([]);
      setLine('');
      return;
    }
    setHistory((h) => [line, ...h.filter((x) => x !== line)].slice(0, 100));
    setHistoryIndex(-1);
    setLine('');
    void execute(args);
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') submit();
    if (event.key === 'ArrowUp' && history.length > 0) {
      event.preventDefault();
      const next = Math.min(history.length - 1, historyIndex + 1);
      setHistoryIndex(next);
      setLine(history[next] ?? '');
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setLine(next >= 0 ? (history[next] ?? '') : '');
    }
  };

  return (
    <div className="redis-console">
      <p className="manage-muted">
        db{db} ·{' '}
        {writable
          ? 'Changes on: write commands run and are audited.'
          : 'Read-only: commands Redis marks as writes are refused.'}{' '}
        Type CLEAR to clear.
      </p>
      <div className="console-log" aria-live="polite">
        {log.map((entry, i) => (
          <div key={i}>
            <div className="console-command">› {entry.command}</div>
            <pre className={entry.error ? 'is-error' : undefined}>{entry.output}</pre>
          </div>
        ))}
        <div ref={end} />
      </div>
      {confirm && (
        <p className="mode-confirm">
          {confirm.message}{' '}
          <button
            type="button"
            className="is-danger"
            onClick={() => {
              const args = confirm.args;
              setConfirm(null);
              void execute(args, true);
            }}
          >
            Run it
          </button>
          <button type="button" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </p>
      )}
      <div className="console-input">
        <span>db{db}›</span>
        <input
          autoFocus
          value={line}
          onChange={(event) => setLine(event.target.value)}
          onKeyDown={onKey}
          placeholder="GET key, HGETALL key, INFO memory…"
          aria-label="Redis command"
          spellCheck={false}
        />
        <button type="button" onClick={submit}>
          Run
        </button>
      </div>
    </div>
  );
}

function ActivityTab({
  api,
  db,
  overview,
  onRefresh,
}: {
  api: ExploreApi;
  db: number;
  overview: RedisOverview | null;
  onRefresh(): void;
}) {
  const [seconds, setSeconds] = useState(5);
  const [recording, setRecording] = useState(false);
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const record = async () => {
    setRecording(true);
    setError(null);
    try {
      const result = await api.redis.monitor(db, seconds);
      setLines(result.truncated ? [...result.lines, '… (stopped at 1000 lines)'] : result.lines);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setRecording(false);
    }
  };

  return (
    <div className="activity-tab">
      <section>
        <header className="manage-toolbar">
          <h4>Live commands (MONITOR)</h4>
          <select
            value={seconds}
            onChange={(event) => setSeconds(Number(event.target.value))}
            aria-label="Recording length"
          >
            {[3, 5, 10].map((s) => (
              <option key={s} value={s}>
                {s} seconds
              </option>
            ))}
          </select>
          <button type="button" onClick={() => void record()} disabled={recording}>
            {recording ? `Recording ${seconds}s…` : 'Record'}
          </button>
          <span className="manage-muted">
            Every command the server receives, from all clients. MONITOR costs performance: keep it
            short.
          </span>
        </header>
        {error && <p className="manage-error">{error}</p>}
        {lines && (
          <pre className="manage-code monitor-log">
            {lines.length > 0 ? lines.join('\n') : 'No commands in that time.'}
          </pre>
        )}
      </section>
      <section>
        <header className="manage-toolbar">
          <h4>Slow log</h4>
          <button type="button" onClick={onRefresh}>
            Refresh
          </button>
        </header>
        {overview && overview.slowlog.length === 0 ? (
          <p className="manage-muted">
            No slow commands recorded yet (Redis logs commands slower than its
            slowlog-log-slower-than setting).
          </p>
        ) : (
          <table className="data-grid">
            <thead>
              <tr>
                <th>When</th>
                <th>Took</th>
                <th>Command</th>
                <th>Client</th>
              </tr>
            </thead>
            <tbody>
              {overview?.slowlog.map((entry) => (
                <tr key={entry.id}>
                  <td>{new Date(entry.at).toLocaleString()}</td>
                  <td className="is-number">{(entry.durationMicros / 1000).toFixed(2)} ms</td>
                  <td>
                    <code>{entry.command.join(' ').slice(0, 200)}</code>
                  </td>
                  <td>{entry.client}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section>
        <h4>Busiest commands</h4>
        <table className="data-grid">
          <thead>
            <tr>
              <th>Command</th>
              <th>Calls</th>
              <th>µs per call</th>
            </tr>
          </thead>
          <tbody>
            {overview?.commandStats.slice(0, 25).map((c) => (
              <tr key={c.command}>
                <td>{c.command}</td>
                <td className="is-number">{c.calls.toLocaleString()}</td>
                <td className="is-number">{c.usecPerCall.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section>
        <h4>Connected clients ({overview?.clients.length ?? 0})</h4>
        <table className="data-grid">
          <thead>
            <tr>
              <th>Address</th>
              <th>Name</th>
              <th>User</th>
              <th>db</th>
              <th>Age</th>
              <th>Idle</th>
              <th>Last command</th>
            </tr>
          </thead>
          <tbody>
            {overview?.clients.map((c) => (
              <tr key={c.id}>
                <td>{c.addr}</td>
                <td>{c.name || <span className="manage-muted">—</span>}</td>
                <td>{c.user}</td>
                <td>{c.db}</td>
                <td className="is-number">{c.age}s</td>
                <td className="is-number">{c.idle}s</td>
                <td>{c.cmd}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function InfoTab({ overview }: { overview: RedisOverview }) {
  const sections = Object.entries(overview.info).filter(
    ([name]) => !['commandstats', 'latencystats', 'errorstats'].includes(name),
  );
  return (
    <div className="info-tab">
      {sections.map(([name, fields]) => (
        <details
          key={name}
          open={[
            'server',
            'memory',
            'clients',
            'stats',
            'persistence',
            'replication',
            'keyspace',
          ].includes(name)}
        >
          <summary>{name}</summary>
          <dl className="info-grid">
            {Object.entries(fields).map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </details>
      ))}
    </div>
  );
}
