import type { SqlValue } from '@app/shared';
import { useState, type KeyboardEvent } from 'react';
import { formatBytes } from '../format';

export interface GridColumn {
  name: string;
  type: string | null;
  primaryKey?: boolean;
  nullable?: boolean;
}

/** Big integers and decimals arrive as text (no precision lost): align them like numbers. */
const NUMERIC_TYPE =
  /^(big|small|tiny|medium)?int|^int\d|^(numeric|decimal|float|double|real|money)/i;

const isBinary = (value: SqlValue): value is { $binary: string; bytes: number } =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && '$binary' in value;

/** One cell as text (null and binary are rendered specially by the grid). */
export function cellText(value: SqlValue): string {
  if (value === null) return 'NULL';
  if (isBinary(value)) return `(binary, ${formatBytes(value.bytes)})`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Text typed into a cell -> the value sent to the server (JSON columns parse as JSON). */
export function parseCellInput(text: string, type: string | null): SqlValue {
  if (type && /json/i.test(type)) {
    try {
      return JSON.parse(text) as SqlValue;
    } catch {
      return text;
    }
  }
  return text;
}

interface DataGridProps {
  columns: GridColumn[];
  rows: SqlValue[][];
  /** Changes allowed: cells become editable (double click) and rows deletable. */
  editable?: boolean;
  sort?: { column: string; descending: boolean } | null;
  onSort?(column: string): void;
  onEditCell?(rowIndex: number, column: string, value: SqlValue): Promise<void>;
  onDeleteRow?(rowIndex: number): Promise<void>;
  onOpenRow?(rowIndex: number): void;
  /** Row number shown for the first row (paging). */
  firstRowNumber?: number;
  emptyText?: string;
}

/** A plain, fast table for query results and table rows. */
export function DataGrid({
  columns,
  rows,
  editable = false,
  sort,
  onSort,
  onEditCell,
  onDeleteRow,
  onOpenRow,
  firstRowNumber = 1,
  emptyText = 'No rows.',
}: DataGridProps) {
  const [editing, setEditing] = useState<{ row: number; column: number; text: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (value: SqlValue) => {
    if (!editing || !onEditCell) return;
    setBusy(true);
    setError(null);
    try {
      await onEditCell(editing.row, columns[editing.column]!.name, value);
      setEditing(null);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!editing) return;
    if (event.key === 'Enter')
      void save(parseCellInput(editing.text, columns[editing.column]!.type));
    if (event.key === 'Escape') {
      event.stopPropagation();
      setEditing(null);
    }
  };

  return (
    <div className="grid-wrap">
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
      <table className="data-grid">
        <thead>
          <tr>
            <th className="grid-rownum">#</th>
            {columns.map((column) => (
              <th key={column.name} title={column.type ?? undefined}>
                <button
                  type="button"
                  className="grid-sort"
                  onClick={() => onSort?.(column.name)}
                  disabled={!onSort}
                  aria-label={`Sort by ${column.name}`}
                >
                  {column.primaryKey && <span className="grid-key">🔑</span>}
                  {column.name}
                  {sort?.column === column.name && <span>{sort.descending ? ' ▼' : ' ▲'}</span>}
                </button>
                {column.type && <span className="grid-type">{column.type}</span>}
              </th>
            ))}
            {editable && onDeleteRow && <th aria-label="Row actions" />}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td className="grid-empty" colSpan={columns.length + 2}>
                {emptyText}
              </td>
            </tr>
          )}
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="grid-rownum">
                {onOpenRow ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => onOpenRow(rowIndex)}
                    title="Open row"
                  >
                    {firstRowNumber + rowIndex}
                  </button>
                ) : (
                  firstRowNumber + rowIndex
                )}
              </td>
              {row.map((value, columnIndex) => {
                const isEditing = editing?.row === rowIndex && editing.column === columnIndex;
                if (isEditing) {
                  return (
                    <td key={columnIndex} className="grid-editing">
                      <input
                        autoFocus
                        value={editing.text}
                        disabled={busy}
                        onChange={(event) => setEditing({ ...editing, text: event.target.value })}
                        onKeyDown={onKey}
                        aria-label={`Edit ${columns[columnIndex]?.name}`}
                      />
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void save(parseCellInput(editing.text, columns[columnIndex]!.type))
                        }
                      >
                        Save
                      </button>
                      {columns[columnIndex]?.nullable !== false && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void save(null)}
                          title="Set to NULL"
                        >
                          NULL
                        </button>
                      )}
                      <button type="button" disabled={busy} onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </td>
                  );
                }
                const text = cellText(value);
                return (
                  <td
                    key={columnIndex}
                    className={
                      value === null
                        ? 'is-null'
                        : isBinary(value)
                          ? 'is-binary'
                          : typeof value === 'number' ||
                              NUMERIC_TYPE.test(columns[columnIndex]?.type ?? '')
                            ? 'is-number'
                            : undefined
                    }
                    title={text.length > 60 ? text.slice(0, 2000) : undefined}
                    onDoubleClick={() =>
                      editable && onEditCell && !isBinary(value)
                        ? setEditing({
                            row: rowIndex,
                            column: columnIndex,
                            text: value === null ? '' : text,
                          })
                        : undefined
                    }
                  >
                    {text.length > 120 ? `${text.slice(0, 120)}…` : text}
                  </td>
                );
              })}
              {editable && onDeleteRow && (
                <td className="grid-actions">
                  <DeleteButton onDelete={() => onDeleteRow(rowIndex)} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Two clicks: "Delete" then "Really?" (no modal, no accidental loss). */
export function DeleteButton({
  onDelete,
  label = 'Delete',
}: {
  onDelete(): Promise<void> | void;
  label?: string;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className={armed ? 'is-danger' : undefined}
      disabled={busy}
      onBlur={() => setArmed(false)}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setBusy(true);
        try {
          await onDelete();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {busy ? '…' : armed ? 'Really?' : label}
    </button>
  );
}

interface RowFormProps {
  columns: GridColumn[];
  initial?: Record<string, SqlValue>;
  title: string;
  submitLabel: string;
  readOnly?: boolean;
  onSubmit?(values: Record<string, SqlValue>): Promise<void>;
  onClose(): void;
}

/** A row as a vertical form: wide rows stay readable; also the insert form. */
export function RowForm({
  columns,
  initial,
  title,
  submitLabel,
  readOnly = false,
  onSubmit,
  onClose,
}: RowFormProps) {
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      columns.map((c) => [
        c.name,
        initial && initial[c.name] !== null && initial[c.name] !== undefined
          ? cellText(initial[c.name]!)
          : '',
      ]),
    ),
  );
  const [nulls, setNulls] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(columns.map((c) => [c.name, initial ? initial[c.name] === null : false])),
  );
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!onSubmit) return;
    const values: Record<string, SqlValue> = {};
    for (const column of columns) {
      // Insert: only filled fields (defaults stay with the database). Edit: only changed ones.
      if (initial ? !touched.has(column.name) : !touched.has(column.name)) continue;
      values[column.name] = nulls[column.name]
        ? null
        : parseCellInput(texts[column.name] ?? '', column.type);
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(values);
      onClose();
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const touch = (name: string) => setTouched((current) => new Set(current).add(name));

  return (
    <aside className="row-form" aria-label={title}>
      <header>
        <h3>{title}</h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </header>
      <div className="row-form-fields">
        {columns.map((column) => {
          const binary = initial && isBinary(initial[column.name] ?? null);
          return (
            <label key={column.name} className="row-form-field">
              <span>
                {column.primaryKey && '🔑 '}
                {column.name} <em>{column.type}</em>
              </span>
              <textarea
                rows={Math.min(6, Math.max(1, Math.ceil((texts[column.name]?.length ?? 0) / 60)))}
                value={nulls[column.name] ? '' : (texts[column.name] ?? '')}
                placeholder={nulls[column.name] ? 'NULL' : initial ? '' : 'default'}
                disabled={readOnly || busy || binary}
                spellCheck={false}
                onChange={(event) => {
                  setTexts((t) => ({ ...t, [column.name]: event.target.value }));
                  setNulls((n) => ({ ...n, [column.name]: false }));
                  touch(column.name);
                }}
              />
              {!readOnly && column.nullable !== false && !binary && (
                <button
                  type="button"
                  className={nulls[column.name] ? 'is-on' : undefined}
                  onClick={() => {
                    setNulls((n) => ({ ...n, [column.name]: !n[column.name] }));
                    touch(column.name);
                  }}
                >
                  NULL
                </button>
              )}
            </label>
          );
        })}
      </div>
      {error && (
        <p className="manage-error" role="alert">
          {error}
        </p>
      )}
      {!readOnly && onSubmit && (
        <footer>
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : submitLabel}
          </button>
        </footer>
      )}
    </aside>
  );
}
