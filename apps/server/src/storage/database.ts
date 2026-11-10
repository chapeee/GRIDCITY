import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type AppDatabase = Database.Database;

/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many
 * have run. Never edit a released migration; append a new one.
 *
 * Nothing secret is ever stored here: no keys, passphrases or passwords.
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
];

/** Opens (creating if needed) and migrates the database. Use ':memory:' in tests. */
export function openDatabase(file: string): AppDatabase {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  let db: AppDatabase;
  try {
    db = new Database(file);
  } catch (error) {
    throw new Error(
      `Cannot open the database at ${file} (${(error as Error).message}). ` +
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
