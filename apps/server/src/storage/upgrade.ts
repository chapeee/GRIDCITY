import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SCHEMA_VERSION, schemaVersionOf } from './database';
import { openSqlite } from './sqlite';

/**
 * Keeps existing users' data safe across updates, however the new version
 * arrived (npm, the desktop installer, an update button, Docker). Runs at every
 * start, before anything opens or creates a data file:
 *
 * 1. Adopt: when this location has no database yet but the standard location of
 *    an earlier install does (macOS/Linux with XDG_* set in a shell profile, so a
 *    terminal and the desktop app saw different folders), its data is COPIED
 *    here. The original stays untouched; no existing file is ever overwritten.
 * 2. Snapshot: on the first start of a version that differs from the one that
 *    last used this data (versions up to 0.5.0 left no marker), a consistent copy
 *    of the database, the vault key, the session token and the settings files
 *    goes to DATA_DIR/backups/. Snapshots are never deleted or overwritten.
 * 3. A database whose schema would change is never touched without its snapshot.
 *
 * The marker (data-version.json) is written only after the database opened.
 */

export const MARKER_FILE = 'data-version.json';
export const BACKUPS_DIR = 'backups';
/** Files next to the database that belong to the installation. */
const DATA_FILES = ['vault.key', 'session-token'] as const;
const CONFIG_FILES = ['hosts.yaml', 'resources.yaml', 'districts.yaml', 'runbooks.yaml'] as const;

export interface DataLocation {
  dataDir: string;
  configDir: string;
}

export interface DataMarker {
  /** The app version that last opened this data. */
  version: string;
  previousVersion: string | null;
  updatedAt: string;
}

export interface PrepareResult {
  /** A database was here (or was adopted) before this start. */
  existing: boolean;
  /** Version that last used the data; "0.5.0 or older" when it left no marker. */
  previousVersion: string | null;
  /** Copied from another location on this start. */
  adoptedFrom: string | null;
  /** Folder of the snapshot taken on this start. */
  snapshotDir: string | null;
  /** The data was last used by a newer version (a downgrade): kept as it is. */
  newerVersion: string | null;
  /** Notes for the console and the log. */
  notes: string[];
}

export class DataSafetyError extends Error {
  override name = 'DataSafetyError';
}

const databaseOf = (location: DataLocation) => join(location.dataDir, 'state.db');

/** Same location? Windows paths are case-insensitive (%APPDATA%\GRIDCITY = …\gridcity). */
function sameDir(a: string, b: string, platform: NodeJS.Platform): boolean {
  const normal = (path: string) => {
    const trimmed = path.replace(/[\\/]+$/, '');
    return platform === 'win32' ? trimmed.toLowerCase().replace(/\//g, '\\') : trimmed;
  };
  return normal(a) === normal(b);
}

export function readMarker(dataDir: string): DataMarker | null {
  try {
    const marker = JSON.parse(readFileSync(join(dataDir, MARKER_FILE), 'utf8')) as DataMarker;
    return typeof marker.version === 'string' ? marker : null;
  } catch {
    return null;
  }
}

/** Records the version that now owns the data (call after the database opened). */
export function writeMarker(dataDir: string, version: string, previousVersion: string | null) {
  const marker: DataMarker = { version, previousVersion, updatedAt: new Date().toISOString() };
  writeFileSync(join(dataDir, MARKER_FILE), `${JSON.stringify(marker, null, 2)}\n`);
}

/** 0.10.0 > 0.9.2; pre-release parts are ignored. */
export function newerThan(a: string, b: string): boolean {
  const parts = (v: string) =>
    v
      .split('-')[0]!
      .split('.')
      .map((n) => Number(n) || 0);
  const [pa, pb] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** A consistent single-file copy of a live database (WAL included), via SQLite itself. */
function copyDatabase(from: string, to: string): void {
  const db = openSqlite(from, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/** Copies a file only when the destination does not exist yet. */
function copyIfMissing(from: string, to: string): boolean {
  if (!existsSync(from) || existsSync(to)) return false;
  copyFileSync(from, to);
  return true;
}

function adopt(source: DataLocation, target: DataLocation): void {
  mkdirSync(target.dataDir, { recursive: true });
  mkdirSync(target.configDir, { recursive: true });
  copyDatabase(databaseOf(source), databaseOf(target));
  for (const name of DATA_FILES)
    copyIfMissing(join(source.dataDir, name), join(target.dataDir, name));
  // Keys and trusted host keys made in the app (Docker keeps them in DATA_DIR/ssh).
  if (existsSync(join(source.dataDir, 'ssh')) && !existsSync(join(target.dataDir, 'ssh'))) {
    cpSync(join(source.dataDir, 'ssh'), join(target.dataDir, 'ssh'), { recursive: true });
  }
  for (const name of CONFIG_FILES) {
    copyIfMissing(join(source.configDir, name), join(target.configDir, name));
  }
  writeFileSync(
    join(target.dataDir, 'adopted-from.txt'),
    `Copied on ${new Date().toISOString()} from\n  data:   ${source.dataDir}\n  config: ${source.configDir}\nThe original was left untouched.\n`,
  );
}

function snapshot(location: DataLocation, label: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(location.dataDir, BACKUPS_DIR, `${stamp}-${label}`);
  mkdirSync(join(dir, 'config'), { recursive: true });
  copyDatabase(databaseOf(location), join(dir, 'state.db'));
  for (const name of DATA_FILES) copyIfMissing(join(location.dataDir, name), join(dir, name));
  for (const name of CONFIG_FILES) {
    copyIfMissing(join(location.configDir, name), join(dir, 'config', name));
  }
  return dir;
}

export interface PrepareOptions {
  version: string;
  /** Where this start keeps its data and settings. */
  active: DataLocation;
  /** Standard locations of earlier installs to adopt from (only when active is a default location). */
  candidates: DataLocation[];
  platform?: NodeJS.Platform;
}

export function prepareDataForVersion(options: PrepareOptions): PrepareResult {
  const { version, active } = options;
  const platform = options.platform ?? process.platform;
  const result: PrepareResult = {
    existing: false,
    previousVersion: null,
    adoptedFrom: null,
    snapshotDir: null,
    newerVersion: null,
    notes: [],
  };

  // 1. Adopt an earlier install's data into an empty location (copy, never move).
  if (!existsSync(databaseOf(active))) {
    const sources = options.candidates.filter(
      (candidate) =>
        !sameDir(candidate.dataDir, active.dataDir, platform) && existsSync(databaseOf(candidate)),
    );
    if (sources.length > 0) {
      const source = sources[0]!;
      adopt(source, active);
      result.adoptedFrom = source.dataDir;
      result.notes.push(
        `Found the data of an earlier install in ${source.dataDir} and copied it to ${active.dataDir} (the original is untouched).`,
      );
    }
  }

  if (!existsSync(databaseOf(active))) return result; // a new install: nothing to protect
  result.existing = true;

  const marker = readMarker(active.dataDir);
  result.previousVersion = marker?.version ?? null;
  if (marker && marker.version === version) return result;
  if (marker && newerThan(marker.version, version)) {
    result.newerVersion = marker.version;
    result.notes.push(
      `This data was last used by ${marker.version}, newer than this ${version}. It is kept as it is.`,
    );
  }

  // 2. First start of this version on existing data: snapshot it first.
  const from = marker?.version ?? '0.5.0-or-older';
  const schemaChanges = (() => {
    try {
      return schemaVersionOf(databaseOf(active)) < SCHEMA_VERSION;
    } catch {
      return true; // unreadable: treat as risky, a snapshot is required
    }
  })();
  try {
    result.snapshotDir = snapshot(active, `from-${from}-to-${version}`);
    result.notes.push(`Saved a copy of your data before the update: ${result.snapshotDir}`);
  } catch (error) {
    const reason = (error as Error).message;
    // 3. Never change a database we could not back up.
    if (schemaChanges) {
      throw new DataSafetyError(
        `Could not back up your data before updating it (${reason}). Nothing was changed. ` +
          `Free some disk space or fix the permissions of ${active.dataDir}, then start again.`,
        { cause: error },
      );
    }
    result.notes.push(
      `Could not save a copy of your data before the update (${reason}). The data format did not change, so nothing is at risk; it continues as it is.`,
    );
  }
  return result;
}
