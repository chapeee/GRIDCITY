import type {
  ExploreInfo,
  MongoCollectionInfo,
  MongoDatabaseInfo,
  MongoFindResult,
  MongoIndexInfo,
} from '@app/shared';
import { useCallback, useEffect, useState } from 'react';
import type { ExploreApi } from '../../data/explore-api';
import { formatBytes } from '../format';
import { CodeEditor } from './CodeEditor';
import { DeleteButton } from './DataGrid';

type Tab = 'documents' | 'aggregate' | 'indexes' | 'operations';
const PAGE = 20;

export function MongoManager({ api, info }: { api: ExploreApi; info: ExploreInfo }) {
  const [databases, setDatabases] = useState<MongoDatabaseInfo[]>([]);
  const [db, setDb] = useState('');
  const [collections, setCollections] = useState<MongoCollectionInfo[]>([]);
  const [collection, setCollection] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('documents');
  const [error, setError] = useState<string | null>(null);
  const [newCollection, setNewCollection] = useState('');
  const writable = info.mode === 'write';

  useEffect(() => {
    api.mongo
      .databases()
      .then(({ databases: list, current }) => {
        setDatabases(list);
        setDb(
          current ??
            list.find((d) => !['admin', 'local', 'config'].includes(d.name))?.name ??
            list[0]?.name ??
            '',
        );
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api]);

  const loadCollections = useCallback(() => {
    if (!db) return;
    api.mongo
      .collections(db)
      .then(({ collections: list }) => {
        setCollections(list);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api, db]);

  useEffect(() => {
    loadCollections();
  }, [loadCollections]);

  const admin = async (body: Parameters<ExploreApi['mongo']['admin']>[0]) => {
    setError(null);
    try {
      await api.mongo.admin(body);
      loadCollections();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <div className="manage-split">
      <nav className="manage-sidebar" aria-label="Collections">
        <label className="manage-field">
          <span>Database</span>
          <select
            value={db}
            onChange={(event) => {
              // Another database: its own collections, nothing selected yet.
              setCollection(null);
              setCollections([]);
              setDb(event.target.value);
            }}
            aria-label="Database"
          >
            {databases.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
                {d.sizeBytes !== null ? ` (${formatBytes(d.sizeBytes)})` : ''}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={`tree-item ${tab === 'operations' ? 'is-active' : ''}`}
          onClick={() => setTab('operations')}
        >
          ⚙ Running operations
        </button>
        <div className="tree">
          {collections.map((c) => (
            <button
              key={c.name}
              type="button"
              className={`tree-item ${collection === c.name && tab !== 'operations' ? 'is-active' : ''}`}
              onClick={() => {
                setCollection(c.name);
                if (tab === 'operations') setTab('documents');
              }}
              title={`${c.type}${c.sizeBytes !== null ? ` · ${formatBytes(c.sizeBytes)}` : ''}${c.indexCount !== null ? ` · ${c.indexCount} indexes` : ''}`}
            >
              <span>
                {c.type === 'view' ? '◇' : '▤'} {c.name}
              </span>
              {c.count !== null && <span className="manage-muted">{c.count.toLocaleString()}</span>}
            </button>
          ))}
          {collections.length === 0 && <p className="manage-muted">No collections.</p>}
        </div>
        {writable && (
          <form
            className="manage-toolbar is-tight"
            onSubmit={(event) => {
              event.preventDefault();
              if (newCollection)
                void admin({ db, collection: newCollection, action: 'createCollection' }).then(() =>
                  setNewCollection(''),
                );
            }}
          >
            <input
              value={newCollection}
              onChange={(event) => setNewCollection(event.target.value)}
              placeholder="new collection"
              aria-label="New collection name"
            />
            <button type="submit" disabled={!newCollection}>
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
        {tab === 'operations' ? (
          <OperationsTab api={api} />
        ) : collection ? (
          <>
            <header className="table-view-header">
              <h3>
                {db}.<strong>{collection}</strong>
              </h3>
              <div className="segmented" role="tablist">
                {(['documents', 'aggregate', 'indexes'] as const).map((name) => (
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
                  label="Drop collection"
                  onDelete={async () => {
                    await admin({ db, collection, action: 'dropCollection' });
                    setCollection(null);
                  }}
                />
              )}
            </header>
            {tab === 'documents' && (
              <DocumentsTab
                key={`${db}.${collection}`}
                api={api}
                db={db}
                collection={collection}
                writable={writable}
                onChanged={loadCollections}
              />
            )}
            {tab === 'aggregate' && (
              <AggregateTab key={`${db}.${collection}`} api={api} db={db} collection={collection} />
            )}
            {tab === 'indexes' && (
              <IndexesTab
                key={`${db}.${collection}`}
                api={api}
                db={db}
                collection={collection}
                writable={writable}
              />
            )}
          </>
        ) : (
          <p className="manage-muted">Choose a collection to browse its documents.</p>
        )}
      </div>
    </div>
  );
}

function DocumentsTab({
  api,
  db,
  collection,
  writable,
  onChanged,
}: {
  api: ExploreApi;
  db: string;
  collection: string;
  writable: boolean;
  onChanged(): void;
}) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('');
  const [projection, setProjection] = useState('');
  const [skip, setSkip] = useState(0);
  const [result, setResult] = useState<MongoFindResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; text: string } | null>(null);

  const load = useCallback(
    (from = skip) => {
      api.mongo
        .find({ database: db, collection, filter, sort, projection, limit: PAGE, skip: from })
        .then((r) => {
          setResult(r);
          setError(null);
        })
        .catch((reason: Error) => setError(reason.message));
    },
    [api, db, collection, filter, sort, projection, skip],
  );

  useEffect(() => {
    load(0);
    // First page on open; later loads come from the form and pager.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!editing) return;
    setError(null);
    try {
      if (editing.id === null)
        await api.mongo.document({ db, collection, action: 'insert', document: editing.text });
      else
        await api.mongo.document({
          db,
          collection,
          action: 'replace',
          id: editing.id,
          document: editing.text,
        });
      setEditing(null);
      load();
      onChanged();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <div className="documents-tab">
      <form
        className="mongo-query"
        onSubmit={(event) => {
          event.preventDefault();
          setSkip(0);
          load(0);
        }}
      >
        <label>
          Filter
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder='{ "age": { "$gt": 30 } }'
            spellCheck={false}
          />
        </label>
        <label>
          Sort
          <input
            value={sort}
            onChange={(event) => setSort(event.target.value)}
            placeholder='{ "_id": -1 }'
            spellCheck={false}
          />
        </label>
        <label>
          Fields
          <input
            value={projection}
            onChange={(event) => setProjection(event.target.value)}
            placeholder='{ "name": 1 }'
            spellCheck={false}
          />
        </label>
        <button type="submit" className="button-primary">
          Find
        </button>
      </form>
      <div className="manage-toolbar">
        <span className="manage-muted">
          {result
            ? `${result.documents.length ? `${skip + 1}–${skip + result.documents.length}` : '0'} of ${result.total ?? '?'} · ${result.durationMs} ms`
            : ''}
        </span>
        <span className="manage-pager">
          <button
            type="button"
            disabled={skip === 0}
            onClick={() => {
              const s = Math.max(0, skip - PAGE);
              setSkip(s);
              load(s);
            }}
          >
            ← Prev
          </button>
          <button
            type="button"
            disabled={!result || result.documents.length < PAGE}
            onClick={() => {
              const s = skip + PAGE;
              setSkip(s);
              load(s);
            }}
          >
            Next →
          </button>
        </span>
        {writable && (
          <button type="button" onClick={() => setEditing({ id: null, text: '{\n  \n}' })}>
            + Insert document
          </button>
        )}
      </div>
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
      {editing && (
        <div className="doc-editor">
          <p className="manage-muted">
            {editing.id === null
              ? 'New document (Extended JSON, e.g. {"$date": "…"})'
              : `Editing _id ${editing.id}`}
          </p>
          <CodeEditor
            value={editing.text}
            onChange={(text) => setEditing({ ...editing, text })}
            language="json"
            onRun={() => void save()}
            minHeight={160}
            ariaLabel="Document editor"
          />
          <div className="manage-toolbar">
            <button type="button" className="button-primary" onClick={() => void save()}>
              {editing.id === null ? 'Insert' : 'Save'} <kbd>Ctrl ↵</kbd>
            </button>
            <button type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="doc-list">
        {result?.documents.map((document, i) => {
          const id = JSON.stringify(document._id);
          return (
            <article key={`${id}-${i}`} className="doc-card">
              <pre>{JSON.stringify(document, null, 2)}</pre>
              {writable && document._id !== undefined && (
                <div className="doc-actions">
                  <button
                    type="button"
                    onClick={() => {
                      const { _id, ...rest } = document;
                      void _id;
                      setEditing({ id, text: JSON.stringify(rest, null, 2) });
                    }}
                  >
                    Edit
                  </button>
                  <DeleteButton
                    onDelete={async () => {
                      try {
                        await api.mongo.document({ db, collection, action: 'delete', id });
                        load();
                        onChanged();
                      } catch (reason) {
                        setError((reason as Error).message);
                      }
                    }}
                  />
                </div>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function AggregateTab({
  api,
  db,
  collection,
}: {
  api: ExploreApi;
  db: string;
  collection: string;
}) {
  const [pipeline, setPipeline] = useState('[\n  { "$match": {} },\n  { "$limit": 20 }\n]');
  const [result, setResult] = useState<MongoFindResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    try {
      setResult(await api.mongo.aggregate(db, collection, pipeline));
    } catch (reason) {
      setError((reason as Error).message);
    }
  };
  return (
    <div className="aggregate-tab">
      <CodeEditor
        value={pipeline}
        onChange={setPipeline}
        language="json"
        onRun={() => void run()}
        minHeight={140}
        ariaLabel="Aggregation pipeline"
      />
      <div className="manage-toolbar">
        <button type="button" className="button-primary" onClick={() => void run()}>
          Run pipeline <kbd>Ctrl ↵</kbd>
        </button>
        <span className="manage-muted">
          $out and $merge need Changes on. Results stop at 500 documents.
        </span>
      </div>
      {error && <p className="manage-error">{error}</p>}
      {result && (
        <>
          <p className="manage-muted">
            {result.documents.length} documents · {result.durationMs} ms
          </p>
          <div className="doc-list">
            {result.documents.map((document, i) => (
              <article key={i} className="doc-card">
                <pre>{JSON.stringify(document, null, 2)}</pre>
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function IndexesTab({
  api,
  db,
  collection,
  writable,
}: {
  api: ExploreApi;
  db: string;
  collection: string;
  writable: boolean;
}) {
  const [indexes, setIndexes] = useState<MongoIndexInfo[]>([]);
  const [keys, setKeys] = useState('{ "field": 1 }');
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [ttl, setTtl] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api.mongo
      .indexes(db, collection)
      .then((r) => setIndexes(r.indexes))
      .catch((reason: Error) => setError(reason.message));
  }, [api, db, collection]);
  useEffect(load, [load]);

  const act = async (body: Parameters<ExploreApi['mongo']['admin']>[0]) => {
    setError(null);
    try {
      await api.mongo.admin(body);
      load();
    } catch (reason) {
      setError((reason as Error).message);
    }
  };

  return (
    <div className="indexes-tab">
      <table className="data-grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Keys</th>
            <th>Options</th>
            {writable && <th />}
          </tr>
        </thead>
        <tbody>
          {indexes.map((index) => (
            <tr key={index.name}>
              <td>{index.name}</td>
              <td>
                <code>{JSON.stringify(index.key)}</code>
              </td>
              <td>
                {[
                  index.unique && 'unique',
                  index.sparse && 'sparse',
                  index.ttlSeconds !== null && `TTL ${index.ttlSeconds}s`,
                ]
                  .filter(Boolean)
                  .join(', ') || '—'}
              </td>
              {writable && (
                <td>
                  {index.name !== '_id_' && (
                    <DeleteButton
                      label="Drop"
                      onDelete={() =>
                        act({ db, collection, action: 'dropIndex', name: index.name })
                      }
                    />
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {writable && (
        <div className="manage-toolbar">
          <input
            value={keys}
            onChange={(event) => setKeys(event.target.value)}
            aria-label="Index keys"
            spellCheck={false}
          />
          <label className="is-check">
            <input
              type="checkbox"
              checked={unique}
              onChange={(event) => setUnique(event.target.checked)}
            />{' '}
            unique
          </label>
          <label className="is-check">
            <input
              type="checkbox"
              checked={sparse}
              onChange={(event) => setSparse(event.target.checked)}
            />{' '}
            sparse
          </label>
          <input
            className="is-narrow"
            value={ttl}
            onChange={(event) => setTtl(event.target.value)}
            placeholder="TTL s"
            aria-label="TTL seconds"
          />
          <button
            type="button"
            onClick={() =>
              void act({
                db,
                collection,
                action: 'createIndex',
                keys,
                unique,
                sparse,
                ttlSeconds: ttl ? Number(ttl) : null,
              })
            }
          >
            Create index
          </button>
        </div>
      )}
      {error && <p className="manage-error">{error}</p>}
    </div>
  );
}

function OperationsTab({ api }: { api: ExploreApi }) {
  const [operations, setOperations] = useState<Record<string, unknown>[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api.mongo
      .operations()
      .then((r) => setOperations(r.operations))
      .catch((reason: Error) => setError(reason.message));
  }, [api]);
  useEffect(load, [load]);
  return (
    <div>
      <header className="manage-toolbar">
        <h3>Running operations</h3>
        <button type="button" onClick={load}>
          Refresh
        </button>
      </header>
      {error && <p className="manage-error">{error}</p>}
      {operations && operations.length === 0 && (
        <p className="manage-muted">Nothing is running right now.</p>
      )}
      {operations && operations.length > 0 && (
        <table className="data-grid">
          <thead>
            <tr>
              <th>op</th>
              <th>Namespace</th>
              <th>Seconds</th>
              <th>Client</th>
              <th>App</th>
              <th>Command</th>
            </tr>
          </thead>
          <tbody>
            {operations.map((op, i) => (
              <tr key={i}>
                <td>{String(op.op ?? '')}</td>
                <td>{String(op.ns ?? '')}</td>
                <td className="is-number">{String(op.secs ?? '')}</td>
                <td>{String(op.client ?? '')}</td>
                <td>{String(op.appName ?? '')}</td>
                <td>
                  <code>{JSON.stringify(op.command ?? {}).slice(0, 160)}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
