import { isSqlKind } from '@app/shared';
import type {
  ExploreInfo,
  SqlDatabase,
  SqlQueryResult,
  SqlRowsResult,
  SqlTableDetail,
  SqlTableRef,
  SqlValue,
} from '@app/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ExploreApi } from '../../data/explore-api';
import { readStoredJson, writeStoredJson } from '../browser-storage';
import { formatBytes } from '../format';
import { CodeEditor, type EditorLanguage } from './CodeEditor';
import { DataGrid, RowForm, type GridColumn } from './DataGrid';

const PAGE_SIZE = 50;
type Tab = 'data' | 'structure' | 'relations' | 'ddl' | 'query';

/**
 * One SQL manager for every SQL engine (PostgreSQL, MySQL/MariaDB, SQL Server,
 * SQLite): the server hides the dialect differences behind one API.
 */
export function SqlManager({ api, info }: { api: ExploreApi; info: ExploreInfo }) {
  const [databases, setDatabases] = useState<SqlDatabase[]>([]);
  const [db, setDb] = useState<string>('');
  const [tables, setTables] = useState<SqlTableRef[]>([]);
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<{ schema: string; name: string } | null>(null);
  const [tab, setTab] = useState<Tab>('query');
  const [error, setError] = useState<string | null>(null);
  const [loadingTables, setLoadingTables] = useState(true);

  useEffect(() => {
    api.sql
      .databases()
      .then(({ databases: list, current }) => {
        setDatabases(list);
        setDb(current || list.find((d) => d.current)?.name || list[0]?.name || '');
      })
      .catch((reason: Error) => setError(reason.message));
  }, [api]);

  const loadTables = useCallback(() => {
    if (!db && info.kind !== 'mysql') return;
    api.sql
      .tables(db)
      .then(({ tables: list }) => {
        setTables(list);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoadingTables(false));
  }, [api, db, info.kind]);

  useEffect(() => {
    loadTables();
  }, [loadTables]);

  /** Another database: forget the open table and show its tables. */
  const switchDatabase = (name: string) => {
    setSelected(null);
    setTab('query');
    setTables([]);
    setLoadingTables(true);
    setDb(name);
  };

  const grouped = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const groups = new Map<string, SqlTableRef[]>();
    for (const table of tables) {
      if (needle && !`${table.schema}.${table.name}`.toLowerCase().includes(needle)) continue;
      groups.set(table.schema, [...(groups.get(table.schema) ?? []), table]);
    }
    return [...groups.entries()];
  }, [tables, filter]);

  // Completion: table names (qualified outside the main schema) -> columns once known.
  const [columnsByTable, setColumnsByTable] = useState<Record<string, string[]>>({});
  const schema = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const t of tables) {
      const main = ['public', 'dbo', 'main', db].includes(t.schema);
      out[main ? t.name : `${t.schema}.${t.name}`] = columnsByTable[`${t.schema}.${t.name}`] ?? [];
    }
    return out;
  }, [tables, columnsByTable, db]);

  const open = (schemaName: string, name: string) => {
    setSelected({ schema: schemaName, name });
    setTab((current) => (current === 'query' ? 'data' : current));
  };

  // The editor's SQL dialect follows the engine.
  const language: EditorLanguage = isSqlKind(info.kind) ? info.kind : 'text';

  return (
    <div className="manage-split">
      <nav className="manage-sidebar" aria-label="Tables">
        <label className="manage-field">
          <span>
            {info.kind === 'mysql' ? 'Database' : info.kind === 'sqlite' ? 'File' : 'Database'}
          </span>
          <select
            value={db}
            onChange={(event) => switchDatabase(event.target.value)}
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
        <input
          className="manage-filter"
          placeholder={`Filter ${tables.length} tables…`}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          aria-label="Filter tables"
        />
        <button
          type="button"
          className={`tree-item ${tab === 'query' ? 'is-active' : ''}`}
          onClick={() => setTab('query')}
        >
          ▶ Query editor
        </button>
        {loadingTables && <p className="manage-muted">Loading…</p>}
        <div className="tree">
          {grouped.map(([schemaName, list]) => (
            <details key={schemaName} open>
              <summary>
                {schemaName} <span className="manage-muted">{list.length}</span>
              </summary>
              {list.map((table) => (
                <button
                  key={table.name}
                  type="button"
                  className={`tree-item ${selected?.schema === table.schema && selected.name === table.name && tab !== 'query' ? 'is-active' : ''}`}
                  onClick={() => open(table.schema, table.name)}
                  title={`${table.schema}.${table.name}${table.sizeBytes ? ` · ${formatBytes(table.sizeBytes)}` : ''}`}
                >
                  <span>
                    {table.type === 'view' ? '◇' : '▦'} {table.name}
                  </span>
                  {table.rowEstimate !== null && (
                    <span className="manage-muted">{compact(table.rowEstimate)}</span>
                  )}
                </button>
              ))}
            </details>
          ))}
          {!loadingTables && tables.length === 0 && !error && (
            <p className="manage-muted">No tables in this database.</p>
          )}
        </div>
      </nav>

      <div className="manage-main">
        {error && (
          <p className="manage-error" role="alert">
            {error}
          </p>
        )}
        {tab === 'query' || !selected ? (
          <QueryTab
            api={api}
            db={db}
            language={language}
            schema={schema}
            info={info}
            onChanged={loadTables}
          />
        ) : (
          <TableView
            key={`${db}.${selected.schema}.${selected.name}`}
            api={api}
            db={db}
            schemaName={selected.schema}
            table={selected.name}
            tab={tab}
            setTab={setTab}
            writable={info.mode === 'write'}
            onOpenTable={open}
            onColumns={(columns) =>
              setColumnsByTable((current) => ({
                ...current,
                [`${selected.schema}.${selected.name}`]: columns,
              }))
            }
            onQuery={() => setTab('query')}
          />
        )}
      </div>
    </div>
  );
}

function TableView({
  api,
  db,
  schemaName,
  table,
  tab,
  setTab,
  writable,
  onOpenTable,
  onColumns,
}: {
  api: ExploreApi;
  db: string;
  schemaName: string;
  table: string;
  tab: Tab;
  setTab(tab: Tab): void;
  writable: boolean;
  onOpenTable(schema: string, name: string): void;
  onColumns(columns: string[]): void;
  onQuery(): void;
}) {
  const [detail, setDetail] = useState<SqlTableDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.sql
      .table(db, schemaName, table)
      .then((d) => {
        setDetail(d);
        onColumns(d.columns.map((c) => c.name));
      })
      .catch((reason: Error) => setError(reason.message));
    // onColumns is a fresh closure each render; loading once per table is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, db, schemaName, table]);

  return (
    <div className="table-view">
      <header className="table-view-header">
        <h3>
          {schemaName}.<strong>{table}</strong>
          {detail?.type === 'view' && <span className="manage-tag">view</span>}
        </h3>
        <div className="segmented" role="tablist">
          {(['data', 'structure', 'relations', 'ddl'] as const).map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-pressed={tab === name}
              onClick={() => setTab(name)}
            >
              {name === 'ddl' ? 'DDL' : name[0]!.toUpperCase() + name.slice(1)}
              {name === 'relations' && detail
                ? ` (${detail.foreignKeys.length + detail.referencedBy.length})`
                : ''}
            </button>
          ))}
        </div>
      </header>
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
      {detail && tab === 'data' && (
        <RowsTab api={api} db={db} detail={detail} writable={writable && detail.type === 'table'} />
      )}
      {detail && tab === 'structure' && <StructureTab detail={detail} />}
      {detail && tab === 'relations' && <RelationsTab detail={detail} onOpenTable={onOpenTable} />}
      {detail && tab === 'ddl' && (
        <pre className="manage-code">
          {detail.ddl ?? 'The engine does not provide a definition.'}
        </pre>
      )}
    </div>
  );
}

function RowsTab({
  api,
  db,
  detail,
  writable,
}: {
  api: ExploreApi;
  db: string;
  detail: SqlTableDetail;
  writable: boolean;
}) {
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [sort, setSort] = useState<{ column: string; descending: boolean } | null>(null);
  const [result, setResult] = useState<SqlRowsResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<{ mode: 'insert' } | { mode: 'edit'; row: number } | null>(null);

  const columns: GridColumn[] = detail.columns.map((c) => ({
    name: c.name,
    type: c.type,
    primaryKey: c.primaryKey,
    nullable: c.nullable,
  }));

  // Loading starts in the handlers that ask for new rows; the effect only fetches.
  const load = useCallback(() => {
    api.sql
      .rows(db, {
        schema: detail.schema,
        table: detail.name,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        orderBy: sort?.column,
        descending: sort?.descending,
        search: appliedSearch || undefined,
      })
      .then((r) => {
        setResult(r);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [api, db, detail, page, sort, appliedSearch]);

  useEffect(() => {
    load();
  }, [load]);

  /** Refresh after a change, showing that rows are loading. */
  const reload = () => {
    setLoading(true);
    load();
  };

  /** The key that finds this row again: its primary key, or every column when there is none. */
  const keyOf = (row: SqlValue[]): Record<string, SqlValue> => {
    const names = result?.columns.map((c) => c.name) ?? [];
    const pk = result?.primaryKey.length ? result.primaryKey : names;
    return Object.fromEntries(pk.map((name) => [name, row[names.indexOf(name)] ?? null]));
  };

  const rowObject = (row: SqlValue[]) =>
    Object.fromEntries((result?.columns ?? []).map((c, i) => [c.name, row[i] ?? null]));

  const total = result?.total;
  const from = page * PAGE_SIZE + 1;
  const to = page * PAGE_SIZE + (result?.rows.length ?? 0);

  return (
    <div className="rows-tab">
      <div className="manage-toolbar">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setLoading(true);
            setPage(0);
            setAppliedSearch(search);
          }}
        >
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search in every column…"
            aria-label="Search rows"
          />
        </form>
        <button type="button" onClick={reload} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
        {writable && (
          <button type="button" onClick={() => setForm({ mode: 'insert' })}>
            + Insert row
          </button>
        )}
        <span className="manage-muted">
          {result && result.rows.length > 0 ? `${from}–${to}` : '0'} of{' '}
          {total ?? (detail.rowEstimate !== null ? `~${compact(detail.rowEstimate)}` : '?')}
          {!result?.primaryKey.length && writable
            ? ' · no primary key: edits match on every column'
            : ''}
          {writable ? ' · double-click a cell to edit' : ''}
        </span>
        <span className="manage-pager">
          <button
            type="button"
            disabled={page === 0 || loading}
            onClick={() => {
              setLoading(true);
              setPage((p) => p - 1);
            }}
          >
            ← Prev
          </button>
          <button
            type="button"
            disabled={
              loading ||
              (result?.rows.length ?? 0) < PAGE_SIZE ||
              (total !== null && total !== undefined && to >= total)
            }
            onClick={() => {
              setLoading(true);
              setPage((p) => p + 1);
            }}
          >
            Next →
          </button>
        </span>
      </div>
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <DataGrid
          columns={columns}
          rows={result.rows}
          firstRowNumber={from}
          editable={writable}
          sort={sort}
          onSort={(column) => {
            setLoading(true);
            setSort((current) =>
              current?.column === column
                ? { column, descending: !current.descending }
                : { column, descending: false },
            );
          }}
          onEditCell={async (rowIndex, column, value) => {
            await api.sql.row(db, 'update', {
              schema: detail.schema,
              table: detail.name,
              key: keyOf(result.rows[rowIndex]!),
              values: { [column]: value },
            });
            load();
          }}
          onDeleteRow={async (rowIndex) => {
            await api.sql.row(db, 'delete', {
              schema: detail.schema,
              table: detail.name,
              key: keyOf(result.rows[rowIndex]!),
            });
            load();
          }}
          onOpenRow={(row) => setForm({ mode: 'edit', row })}
        />
      )}
      {form && result && (
        <RowForm
          columns={columns}
          title={form.mode === 'insert' ? `Insert into ${detail.name}` : `Row ${from + form.row}`}
          submitLabel={form.mode === 'insert' ? 'Insert' : 'Save changes'}
          readOnly={!writable}
          initial={form.mode === 'edit' ? rowObject(result.rows[form.row]!) : undefined}
          onClose={() => setForm(null)}
          onSubmit={async (values) => {
            if (form.mode === 'insert') {
              await api.sql.row(db, 'insert', {
                schema: detail.schema,
                table: detail.name,
                key: {},
                values,
              });
            } else {
              if (Object.keys(values).length === 0) return;
              await api.sql.row(db, 'update', {
                schema: detail.schema,
                table: detail.name,
                key: keyOf(result.rows[form.row]!),
                values,
              });
            }
            load();
          }}
        />
      )}
    </div>
  );
}

function StructureTab({ detail }: { detail: SqlTableDetail }) {
  return (
    <div className="structure-tab">
      <h4>Columns ({detail.columns.length})</h4>
      <table className="data-grid">
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Null</th>
            <th>Default</th>
            <th>Key</th>
            <th>Comment</th>
          </tr>
        </thead>
        <tbody>
          {detail.columns.map((c) => (
            <tr key={c.name}>
              <td>
                <strong>{c.name}</strong>
              </td>
              <td>{c.type}</td>
              <td>{c.nullable ? 'yes' : 'no'}</td>
              <td className={c.default === null ? 'is-null' : undefined}>{c.default ?? '—'}</td>
              <td>
                {c.primaryKey ? 'PRIMARY' : ''}
                {c.autoIncrement ? ' auto' : ''}
                {detail.foreignKeys.some((fk) => fk.columns.includes(c.name)) ? ' FK' : ''}
              </td>
              <td>{c.comment ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Indexes ({detail.indexes.length})</h4>
      {detail.indexes.length === 0 ? (
        <p className="manage-muted">No indexes.</p>
      ) : (
        <table className="data-grid">
          <thead>
            <tr>
              <th>Name</th>
              <th>Columns</th>
              <th>Kind</th>
            </tr>
          </thead>
          <tbody>
            {detail.indexes.map((i) => (
              <tr key={i.name}>
                <td>{i.name}</td>
                <td>{i.columns.join(', ')}</td>
                <td>{i.primary ? 'primary key' : i.unique ? 'unique' : 'index'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function RelationsTab({
  detail,
  onOpenTable,
}: {
  detail: SqlTableDetail;
  onOpenTable(schema: string, name: string): void;
}) {
  if (detail.foreignKeys.length === 0 && detail.referencedBy.length === 0) {
    return <p className="manage-muted">No foreign keys to or from this table.</p>;
  }
  return (
    <div className="relations-tab">
      {detail.foreignKeys.length > 0 && (
        <>
          <h4>This table points to</h4>
          <ul className="relation-list">
            {detail.foreignKeys.map((fk) => (
              <li key={fk.name}>
                <code>
                  {detail.name}({fk.columns.join(', ')})
                </code>{' '}
                →{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onOpenTable(fk.refSchema, fk.refTable)}
                >
                  {fk.refSchema}.{fk.refTable}({fk.refColumns.join(', ')})
                </button>
                <span className="manage-muted">
                  {' '}
                  {fk.name}
                  {fk.onDelete ? ` · on delete ${fk.onDelete.toLowerCase()}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {detail.referencedBy.length > 0 && (
        <>
          <h4>Tables pointing here</h4>
          <ul className="relation-list">
            {detail.referencedBy.map((fk) => (
              <li key={`${fk.schema}.${fk.table}.${fk.name}`}>
                <button
                  type="button"
                  className="link-button"
                  onClick={() => onOpenTable(fk.schema, fk.table)}
                >
                  {fk.schema}.{fk.table}({fk.columns.join(', ')})
                </button>{' '}
                →{' '}
                <code>
                  {detail.name}({fk.refColumns.join(', ')})
                </code>
                <span className="manage-muted">
                  {' '}
                  {fk.name}
                  {fk.onDelete ? ` · on delete ${fk.onDelete.toLowerCase()}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function QueryTab({
  api,
  db,
  language,
  schema,
  info,
  onChanged,
}: {
  api: ExploreApi;
  db: string;
  language: EditorLanguage;
  schema: Record<string, string[]>;
  info: ExploreInfo;
  onChanged(): void;
}) {
  const historyKey = `gridcity.sql-history.${info.id}`;
  const [text, setText] = useState(() => readStoredJson<string[]>(historyKey, [])[0] ?? '');
  const [history, setHistory] = useState<string[]>(() => readStoredJson<string[]>(historyKey, []));
  const [result, setResult] = useState<SqlQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const run = async (sql = text) => {
    if (!sql.trim() || running) return;
    setRunning(true);
    setError(null);
    try {
      const outcome = await api.sql.query(db, sql);
      setResult(outcome);
      const next = [sql, ...history.filter((h) => h !== sql)].slice(0, 30);
      setHistory(next);
      writeStoredJson(historyKey, next);
      if (outcome.results.some((r) => r.command !== 'SELECT')) onChanged();
    } catch (reason) {
      setError((reason as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const explain = () => {
    const prefix =
      info.kind === 'sqlite' ? 'EXPLAIN QUERY PLAN ' : info.kind === 'mssql' ? null : 'EXPLAIN ';
    if (prefix) void run(`${prefix}${text.trim().replace(/;\s*$/, '')}`);
  };

  return (
    <div className="query-tab">
      <CodeEditor
        value={text}
        onChange={setText}
        language={language}
        schema={schema}
        onRun={() => void run()}
        placeholder="SELECT * FROM …   (Ctrl+Enter runs)"
        minHeight={120}
        ariaLabel="SQL editor"
      />
      <div className="manage-toolbar">
        <button
          type="button"
          className="button-primary"
          onClick={() => void run()}
          disabled={running}
        >
          {running ? 'Running…' : 'Run'} <kbd>Ctrl ↵</kbd>
        </button>
        {info.kind !== 'mssql' && (
          <button type="button" onClick={explain} disabled={running}>
            Explain
          </button>
        )}
        <span className="manage-muted">
          {info.mode === 'read'
            ? 'Read-only: statements run in a read-only transaction that is rolled back.'
            : 'Changes on: statements are committed and audited.'}{' '}
          Results stop at 1000 rows.
        </span>
        {history.length > 0 && (
          <select
            className="query-history"
            value=""
            onChange={(event) => event.target.value && setText(event.target.value)}
            aria-label="Query history"
          >
            <option value="">History ({history.length})</option>
            {history.map((h) => (
              <option key={h} value={h}>
                {h.replace(/\s+/g, ' ').slice(0, 90)}
              </option>
            ))}
          </select>
        )}
      </div>
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="query-results">
          <p className="manage-muted">
            {result.results.length} result{result.results.length === 1 ? '' : 's'} in{' '}
            {result.durationMs} ms
          </p>
          {result.results.map((set, index) => (
            <section key={index} className="query-result">
              <p className="manage-muted">
                {set.command ?? 'OK'}
                {set.columns.length > 0
                  ? ` · ${set.rows.length} row${set.rows.length === 1 ? '' : 's'}${set.truncated ? ' (first 1000)' : ''}`
                  : ''}
                {set.affected !== null
                  ? ` · ${set.affected} row${set.affected === 1 ? '' : 's'} affected`
                  : ''}
              </p>
              {set.columns.length > 0 && <DataGrid columns={set.columns} rows={set.rows} />}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}
