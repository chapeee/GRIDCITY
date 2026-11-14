import { gunzipSync, gzipSync } from 'node:zlib';
import type {
  BackupManifest,
  BackupNotification,
  BackupSourceKind,
  BackupType,
  Compression,
  DestinationInput,
  DestinationKind,
  JobInput,
  LogLine,
  RestoreSummary,
  RunStatus,
  RunSummary,
  RunTargetView,
  TargetStatus,
} from '@app/shared';
import type { AppDatabase } from '../storage/database';
import type { FileIndex } from './sources/types';

export type StoredJob = Omit<JobInput, 'passphrase' | 'sourcePassword'>;

export interface JobRecord {
  id: string;
  name: string;
  config: StoredJob;
  createdAt: number;
  updatedAt: number;
  nextRunAt: number | null;
}

export interface DestinationRecord {
  id: string;
  input: DestinationInput;
  createdAt: number;
  updatedAt: number;
}

interface RunRow {
  id: string;
  job_id: string;
  job_name: string;
  source_kind: string;
  type: string;
  trigger: string;
  status: string;
  started_at: number;
  finished_at: number | null;
  raw_bytes: number | null;
  stored_bytes: number | null;
  sha256: string | null;
  file_name: string | null;
  parent_run_id: string | null;
  error: string | null;
  manifest: string | null;
}

interface TargetRow {
  run_id: string;
  destination_id: string;
  destination_name: string;
  kind: string;
  status: string;
  remote_key: string | null;
  bytes: number;
  error: string | null;
  finished_at: number | null;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/** Everything the backup engine remembers, in the app's SQLite database (migration 5). */
export class BackupStore {
  constructor(private readonly db: AppDatabase) {}

  // ── destinations ──
  destinations(): DestinationRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, kind, name, config, created_at, updated_at FROM backup_destinations ORDER BY created_at',
      )
      .all() as {
      id: string;
      kind: string;
      name: string;
      config: string;
      created_at: number;
      updated_at: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      input: {
        ...(JSON.parse(r.config) as object),
        kind: r.kind,
        name: r.name,
      } as DestinationInput,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    }));
  }
  destination(id: string): DestinationRecord | undefined {
    return this.destinations().find((d) => d.id === id);
  }
  saveDestination(id: string, input: DestinationInput, now: number, isNew: boolean): void {
    const { kind, name, ...config } = input;
    if (isNew) {
      this.db
        .prepare(
          'INSERT INTO backup_destinations (id, kind, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, kind, name, JSON.stringify(config), now, now);
    } else {
      this.db
        .prepare(
          'UPDATE backup_destinations SET kind = ?, name = ?, config = ?, updated_at = ? WHERE id = ?',
        )
        .run(kind, name, JSON.stringify(config), now, id);
    }
  }
  removeDestination(id: string): void {
    this.db.prepare('DELETE FROM backup_destinations WHERE id = ?').run(id);
  }

  // ── jobs ──
  jobs(): JobRecord[] {
    const rows = this.db
      .prepare(
        'SELECT id, name, config, created_at, updated_at, next_run_at FROM backup_jobs WHERE deleted_at IS NULL ORDER BY created_at',
      )
      .all() as {
      id: string;
      name: string;
      config: string;
      created_at: number;
      updated_at: number;
      next_run_at: number | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      config: JSON.parse(r.config) as StoredJob,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      nextRunAt: num(r.next_run_at),
    }));
  }
  job(id: string): JobRecord | undefined {
    return this.jobs().find((j) => j.id === id);
  }
  /** A job even after it was removed (restoring its backups). */
  jobAny(id: string): JobRecord | undefined {
    const r = this.db
      .prepare(
        'SELECT id, name, config, created_at, updated_at, next_run_at FROM backup_jobs WHERE id = ?',
      )
      .get(id) as
      | {
          id: string;
          name: string;
          config: string;
          created_at: number;
          updated_at: number;
          next_run_at: number | null;
        }
      | undefined;
    return r
      ? {
          id: r.id,
          name: r.name,
          config: JSON.parse(r.config) as StoredJob,
          createdAt: Number(r.created_at),
          updatedAt: Number(r.updated_at),
          nextRunAt: num(r.next_run_at),
        }
      : undefined;
  }
  saveJob(id: string, config: StoredJob, now: number, isNew: boolean): void {
    if (isNew) {
      this.db
        .prepare(
          'INSERT INTO backup_jobs (id, name, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        )
        .run(id, config.name, JSON.stringify(config), now, now);
    } else {
      this.db
        .prepare('UPDATE backup_jobs SET name = ?, config = ?, updated_at = ? WHERE id = ?')
        .run(config.name, JSON.stringify(config), now, id);
    }
  }
  setNextRun(id: string, at: number | null): void {
    this.db.prepare('UPDATE backup_jobs SET next_run_at = ? WHERE id = ?').run(at, id);
  }
  /** Soft delete: the history and the backup files stay. */
  deleteJob(id: string, now: number): void {
    this.db
      .prepare('UPDATE backup_jobs SET deleted_at = ?, next_run_at = NULL WHERE id = ?')
      .run(now, id);
  }

  // ── runs ──
  createRun(run: {
    id: string;
    jobId: string;
    jobName: string;
    sourceKind: BackupSourceKind;
    type: BackupType;
    trigger: 'manual' | 'schedule';
    startedAt: number;
    parentRunId: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO backup_runs (id, job_id, job_name, source_kind, type, trigger, status, started_at, parent_run_id)
         VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      )
      .run(
        run.id,
        run.jobId,
        run.jobName,
        run.sourceKind,
        run.type,
        run.trigger,
        run.startedAt,
        run.parentRunId,
      );
  }
  updateRun(
    id: string,
    patch: Partial<{
      status: RunStatus;
      finishedAt: number;
      rawBytes: number;
      storedBytes: number;
      sha256: string;
      fileName: string;
      error: string | null;
      manifest: BackupManifest;
      type: BackupType;
      parentRunId: string | null;
    }>,
  ): void {
    const columns: Record<string, string> = {
      status: 'status',
      finishedAt: 'finished_at',
      rawBytes: 'raw_bytes',
      storedBytes: 'stored_bytes',
      sha256: 'sha256',
      fileName: 'file_name',
      error: 'error',
      manifest: 'manifest',
      type: 'type',
      parentRunId: 'parent_run_id',
    };
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(patch)) {
      sets.push(`${columns[key]} = ?`);
      values.push(key === 'manifest' ? JSON.stringify(value) : value);
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE backup_runs SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }
  setFileIndex(runId: string, index: FileIndex): void {
    this.db
      .prepare('UPDATE backup_runs SET file_index = ? WHERE id = ?')
      .run(gzipSync(JSON.stringify(index)), runId);
  }
  fileIndex(runId: string): FileIndex | null {
    const row = this.db.prepare('SELECT file_index FROM backup_runs WHERE id = ?').get(runId) as
      { file_index: Buffer | Uint8Array | null } | undefined;
    if (!row?.file_index) return null;
    return JSON.parse(gunzipSync(Buffer.from(row.file_index)).toString('utf8')) as FileIndex;
  }
  manifest(runId: string): BackupManifest | null {
    const row = this.db.prepare('SELECT manifest FROM backup_runs WHERE id = ?').get(runId) as
      { manifest: string | null } | undefined;
    return row?.manifest ? (JSON.parse(row.manifest) as BackupManifest) : null;
  }

  private toSummary(row: RunRow, targets: TargetRow[]): RunSummary {
    const manifest = row.manifest ? (JSON.parse(row.manifest) as BackupManifest) : null;
    return {
      id: row.id,
      jobId: row.job_id,
      jobName: row.job_name,
      sourceKind: row.source_kind as BackupSourceKind,
      type: row.type as BackupType,
      status: row.status as RunStatus,
      trigger: row.trigger as 'manual' | 'schedule',
      startedAt: Number(row.started_at),
      finishedAt: num(row.finished_at),
      rawBytes: num(row.raw_bytes),
      storedBytes: num(row.stored_bytes),
      sha256: row.sha256,
      fileName: row.file_name,
      parentRunId: row.parent_run_id,
      error: row.error,
      encrypted: Boolean(manifest?.encryption),
      compression: (manifest?.compression ?? 'gzip') as Compression,
      targets: targets.map((t): RunTargetView => ({
        destinationId: t.destination_id,
        destinationName: t.destination_name,
        kind: t.kind as DestinationKind,
        status: t.status as TargetStatus,
        remoteKey: t.remote_key,
        bytes: Number(t.bytes),
        error: t.error,
        finishedAt: num(t.finished_at),
      })),
    };
  }

  run(id: string): RunSummary | undefined {
    const row = this.db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id) as
      RunRow | undefined;
    return row ? this.toSummary(row, this.targetRows(id)) : undefined;
  }

  runs(
    filter: {
      jobId?: string;
      status?: string;
      limit?: number;
      offset?: number;
      since?: number;
    } = {},
  ): RunSummary[] {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.jobId) {
      where.push('job_id = ?');
      values.push(filter.jobId);
    }
    if (filter.status) {
      where.push('status = ?');
      values.push(filter.status);
    }
    if (filter.since) {
      where.push('started_at >= ?');
      values.push(filter.since);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM backup_runs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY started_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, filter.limit ?? 50, filter.offset ?? 0) as RunRow[];
    return rows.map((row) => this.toSummary(row, this.targetRows(row.id)));
  }

  /** Successful (or partly successful) backups of a job, newest first: bases and retention. */
  usableRuns(jobId: string): RunSummary[] {
    return this.runs({ jobId, limit: 100_000 }).filter(
      (r) => r.status === 'success' || r.status === 'partial',
    );
  }

  // ── targets ──
  private targetRows(runId: string): TargetRow[] {
    return this.db
      .prepare('SELECT * FROM backup_run_targets WHERE run_id = ? ORDER BY destination_name')
      .all(runId) as TargetRow[];
  }
  addTarget(
    runId: string,
    destinationId: string,
    name: string,
    kind: DestinationKind,
    remoteKey: string,
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO backup_run_targets (run_id, destination_id, destination_name, kind, status, remote_key)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run(runId, destinationId, name, kind, remoteKey);
  }
  updateTarget(
    runId: string,
    destinationId: string,
    patch: { status?: TargetStatus; bytes?: number; error?: string | null; finishedAt?: number },
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (patch.status !== undefined) {
      sets.push('status = ?');
      values.push(patch.status);
    }
    if (patch.bytes !== undefined) {
      sets.push('bytes = ?');
      values.push(patch.bytes);
    }
    if (patch.error !== undefined) {
      sets.push('error = ?');
      values.push(patch.error);
    }
    if (patch.finishedAt !== undefined) {
      sets.push('finished_at = ?');
      values.push(patch.finishedAt);
    }
    if (sets.length === 0) return;
    this.db
      .prepare(
        `UPDATE backup_run_targets SET ${sets.join(', ')} WHERE run_id = ? AND destination_id = ?`,
      )
      .run(...values, runId, destinationId);
  }

  /** Bytes and count of stored backups per destination. */
  storageByDestination(): Map<string, { bytes: number; count: number }> {
    const rows = this.db
      .prepare(
        `SELECT t.destination_id AS id, COALESCE(SUM(r.stored_bytes), 0) AS bytes, COUNT(*) AS count
         FROM backup_run_targets t JOIN backup_runs r ON r.id = t.run_id
         WHERE t.status IN ('uploaded', 'verified') GROUP BY t.destination_id`,
      )
      .all() as { id: string; bytes: number; count: number }[];
    return new Map(rows.map((r) => [r.id, { bytes: Number(r.bytes), count: Number(r.count) }]));
  }

  // ── restores ──
  createRestore(r: {
    id: string;
    runId: string;
    jobName: string;
    target: string;
    startedAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO backup_restores (id, run_id, job_name, status, target, started_at) VALUES (?, ?, ?, 'running', ?, ?)`,
      )
      .run(r.id, r.runId, r.jobName, r.target, r.startedAt);
  }
  finishRestore(
    id: string,
    status: RestoreSummary['status'],
    finishedAt: number,
    error: string | null,
  ): void {
    this.db
      .prepare('UPDATE backup_restores SET status = ?, finished_at = ?, error = ? WHERE id = ?')
      .run(status, finishedAt, error, id);
  }
  restores(limit = 50): RestoreSummary[] {
    const rows = this.db
      .prepare('SELECT * FROM backup_restores ORDER BY started_at DESC LIMIT ?')
      .all(limit) as {
      id: string;
      run_id: string;
      job_name: string;
      status: string;
      target: string;
      started_at: number;
      finished_at: number | null;
      error: string | null;
    }[];
    return rows.map((r) => ({
      id: r.id,
      runId: r.run_id,
      jobName: r.job_name,
      status: r.status as RestoreSummary['status'],
      targetLabel: r.target,
      startedAt: Number(r.started_at),
      finishedAt: num(r.finished_at),
      error: r.error,
    }));
  }

  // ── logs ──
  log(ownerId: string, line: LogLine): void {
    this.db
      .prepare('INSERT INTO backup_logs (owner_id, at, level, message) VALUES (?, ?, ?, ?)')
      .run(ownerId, line.at, line.level, line.message.slice(0, 2000));
  }
  logs(ownerId: string, limit = 1000): LogLine[] {
    return (
      this.db
        .prepare(
          'SELECT at, level, message FROM backup_logs WHERE owner_id = ? ORDER BY at, rowid LIMIT ?',
        )
        .all(ownerId, limit) as LogLine[]
    ).map((l) => ({ ...l, at: Number(l.at) }));
  }

  // ── notifications ──
  notify(n: Omit<BackupNotification, 'id' | 'read'>): BackupNotification {
    const result = this.db
      .prepare(
        'INSERT INTO backup_notifications (at, level, title, body, run_id) VALUES (?, ?, ?, ?, ?)',
      )
      .run(n.at, n.level, n.title, n.body, n.runId);
    return { ...n, id: Number(result.lastInsertRowid), read: false };
  }
  notifications(limit = 100): BackupNotification[] {
    const rows = this.db
      .prepare('SELECT * FROM backup_notifications ORDER BY id DESC LIMIT ?')
      .all(limit) as {
      id: number;
      at: number;
      level: string;
      title: string;
      body: string;
      run_id: string | null;
      read: number;
    }[];
    return rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      level: r.level as BackupNotification['level'],
      title: r.title,
      body: r.body,
      runId: r.run_id,
      read: Number(r.read) === 1,
    }));
  }
  markRead(id: number | 'all'): void {
    if (id === 'all') this.db.prepare('UPDATE backup_notifications SET read = 1').run();
    else this.db.prepare('UPDATE backup_notifications SET read = 1 WHERE id = ?').run(id);
  }
  unread(): number {
    return Number(
      (
        this.db.prepare('SELECT COUNT(*) AS n FROM backup_notifications WHERE read = 0').get() as {
          n: number;
        }
      ).n,
    );
  }

  // ── recovery ──
  /** After a crash or stop: what was running is marked interrupted (files are cleaned by the engine). */
  interrupted(): { runs: RunSummary[]; restores: string[] } {
    const runs = this.runs({ status: 'running', limit: 10_000 });
    const restores = (
      this.db.prepare("SELECT id FROM backup_restores WHERE status = 'running'").all() as {
        id: string;
      }[]
    ).map((r) => r.id);
    return { runs, restores };
  }
}
