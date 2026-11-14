import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { NATIVE_LOAD_ERROR, openSqlite, type SqliteDatabase } from './sqlite';

export type AppDatabase = SqliteDatabase;

/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many
 * have run. Never edit a released migration; append a new one.
 *
 * Credentials typed in the app are stored only encrypted (table `secrets`, see
 * secret-vault.ts); SSH private keys and passphrases are never stored here.
 */
const MIGRATIONS: readonly string[] = [
  /* 1: audit log, metric history, layout slots */ `
  CREATE TABLE audit_log (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    at      INTEGER NOT NULL,          -- epoch ms
    kind    TEXT    NOT NULL,
    host_id TEXT,
    detail  TEXT
  );
  CREATE INDEX audit_log_at ON audit_log (at);

  -- Append-only: the database itself rejects edits and deletions.
  CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
  CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

  -- Reduced-resolution history (one averaged row per host per bucket).
  CREATE TABLE metric_samples (
    host_id               TEXT    NOT NULL,
    at                    INTEGER NOT NULL,  -- bucket start, epoch ms
    cpu_percent           REAL,
    memory_percent        REAL,
    network_bytes_per_sec REAL,
    load_one              REAL,
    max_disk_percent      REAL,
    PRIMARY KEY (host_id, at)
  ) WITHOUT ROWID;
  CREATE INDEX metric_samples_at ON metric_samples (at);

  CREATE TABLE layout_slots (
    data_mode TEXT    NOT NULL,          -- 'real' | 'demo': never mixed
    host_id   TEXT    NOT NULL,
    slot      INTEGER NOT NULL,
    PRIMARY KEY (data_mode, host_id)
  );
  `,
  /* 2: status transitions (incidents) and app settings */ `
  CREATE TABLE status_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    target_id TEXT    NOT NULL,          -- host or resource id
    at        INTEGER NOT NULL,          -- epoch ms
    status    TEXT    NOT NULL,          -- online | degraded | offline
    reason    TEXT
  );
  CREATE INDEX status_events_target_at ON status_events (target_id, at);

  CREATE TABLE app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL                  -- JSON, never secrets
  );
  `,
  /* 3: credentials typed in the app, AES-256-GCM encrypted (storage/secret-vault.ts) */ `
  CREATE TABLE secrets (
    id         TEXT PRIMARY KEY,         -- e.g. "orders-db.password", "alerts.webhook"
    iv         BLOB NOT NULL,
    data       BLOB NOT NULL,            -- ciphertext only; the key is never in this file
    tag        BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  /* 4: attack and exposure findings (threats/threat-store.ts) */ `
  CREATE TABLE threat_findings (
    id              TEXT PRIMARY KEY,    -- "<target>:<key>", stable for the same attack
    target_id       TEXT NOT NULL,
    scope           TEXT NOT NULL,       -- the checks that report it, "auth+fail2ban"
    source          TEXT NOT NULL,
    severity        TEXT NOT NULL,
    category        TEXT NOT NULL,
    title           TEXT NOT NULL,
    detail          TEXT NOT NULL,
    advice          TEXT NOT NULL,
    attacker_ip     TEXT,
    count           INTEGER NOT NULL,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL,
    blocked         INTEGER,             -- 1, 0 or NULL (nothing says)
    status          TEXT NOT NULL,       -- open | resolved
    resolved_at     INTEGER,
    acknowledged_at INTEGER,             -- marked as expected by the user
    alerted         INTEGER NOT NULL DEFAULT 0  -- an alert went out, so its end is reported too
  );
  CREATE INDEX threat_findings_target ON threat_findings (target_id, status);
  CREATE INDEX threat_findings_seen ON threat_findings (last_seen);

  CREATE TABLE threat_baselines (
    target_id  TEXT PRIMARY KEY,
    data       TEXT NOT NULL,            -- JSON: accounts, ports and login addresses seen
    updated_at INTEGER NOT NULL
  );
  `,
  /* 5: backup & restore (backup/store.ts). Passphrases and passwords are in `secrets`. */ `
  CREATE TABLE backup_destinations (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,            -- local | s3 | sftp
    name       TEXT NOT NULL,
    config     TEXT NOT NULL,            -- JSON: path, or resource id + bucket + prefix, or host id + path
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE backup_jobs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    config      TEXT NOT NULL,           -- JSON (JobInput without secrets)
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    next_run_at INTEGER,
    deleted_at  INTEGER                  -- removed jobs keep their history and files
  );
  CREATE TABLE backup_runs (
    id            TEXT PRIMARY KEY,
    job_id        TEXT NOT NULL,
    job_name      TEXT NOT NULL,
    source_kind   TEXT NOT NULL,
    type          TEXT NOT NULL,         -- full | incremental | differential
    trigger       TEXT NOT NULL,         -- manual | schedule
    status        TEXT NOT NULL,         -- running | success | partial | failed | interrupted | cancelled | deleted
    started_at    INTEGER NOT NULL,
    finished_at   INTEGER,
    raw_bytes     INTEGER,
    stored_bytes  INTEGER,
    sha256        TEXT,
    file_name     TEXT,
    parent_run_id TEXT,
    error         TEXT,
    manifest      TEXT,                  -- JSON (BackupManifest)
    file_index    BLOB                   -- gzip JSON: files backups, for the next incremental
  );
  CREATE INDEX backup_runs_job ON backup_runs (job_id, started_at);
  CREATE INDEX backup_runs_started ON backup_runs (started_at);
  CREATE TABLE backup_run_targets (
    run_id         TEXT NOT NULL,
    destination_id TEXT NOT NULL,
    destination_name TEXT NOT NULL,
    kind           TEXT NOT NULL,
    status         TEXT NOT NULL,        -- pending | uploading | uploaded | verified | failed | deleted | missing
    remote_key     TEXT,
    bytes          INTEGER NOT NULL DEFAULT 0,
    error          TEXT,
    finished_at    INTEGER,
    PRIMARY KEY (run_id, destination_id)
  );
  CREATE TABLE backup_restores (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL,
    job_name    TEXT NOT NULL,
    status      TEXT NOT NULL,
    target      TEXT NOT NULL,           -- label the user confirmed
    started_at  INTEGER NOT NULL,
    finished_at INTEGER,
    error       TEXT
  );
  CREATE TABLE backup_logs (
    owner_id TEXT NOT NULL,              -- run or restore id
    at       INTEGER NOT NULL,
    level    TEXT NOT NULL,
    message  TEXT NOT NULL
  );
  CREATE INDEX backup_logs_owner ON backup_logs (owner_id, at);
  CREATE TABLE backup_notifications (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    at     INTEGER NOT NULL,
    level  TEXT NOT NULL,
    title  TEXT NOT NULL,
    body   TEXT NOT NULL,
    run_id TEXT,
    read   INTEGER NOT NULL DEFAULT 0
  );
  `,
];

/** How many schema migrations this version knows (PRAGMA user_version after migrating). */
export const SCHEMA_VERSION = MIGRATIONS.length;

/** The schema version of an existing database file, read without changing it. */
export function schemaVersionOf(file: string): number {
  const db = openSqlite(file, { readonly: true, fileMustExist: true });
  try {
    return Number(db.pragma('user_version', { simple: true }));
  } finally {
    db.close();
  }
}

/** Opens (creating if needed) and migrates the database. Use ':memory:' in tests. */
export function openDatabase(file: string): AppDatabase {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  let db: AppDatabase;
  try {
    db = openSqlite(file);
  } catch (error) {
    const message = (error as Error).message;
    // Neither driver could load: a blocked or missing binary is not a folder problem.
    if (NATIVE_LOAD_ERROR.test(message) || message.includes('node:sqlite')) {
      throw new Error(
        `The SQLite driver could not be loaded: ${message}`.replace(/\.?$/, '.') +
          ' better-sqlite3 is a native module that Windows Application Control or antivirus ' +
          'can block; GRIDCITY then falls back to the SQLite built into Node.js 22.16 or newer.',
        { cause: error },
      );
    }
    throw new Error(
      `Cannot open the database at ${file} (${message}). ` +
        'Check that the directory exists and is writable by this user (set DATA_DIR to move it).',
      { cause: error },
    );
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: AppDatabase): void {
  const applied = db.pragma('user_version', { simple: true }) as number;
  for (let version = applied; version < MIGRATIONS.length; version++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[version]!);
      db.pragma(`user_version = ${version + 1}`);
    })();
  }
}
