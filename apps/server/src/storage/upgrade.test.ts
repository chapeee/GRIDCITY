import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from './database';
import { openSqlite } from './sqlite';
import {
  BACKUPS_DIR,
  DataSafetyError,
  prepareDataForVersion,
  readMarker,
  writeMarker,
  type DataLocation,
} from './upgrade';

let root: string;
const location = (name: string): DataLocation => ({
  dataDir: join(root, name, 'data'),
  configDir: join(root, name, 'config'),
});

/** An install as 0.5.0 leaves it: database with rows, vault key, token, settings, no marker. */
function existingInstall(at: DataLocation, rows = 3): void {
  mkdirSync(at.configDir, { recursive: true });
  const db = openDatabase(join(at.dataDir, 'state.db'));
  for (let i = 0; i < rows; i++) {
    db.prepare('INSERT INTO audit_log (at, kind, host_id, detail) VALUES (?, ?, ?, ?)').run(
      1000 + i,
      'server_started',
      null,
      `row ${i}`,
    );
  }
  db.close(); // WAL left as a running app leaves it
  writeFileSync(join(at.dataDir, 'vault.key'), 'vault-key-of-this-install\n');
  writeFileSync(join(at.dataDir, 'session-token'), 'token-of-this-install\n');
  writeFileSync(join(at.configDir, 'hosts.yaml'), 'hosts:\n  - id: web-01\n');
  writeFileSync(join(at.configDir, 'resources.yaml'), 'resources: []\n');
}

const auditRows = (file: string) => {
  const db = openSqlite(file, { readonly: true, fileMustExist: true });
  try {
    return db.prepare('SELECT detail FROM audit_log ORDER BY id').all() as { detail: string }[];
  } finally {
    db.close();
  }
};
const snapshots = (at: DataLocation) =>
  existsSync(join(at.dataDir, BACKUPS_DIR)) ? readdirSync(join(at.dataDir, BACKUPS_DIR)) : [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gridcity-upgrade-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('updating with existing data', () => {
  it('leaves a new install alone', () => {
    const active = location('new');
    const result = prepareDataForVersion({ version: '0.6.0', active, candidates: [] });
    expect(result).toMatchObject({ existing: false, snapshotDir: null, adoptedFrom: null });
    expect(existsSync(active.dataDir)).toBe(false);
  });

  it('snapshots data from 0.5.0 or older (no marker) before the new version uses it', () => {
    const active = location('user');
    existingInstall(active);
    const result = prepareDataForVersion({ version: '0.6.0', active, candidates: [] });

    expect(result.existing).toBe(true);
    expect(result.previousVersion).toBeNull();
    expect(result.snapshotDir).toMatch(/from-0\.5\.0-or-older-to-0\.6\.0$/);
    const snap = result.snapshotDir!;
    expect(auditRows(join(snap, 'state.db'))).toEqual(auditRows(join(active.dataDir, 'state.db')));
    expect(readFileSync(join(snap, 'vault.key'), 'utf8')).toBe('vault-key-of-this-install\n');
    expect(readFileSync(join(snap, 'session-token'), 'utf8')).toBe('token-of-this-install\n');
    expect(readFileSync(join(snap, 'config', 'hosts.yaml'), 'utf8')).toContain('web-01');
    // The live data itself is untouched.
    expect(auditRows(join(active.dataDir, 'state.db'))).toHaveLength(3);
    expect(readFileSync(join(active.dataDir, 'vault.key'), 'utf8')).toBe(
      'vault-key-of-this-install\n',
    );
  });

  it('takes one snapshot per version change, never another on the next start', () => {
    const active = location('user');
    existingInstall(active);
    prepareDataForVersion({ version: '0.6.0', active, candidates: [] });
    writeMarker(active.dataDir, '0.6.0', null);
    const again = prepareDataForVersion({ version: '0.6.0', active, candidates: [] });
    expect(again.snapshotDir).toBeNull();
    expect(snapshots(active)).toHaveLength(1);
    expect(readMarker(active.dataDir)).toMatchObject({ version: '0.6.0' });

    const next = prepareDataForVersion({ version: '0.7.0', active, candidates: [] });
    expect(next.previousVersion).toBe('0.6.0');
    expect(next.snapshotDir).toMatch(/from-0\.6\.0-to-0\.7\.0$/);
    expect(snapshots(active)).toHaveLength(2);
  });

  it('keeps data last used by a newer version as it is (downgrade), with a snapshot', () => {
    const active = location('user');
    existingInstall(active);
    writeMarker(active.dataDir, '0.9.0', '0.8.0');
    const result = prepareDataForVersion({ version: '0.6.0', active, candidates: [] });
    expect(result.newerVersion).toBe('0.9.0');
    expect(result.snapshotDir).not.toBeNull();
    expect(auditRows(join(active.dataDir, 'state.db'))).toHaveLength(3);
  });
});

describe('adopting an earlier install in another location', () => {
  it('copies it into an empty location and leaves the original untouched', () => {
    const earlier = location('earlier');
    const active = location('active');
    existingInstall(earlier, 5);
    const result = prepareDataForVersion({ version: '0.6.0', active, candidates: [earlier] });

    expect(result.adoptedFrom).toBe(earlier.dataDir);
    expect(auditRows(join(active.dataDir, 'state.db'))).toHaveLength(5);
    expect(readFileSync(join(active.dataDir, 'session-token'), 'utf8')).toBe(
      'token-of-this-install\n',
    );
    expect(readFileSync(join(active.configDir, 'hosts.yaml'), 'utf8')).toContain('web-01');
    // Original intact.
    expect(auditRows(join(earlier.dataDir, 'state.db'))).toHaveLength(5);
    expect(existsSync(join(earlier.dataDir, 'vault.key'))).toBe(true);
    // And the adopted data got its snapshot too.
    expect(result.snapshotDir).not.toBeNull();
  });

  it('never overwrites a settings file already in the new location', () => {
    const earlier = location('earlier');
    const active = location('active');
    existingInstall(earlier);
    mkdirSync(active.configDir, { recursive: true });
    writeFileSync(join(active.configDir, 'hosts.yaml'), 'hosts:\n  - id: mine\n');
    prepareDataForVersion({ version: '0.6.0', active, candidates: [earlier] });
    expect(readFileSync(join(active.configDir, 'hosts.yaml'), 'utf8')).toContain('mine');
  });

  it('does not adopt when the location already has a database', () => {
    const earlier = location('earlier');
    const active = location('active');
    existingInstall(earlier, 5);
    existingInstall(active, 2);
    const result = prepareDataForVersion({ version: '0.6.0', active, candidates: [earlier] });
    expect(result.adoptedFrom).toBeNull();
    expect(auditRows(join(active.dataDir, 'state.db'))).toHaveLength(2);
  });

  it('treats %APPDATA%\\GRIDCITY and …\\gridcity as the same place on Windows', () => {
    const active = location('same');
    existingInstall(active);
    const result = prepareDataForVersion({
      version: '0.6.0',
      active,
      candidates: [{ dataDir: active.dataDir.toUpperCase(), configDir: active.configDir }],
      platform: 'win32',
    });
    expect(result.adoptedFrom).toBeNull();
  });
});

describe('when a backup is impossible', () => {
  it('refuses to touch a database whose format would change', () => {
    const active = location('user');
    mkdirSync(active.dataDir, { recursive: true });
    // An old-format database (schema version 0) and a backups path that cannot be a folder.
    const db = openSqlite(join(active.dataDir, 'state.db'));
    db.exec('CREATE TABLE old_data (x TEXT); INSERT INTO old_data VALUES (1);');
    db.close();
    writeFileSync(join(active.dataDir, BACKUPS_DIR), 'not a folder');
    expect(() => prepareDataForVersion({ version: '0.6.0', active, candidates: [] })).toThrow(
      DataSafetyError,
    );
  });

  it('continues when the format does not change, and says so', () => {
    const active = location('user');
    existingInstall(active);
    writeFileSync(join(active.dataDir, BACKUPS_DIR), 'not a folder');
    const result = prepareDataForVersion({ version: '0.6.0', active, candidates: [] });
    expect(result.snapshotDir).toBeNull();
    expect(result.notes.join()).toMatch(/nothing is at risk/);
  });
});
