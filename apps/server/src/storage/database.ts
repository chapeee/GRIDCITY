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
];

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
