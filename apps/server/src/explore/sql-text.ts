/**
 * Small, engine-neutral helpers for SQL text typed in the Manage view:
 * splitting a script into statements and classifying each one. They never
 * decide security on their own: read mode is also enforced by the database
 * (read-only transactions, rolled-back batches, read-only file handles).
 */

/**
 * Splits on `;` outside strings, quoted identifiers and comments. Knows
 * '…' (with ''), "…", `…`, […] (SQL Server), -- and # line comments,
 * block comments and PostgreSQL $tag$…$tag$ bodies. Empty statements are dropped.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipQuoted(sql, i, ch);
    } else if (ch === '[') {
      i = skipQuoted(sql, i, ']');
    } else if (ch === '-' && next === '-') {
      i = lineEnd(sql, i);
    } else if (ch === '#') {
      i = lineEnd(sql, i);
    } else if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
    } else if (ch === '$') {
      const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? n : end + tag.length;
      } else i += 1;
    } else if (ch === ';') {
      push(out, sql.slice(start, i));
      i += 1;
      start = i;
    } else i += 1;
  }
  push(out, sql.slice(start));
  return out;
}

function push(out: string[], statement: string) {
  if (stripComments(statement).trim()) out.push(statement.trim());
}

function skipQuoted(sql: string, from: number, close: string): number {
  let i = from + 1;
  while (i < sql.length) {
    if (sql[i] === close) {
      if (sql[i + 1] === close)
        i += 2; // doubled quote = escaped
      else return i + 1;
    } else if (sql[i] === '\\' && close !== ']' && close !== '"') i += 2;
    else i += 1;
  }
  return sql.length;
}

function lineEnd(sql: string, from: number): number {
  const end = sql.indexOf('\n', from);
  return end < 0 ? sql.length : end + 1;
}

/** Removes leading comments and whitespace (for keyword checks). */
export function stripComments(sql: string): string {
  let text = sql;
  for (;;) {
    const trimmed = text.trimStart();
    if (trimmed.startsWith('--') || trimmed.startsWith('#')) {
      const end = trimmed.indexOf('\n');
      text = end < 0 ? '' : trimmed.slice(end + 1);
    } else if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      text = end < 0 ? '' : trimmed.slice(end + 2);
    } else return trimmed;
  }
}

/** First keyword, upper case ("SELECT", "WITH", …), or "" for none. */
export function firstKeyword(statement: string): string {
  return (/^[A-Za-z]+/.exec(stripComments(statement))?.[0] ?? '').toUpperCase();
}

/** Statements that return rows and change nothing (by their first keyword). */
const READ_KEYWORDS = new Set([
  'SELECT',
  'WITH',
  'SHOW',
  'DESCRIBE',
  'DESC',
  'EXPLAIN',
  'TABLE',
  'VALUES',
  'PRAGMA',
  'SP_HELP',
]);

/** Returns rows: worth capping and showing as a grid. */
export function isRowStatement(statement: string): boolean {
  return READ_KEYWORDS.has(firstKeyword(statement));
}

/**
 * Functions a SELECT can call that act on the server itself (other sessions,
 * configuration, replication, files, locks held by the session). A read-only
 * transaction does not stop them, so read mode refuses them by name.
 */
const SIDE_EFFECT_FUNCTIONS = new RegExp(
  `\\b(${[
    // PostgreSQL
    'pg_terminate_backend',
    'pg_cancel_backend',
    'pg_reload_conf',
    'pg_rotate_logfile',
    'pg_switch_wal',
    'pg_switch_xlog',
    'pg_create_restore_point',
    'pg_promote',
    'pg_wal_replay_pause',
    'pg_wal_replay_resume',
    'pg_log_backend_memory_contexts',
    'pg_stat_reset\\w*',
    'pg_(?:try_)?advisory_(?:xact_)?lock(?:_shared)?',
    'pg_create_\\w*replication_slot',
    'pg_drop_replication_slot',
    'pg_replication_origin_\\w+',
    'pg_file_(?:write|rename|unlink|sync)',
    'lo_(?:import|export|unlink)',
    'dblink\\w*',
    // MySQL / MariaDB: a lock held by the pooled session blocks applications.
    'get_lock',
    // SQLite
    'load_extension',
  ].join('|')})\\s*\\(`,
  'i',
);

/**
 * Why a statement is refused in read mode, or null. The database enforces
 * read-only as well; this gives a clear message before anything runs.
 */
export function readModeProblem(statement: string): string | null {
  const keyword = firstKeyword(statement);
  if (!READ_KEYWORDS.has(keyword)) {
    return `${keyword || 'This statement'} changes data or settings: switch Changes on for this resource to run it`;
  }
  // Every comment and identifier quote out, so neither `name/**/(` nor `"name"(` hides a call.
  const plain = statement
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(--|#)[^\n]*/g, ' ')
    .replace(/["`[\]]/g, '');
  const sideEffect = SIDE_EFFECT_FUNCTIONS.exec(plain);
  if (sideEffect) {
    return `${sideEffect[1]}() acts on the server (sessions, settings, files or locks): switch Changes on for this resource to run it`;
  }
  if (/\binto\s+(outfile|dumpfile)\b/i.test(statement)) {
    return 'SELECT … INTO OUTFILE writes a file on the server: not allowed in read mode';
  }
  if (keyword === 'PRAGMA' && /=/.test(statement)) {
    return 'PRAGMA with a value changes the database: not allowed in read mode';
  }
  return null;
}
