import { randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, type Readable, type Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BACKUP_SOURCE_LABELS,
  SOURCE_CAPABILITIES,
  type BackupEvent,
  type BackupManifest,
  type BackupNotification,
  type BackupType,
  type DestinationInput,
  type JobInput,
  type LogLine,
  type OperationProgress,
  type RestoreInput,
  type RunSummary,
  type SourceConfig,
} from '@app/shared';
import type { ResourceConfig } from '../config/resources-file';
import {
  errorMessage,
  readPassword,
  redactSecrets,
  type ConnectorContext,
} from '../connectors/connector';
import type { AuditLog } from '../storage/audit-log';
import type { SecretStore } from '../storage/secret-vault';
import { nextCronTime, validateCron } from './cron';
import { openDestination, type DestinationAdapter, type DestinationDeps } from './destinations';
import { selectExpired } from './retention';
import { LocalRunner, SshRunner, type Runner, type SshExecutor } from './runner';
import { SOURCE_ADAPTERS } from './sources';
import type { SourceContext } from './sources/types';
import type { BackupStore, JobRecord, StoredJob } from './store';
import {
  compressionExtension,
  createCompressStream,
  createDecompressStream,
  createDecryptStream,
  createEncryptStream,
  KDF,
  MeterStream,
  RateTracker,
  zstdAvailable,
} from './streams';

const SCHEDULER_TICK_MS = 20_000;
const MAX_CONCURRENT = 3;
const PROGRESS_EVERY_MS = 400;

export const passphraseId = (jobId: string) => `backup.job.${jobId}.passphrase`;
export const sourcePasswordId = (jobId: string) => `backup.job.${jobId}.source-password`;
const previousPassphrasePrefix = (jobId: string) => `backup.job.${jobId}.passphrase.previous.`;

export interface BackupNotifier {
  /** In-app notification is stored by the engine; this sends it to email / chat channels. */
  send(
    level: BackupNotification['level'],
    title: string,
    body: string,
    details: Record<string, unknown>,
  ): string[];
}

export interface BackupEngineDeps {
  store: BackupStore;
  vault: SecretStore;
  audit: AuditLog;
  notifier: BackupNotifier;
  appVersion: string;
  /** Where backups are assembled before upload and downloaded before a restore. */
  stagingDir: string;
  context: ConnectorContext;
  resources(): Promise<ReadonlyMap<string, ResourceConfig>>;
  connection(
    hostId: string,
  ): (SshExecutor & { sftp(): Promise<import('ssh2').SFTPWrapper> }) | undefined;
  hostLabel(hostId: string): string;
  hostExists(hostId: string): boolean;
  emit(event: BackupEvent): void;
  now?: () => number;
  log?: (message: string) => void;
}

interface ActiveOperation {
  progress: OperationProgress;
  controller: AbortController;
  lastEmit: number;
  rate: RateTracker;
  destRates: Map<string, RateTracker>;
}

export class BackupError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50) || 'backup';
const stampOf = (at: number) =>
  new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')
    .replace('T', '-');
const newId = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;

export class BackupEngine {
  private readonly active = new Map<string, ActiveOperation>();
  private readonly runningJobs = new Set<string>();
  private readonly queue: (() => void)[] = [];
  private running = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly local = new LocalRunner();

  constructor(private readonly deps: BackupEngineDeps) {
    this.now = deps.now ?? Date.now;
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    await mkdir(this.deps.stagingDir, { recursive: true });
    await this.recover();
    this.refreshSchedules();
    this.timer = setInterval(() => void this.tick(), SCHEDULER_TICK_MS);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const op of this.active.values()) op.controller.abort();
  }

  /**
   * After a crash, power loss or a stop mid-backup: mark what was running as
   * interrupted, remove partial uploads and staging files. Completed backups
   * and their files are never touched.
   */
  private async recover(): Promise<void> {
    const { runs, restores } = this.deps.store.interrupted();
    for (const run of runs) {
      this.deps.store.updateRun(run.id, {
        status: 'interrupted',
        finishedAt: this.now(),
        error: 'GRIDCITY stopped while this backup was running',
      });
      for (const target of run.targets) {
        if (target.status === 'pending' || target.status === 'uploading') {
          this.deps.store.updateTarget(run.id, target.destinationId, {
            status: 'failed',
            error: 'interrupted',
          });
          const destination = this.deps.store.destination(target.destinationId);
          if (destination && target.remoteKey) {
            try {
              const adapter = await openDestination(destination.input, this.destinationDeps());
              await adapter.cleanupPartial(target.remoteKey).catch(() => undefined);
              await adapter.close();
            } catch {
              // the destination is unreachable now; a later run overwrites nothing (keys are unique)
            }
          }
        }
      }
      this.deps.store.log(run.id, {
        at: this.now(),
        level: 'warn',
        message: 'Marked as interrupted after a restart; partial uploads removed',
      });
      this.deps.log?.(`backup ${run.id} (${run.jobName}) was interrupted by a restart`);
    }
    for (const id of restores)
      this.deps.store.finishRestore(
        id,
        'interrupted',
        this.now(),
        'GRIDCITY stopped while this restore was running',
      );
    // Staging files of interrupted operations.
    for (const name of await readdir(this.deps.stagingDir).catch(() => [] as string[])) {
      await rm(join(this.deps.stagingDir, name), { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private destinationDeps(): DestinationDeps {
    return {
      context: this.deps.context,
      s3Config: async (id) => {
        const config = (await this.deps.resources()).get(id);
        return config?.kind === 's3' ? config : undefined;
      },
      connection: (hostId) => this.deps.connection(hostId),
      hostLabel: (hostId) => this.deps.hostLabel(hostId),
    };
  }

  runnerFor(runnerId: string): Runner {
    if (runnerId === 'local') return this.local;
    if (!this.deps.hostExists(runnerId))
      throw new BackupError(`server "${runnerId}" is not in hosts.yaml any more`);
    return new SshRunner(runnerId, this.deps.hostLabel(runnerId), () =>
      this.deps.connection(runnerId),
    );
  }

  // ── scheduling ─────────────────────────────────────────────────────────

  refreshSchedules(): void {
    const now = this.now();
    for (const job of this.deps.store.jobs()) {
      const { schedule, scheduleEnabled } = job.config;
      if (!schedule || !scheduleEnabled || validateCron(schedule)) {
        if (job.nextRunAt !== null) this.deps.store.setNextRun(job.id, null);
        continue;
      }
      if (job.nextRunAt === null) this.deps.store.setNextRun(job.id, nextCronTime(schedule, now));
    }
  }

  private async tick(): Promise<void> {
    const now = this.now();
    for (const job of this.deps.store.jobs()) {
      if (job.nextRunAt === null || job.nextRunAt > now) continue;
      const { schedule } = job.config;
      this.deps.store.setNextRun(job.id, schedule ? nextCronTime(schedule, now) : null);
      if (this.runningJobs.has(job.id)) {
        this.deps.store.log(job.id, {
          at: now,
          level: 'warn',
          message: 'Skipped a scheduled run: the previous one is still running',
        });
        continue;
      }
      try {
        await this.runJob(job.id, 'schedule');
      } catch (error) {
        this.deps.log?.(`scheduled backup ${job.name} could not start: ${errorMessage(error)}`);
      }
    }
  }

  // ── jobs ───────────────────────────────────────────────────────────────

  /** Problems that would make a job fail before it does any work. */
  async jobProblems(
    input: StoredJob,
    hasPassphrase: boolean,
    hasSourcePassword: boolean,
  ): Promise<string[]> {
    const problems: string[] = [];
    const adapter = SOURCE_ADAPTERS[input.source.kind];
    const caps = SOURCE_CAPABILITIES[input.source.kind];
    const resources = await this.deps.resources();
    const resource = input.source.resourceId ? resources.get(input.source.resourceId) : undefined;
    if (input.source.resourceId && !resource)
      problems.push(`the connection "${input.source.resourceId}" is no longer in resources.yaml`);
    problems.push(...adapter.validate(input.source, resource));
    if (!caps.modes.includes(input.source.tool.mode)) {
      problems.push(
        `${BACKUP_SOURCE_LABELS[input.source.kind]} cannot run in "${input.source.tool.mode}" mode`,
      );
    }
    if (input.source.tool.runner !== 'local' && !this.deps.hostExists(input.source.tool.runner)) {
      problems.push(`server "${input.source.tool.runner}" is not in hosts.yaml`);
    }
    if (input.strategy === 'incremental' && !caps.incremental)
      problems.push(`${BACKUP_SOURCE_LABELS[input.source.kind]} has no incremental backups`);
    if (input.strategy === 'differential' && !caps.differential)
      problems.push(`${BACKUP_SOURCE_LABELS[input.source.kind]} has no differential backups`);
    if (input.schedule) {
      const cronError = validateCron(input.schedule);
      if (cronError) problems.push(`schedule: ${cronError}`);
    }
    if (input.encrypt && !hasPassphrase) problems.push('encryption is on: enter a passphrase');
    if (input.compression === 'zstd' && !zstdAvailable())
      problems.push('zstd needs Node.js 22.15 or newer');
    if (input.source.kind === 'firebird' && !hasSourcePassword)
      problems.push('enter the Firebird password');
    for (const id of input.destinationIds) {
      if (!this.deps.store.destination(id)) problems.push(`destination ${id} no longer exists`);
    }
    return problems;
  }

  async saveJob(id: string | null, input: JobInput): Promise<JobRecord> {
    const { passphrase, sourcePassword, ...config } = input;
    const isNew = id === null;
    const jobId = id ?? newId('job');
    const existing = isNew ? undefined : this.deps.store.job(jobId);
    if (!isNew && !existing) throw new BackupError('job not found', 404);
    const hasPassphrase = Boolean(passphrase) || this.deps.vault.has(passphraseId(jobId));
    const hasSourcePassword =
      Boolean(sourcePassword) || this.deps.vault.has(sourcePasswordId(jobId));
    const problems = await this.jobProblems(config, hasPassphrase, hasSourcePassword);
    if (problems.length > 0) throw new BackupError(problems.join('; '), 422);
    if (passphrase) {
      const previous = this.deps.vault.get(passphraseId(jobId));
      // Older backups were encrypted with the old passphrase: keep it so they stay restorable.
      if (previous && previous !== passphrase)
        this.deps.vault.set(`${previousPassphrasePrefix(jobId)}${this.now()}`, previous);
      this.deps.vault.set(passphraseId(jobId), passphrase);
    }
    if (sourcePassword) this.deps.vault.set(sourcePasswordId(jobId), sourcePassword);
    this.deps.store.saveJob(jobId, config, this.now(), isNew);
    this.deps.store.setNextRun(jobId, null);
    this.refreshSchedules();
    this.deps.audit.append(
      'settings_changed',
      null,
      `backup job ${isNew ? 'created' : 'edited'}: ${config.name}`,
    );
    this.deps.emit({ type: 'changed', what: 'jobs' });
    return this.deps.store.job(jobId)!;
  }

  /** Removes the job; its backups (history and files) are kept unless deleted one by one. */
  deleteJob(id: string): void {
    const job = this.deps.store.job(id);
    if (!job) throw new BackupError('job not found', 404);
    if (this.runningJobs.has(id)) throw new BackupError('the job is running: cancel it first', 409);
    this.deps.store.deleteJob(id, this.now());
    this.deps.audit.append(
      'settings_changed',
      null,
      `backup job removed (backups kept): ${job.name}`,
    );
    this.deps.emit({ type: 'changed', what: 'jobs' });
  }

  // ── destinations ───────────────────────────────────────────────────────

  saveDestination(id: string | null, input: DestinationInput): string {
    const destId = id ?? newId('dst');
    if (id && !this.deps.store.destination(id)) throw new BackupError('destination not found', 404);
    if (input.kind === 'sftp' && !this.deps.hostExists(input.hostId))
      throw new BackupError(`server "${input.hostId}" is not in hosts.yaml`, 422);
    const previous = id ? this.deps.store.destination(id) : undefined;
    this.deps.store.saveDestination(destId, input, this.now(), id === null);
    if (
      previous &&
      JSON.stringify({ ...previous.input, name: '' }) !== JSON.stringify({ ...input, name: '' })
    ) {
      this.deps.audit.append(
        'settings_changed',
        null,
        `backup destination "${input.name}" moved; existing backups stay where they were stored`,
      );
    } else {
      this.deps.audit.append(
        'settings_changed',
        null,
        `backup destination ${id ? 'edited' : 'added'}: ${input.name} (${input.kind})`,
      );
    }
    this.deps.emit({ type: 'changed', what: 'destinations' });
    return destId;
  }

  /** Only unused destinations can be removed, and their files are left where they are. */
  removeDestination(id: string): void {
    const destination = this.deps.store.destination(id);
    if (!destination) throw new BackupError('destination not found', 404);
    const users = this.deps.store.jobs().filter((j) => j.config.destinationIds.includes(id));
    if (users.length > 0)
      throw new BackupError(
        `used by ${users.map((u) => u.name).join(', ')}: remove it from those jobs first`,
        409,
      );
    this.deps.store.removeDestination(id);
    this.deps.audit.append(
      'settings_changed',
      null,
      `backup destination removed (files kept): ${destination.input.name}`,
    );
    this.deps.emit({ type: 'changed', what: 'destinations' });
  }

  // ── progress ───────────────────────────────────────────────────────────

  operations(): OperationProgress[] {
    return [...this.active.values()].map((op) => op.progress);
  }

  cancel(operationId: string): boolean {
    const op = this.active.get(operationId);
    if (!op) return false;
    op.controller.abort();
    return true;
  }

  private begin(
    kind: OperationProgress['kind'],
    title: string,
    jobId: string | null,
    runId: string | null,
    fixedId?: string,
  ): ActiveOperation {
    const id = fixedId ?? runId ?? newId(kind);
    const op: ActiveOperation = {
      progress: {
        id,
        kind,
        jobId,
        runId,
        title,
        stage: 'queued',
        stageLabel: 'Waiting for a free slot',
        startedAt: this.now(),
        processedBytes: 0,
        totalBytes: null,
        totalIsEstimate: false,
        percent: null,
        bytesPerSec: null,
        etaSeconds: null,
        destinations: [],
        status: 'running',
        error: null,
        finishedAt: null,
      },
      controller: new AbortController(),
      lastEmit: 0,
      rate: new RateTracker(this.now),
      destRates: new Map(),
    };
    this.active.set(id, op);
    this.emitProgress(op, true);
    return op;
  }

  private stage(
    op: ActiveOperation,
    stage: string,
    label: string,
    total: number | null = null,
    estimate = false,
  ) {
    Object.assign(op.progress, {
      stage,
      stageLabel: label,
      processedBytes: 0,
      totalBytes: total,
      totalIsEstimate: estimate,
      percent: total === 0 ? 100 : total ? 0 : null,
      bytesPerSec: null,
      etaSeconds: null,
    });
    op.rate = new RateTracker(this.now);
    this.emitProgress(op, true);
  }

  private bytes(op: ActiveOperation, processed: number) {
    const p = op.progress;
    p.processedBytes = processed;
    p.bytesPerSec = op.rate.update(processed);
    if (p.totalBytes && p.totalBytes > 0) {
      // An estimate (source size) never shows 100% before the stage really ends.
      p.percent = Math.min(
        p.totalIsEstimate ? 99 : 100,
        Math.floor((processed / p.totalBytes) * 100),
      );
      p.etaSeconds =
        p.bytesPerSec && p.bytesPerSec > 0
          ? Math.max(0, Math.round((p.totalBytes - processed) / p.bytesPerSec))
          : null;
      // Uploads run side by side: the whole stage ends with the slowest destination.
      const uploading =
        p.stage === 'uploading'
          ? p.destinations.filter((d) => d.status === 'uploading' || d.status === 'pending')
          : [];
      if (uploading.length > 0) {
        const etas = uploading.map((d) => d.etaSeconds);
        p.etaSeconds = etas.every((e) => e !== null) ? Math.max(...(etas as number[])) : null;
      }
    } else {
      p.percent = null;
      p.etaSeconds = null;
    }
    this.emitProgress(op);
  }

  private emitProgress(op: ActiveOperation, force = false) {
    const t = this.now();
    if (!force && t - op.lastEmit < PROGRESS_EVERY_MS) return;
    op.lastEmit = t;
    this.deps.emit({ type: 'progress', operation: structuredClone(op.progress) });
  }

  private finish(op: ActiveOperation, status: OperationProgress['status'], error: string | null) {
    Object.assign(op.progress, {
      status,
      error,
      finishedAt: this.now(),
      stage: 'done',
      stageLabel:
        status === 'success'
          ? 'Finished'
          : status === 'partial'
            ? 'Finished with problems'
            : status === 'cancelled'
              ? 'Cancelled'
              : 'Failed',
    });
    if (status === 'success') op.progress.percent = 100;
    if (op.progress.kind === 'backup' && op.progress.jobId)
      this.runningJobs.delete(op.progress.jobId);
    this.active.delete(op.progress.id);
    this.emitProgress(op, true);
  }

  private logger(op: ActiveOperation, ownerId: string, secrets: (string | undefined)[]) {
    return (level: LogLine['level'], message: string) => {
      const line: LogLine = { at: this.now(), level, message: redactSecrets(message, secrets) };
      this.deps.store.log(ownerId, line);
      this.deps.emit({ type: 'log', operationId: op.progress.id, line });
    };
  }

  private async slot(op: ActiveOperation): Promise<() => void> {
    if (this.running >= MAX_CONCURRENT) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    if (op.controller.signal.aborted) throw new Error('cancelled');
    this.running++;
    return () => {
      this.running--;
      this.queue.shift()?.();
    };
  }

  private notify(
    level: BackupNotification['level'],
    title: string,
    body: string,
    runId: string | null,
    details: Record<string, unknown>,
    external: boolean,
  ) {
    const notification = this.deps.store.notify({ at: this.now(), level, title, body, runId });
    this.deps.emit({ type: 'notification', notification });
    if (external) {
      const sentTo = this.deps.notifier.send(level, title, body, details);
      if (sentTo.length > 0)
        this.deps.audit.append('alert_sent', null, `${title} · ${sentTo.join(', ')}`);
    }
  }

  // ── backup ─────────────────────────────────────────────────────────────

  /** Decides full / incremental / differential and the backup it builds on. */
  private planType(
    job: JobRecord,
    forced?: BackupType,
  ): { type: BackupType; parent: RunSummary | null } {
    const { strategy, fullEvery } = job.config;
    const caps = SOURCE_CAPABILITIES[job.config.source.kind];
    const wanted = forced ?? strategy;
    if (wanted === 'full') return { type: 'full', parent: null };
    if (
      (wanted === 'incremental' && !caps.incremental) ||
      (wanted === 'differential' && !caps.differential)
    ) {
      return { type: 'full', parent: null };
    }
    // Only backups with a healthy copy somewhere can be built on.
    const usable = this.deps.store
      .usableRuns(job.id)
      .filter((r) => r.targets.some((t) => t.status === 'uploaded' || t.status === 'verified'));
    const lastFullIndex = usable.findIndex((r) => r.type === 'full');
    if (lastFullIndex < 0) return { type: 'full', parent: null };
    const sinceFull = lastFullIndex; // runs newer than the last full
    if (!forced && sinceFull >= fullEvery - 1) return { type: 'full', parent: null };
    if (wanted === 'differential') return { type: 'differential', parent: usable[lastFullIndex]! };
    return { type: 'incremental', parent: usable[0]! };
  }

  /** Starts a backup now; returns its run id (progress follows over events). */
  async runJob(
    jobId: string,
    trigger: 'manual' | 'schedule',
    forced?: BackupType,
  ): Promise<string> {
    const job = this.deps.store.job(jobId);
    if (!job) throw new BackupError('job not found', 404);
    if (this.runningJobs.has(jobId)) throw new BackupError('this job is already running', 409);
    const problems = await this.jobProblems(
      job.config,
      this.deps.vault.has(passphraseId(jobId)),
      this.deps.vault.has(sourcePasswordId(jobId)),
    );
    if (problems.length > 0) throw new BackupError(problems.join('; '), 422);
    const { type, parent } = this.planType(job, forced);
    const runId = newId('run');
    this.deps.store.createRun({
      id: runId,
      jobId,
      jobName: job.name,
      sourceKind: job.config.source.kind,
      type,
      trigger,
      startedAt: this.now(),
      parentRunId: parent?.id ?? null,
    });
    this.runningJobs.add(jobId);
    const op = this.begin('backup', job.name, jobId, runId);
    this.deps.emit({ type: 'changed', what: 'runs' });
    void this.executeBackup(op, job, runId, type, parent).finally(() => {
      this.runningJobs.delete(jobId);
      this.deps.emit({ type: 'changed', what: 'runs' });
    });
    return runId;
  }

  private async resolveSource(source: SourceConfig, jobId: string | null, extraPassword?: string) {
    const resources = await this.deps.resources();
    const resource = source.resourceId ? resources.get(source.resourceId) : undefined;
    if (source.resourceId && !resource)
      throw new Error(`the connection "${source.resourceId}" is no longer in resources.yaml`);
    let password = extraPassword;
    // The connection's own password: typed in the app (vault), an env variable or a file.
    if (
      !password &&
      resource &&
      ('passwordSecret' in resource || 'passwordEnv' in resource || 'passwordFile' in resource)
    ) {
      password = await readPassword(
        resource as Parameters<typeof readPassword>[0],
        this.deps.context,
      );
    }
    if (!password && jobId) password = this.deps.vault.get(sourcePasswordId(jobId));
    const runner = this.runnerFor(source.tool.runner);
    return { resource, password, runner };
  }

  private async executeBackup(
    op: ActiveOperation,
    job: JobRecord,
    runId: string,
    plannedType: BackupType,
    parent: RunSummary | null,
  ) {
    const { config } = job;
    const signal = op.controller.signal;
    const staging = join(this.deps.stagingDir, `${runId}.part`);
    const secrets: (string | undefined)[] = [this.deps.vault.get(passphraseId(job.id))];
    let log = this.logger(op, runId, secrets);
    let release: (() => void) | null = null;
    let type = plannedType;
    try {
      release = await this.slot(op);
      this.stage(op, 'preparing', 'Connecting to the source');
      const { resource, password, runner } = await this.resolveSource(config.source, job.id);
      secrets.push(password);
      log = this.logger(op, runId, secrets);
      log(
        'info',
        `${type === 'full' ? 'Full' : type === 'incremental' ? 'Incremental' : 'Differential'} backup of ${BACKUP_SOURCE_LABELS[config.source.kind]} (${SOURCE_ADAPTERS[config.source.kind].targetLabel(config.source, resource)})${parent ? `, based on the backup of ${new Date(parent.startedAt).toLocaleString()}` : ''}`,
      );

      const adapter = SOURCE_ADAPTERS[config.source.kind];
      const context: SourceContext = {
        source: config.source,
        resource,
        password,
        runner,
        connectorContext: this.deps.context,
        log,
        signal,
      };
      let sourceTotal: { bytes: number | null; estimate: boolean } = {
        bytes: null,
        estimate: false,
      };
      const output = await adapter.backup({
        ...context,
        type,
        strategy: config.strategy,
        base: parent
          ? {
              runId: parent.id,
              manifest: this.deps.store.manifest(parent.id)!,
              fileIndex: this.deps.store.fileIndex(parent.id),
            }
          : null,
        setTotal: (bytes, estimate) => {
          sourceTotal = { bytes, estimate };
        },
      });
      if (output.type && output.type !== type) {
        type = output.type;
        this.deps.store.updateRun(runId, {
          type,
          ...(type === 'full' ? { parentRunId: null } : {}),
        });
        if (type === 'full') parent = null;
      }

      // dump → count → compress → encrypt → hash → staging file
      this.stage(op, 'dumping', 'Reading the source', sourceTotal.bytes, sourceTotal.estimate);
      const rawMeter = new MeterStream((n) => this.bytes(op, n));
      const storedMeter = new MeterStream();
      const passphrase = config.encrypt ? this.deps.vault.get(passphraseId(job.id)) : undefined;
      if (config.encrypt && !passphrase)
        throw new Error('the encryption passphrase is missing: edit the job and enter it again');
      const encryption = passphrase ? await createEncryptStream(passphrase) : null;
      const steps: (Readable | Transform | Writable)[] = [output.stream, rawMeter];
      const compress = createCompressStream(config.compression);
      if (compress) steps.push(compress);
      if (encryption) steps.push(encryption.stream);
      steps.push(storedMeter, createWriteStream(staging));
      await Promise.all([
        pipeline(steps as unknown as [Readable, Writable], { signal }),
        output.done,
      ]);
      const finishedDump = this.now();
      const rawBytes = rawMeter.bytes;
      const storedBytes = storedMeter.bytes;
      const sha256 = storedMeter.digest();
      log(
        'info',
        `Source read: ${rawBytes.toLocaleString()} bytes → stored file ${storedBytes.toLocaleString()} bytes (${config.compression}${encryption ? ', AES-256-GCM' : ''}), SHA-256 ${sha256}`,
      );

      const started = this.deps.store.run(runId)!.startedAt;
      const fileName = `${slug(job.name)}-${stampOf(started)}-${type}${output.extension}${compressionExtension(config.compression)}${encryption ? '.enc' : ''}`;
      const key = `${slug(job.name)}/${fileName}`;
      const manifest: BackupManifest = {
        format: 'gridcity-backup',
        formatVersion: 1,
        appVersion: this.deps.appVersion,
        runId,
        jobId: job.id,
        jobName: job.name,
        type,
        parentRunId: parent?.id ?? null,
        baseRunId: parent
          ? parent.type === 'full'
            ? parent.id
            : (this.deps.store.manifest(parent.id)?.baseRunId ?? parent.id)
          : null,
        source: {
          kind: config.source.kind,
          label: BACKUP_SOURCE_LABELS[config.source.kind],
          contentFormat: output.contentFormat,
          tool: output.tool,
          details: output.details,
        },
        createdAt: new Date(started).toISOString(),
        finishedAt: new Date(finishedDump).toISOString(),
        rawBytes,
        storedBytes,
        sha256,
        compression: config.compression,
        encryption: encryption
          ? {
              algorithm: 'aes-256-gcm',
              kdf: 'scrypt',
              saltHex: encryption.salt.toString('hex'),
              N: 2 ** KDF.log2N,
              r: KDF.r,
              p: KDF.p,
            }
          : null,
        ...(output.deleted ? { deleted: output.deleted } : {}),
        ...(output.fileCount !== undefined ? { fileCount: output.fileCount } : {}),
      };
      this.deps.store.updateRun(runId, { rawBytes, storedBytes, sha256, fileName, manifest });

      // upload to every destination, each tracked on its own
      const destinations = config.destinationIds
        .map((id) => this.deps.store.destination(id))
        .filter((d) => d !== undefined);
      op.progress.destinations = destinations.map((d) => ({
        destinationId: d.id,
        name: d.input.name,
        status: 'pending',
        bytes: 0,
        totalBytes: storedBytes,
        percent: 0,
        bytesPerSec: null,
        etaSeconds: null,
        error: null,
      }));
      for (const d of destinations)
        this.deps.store.addTarget(runId, d.id, d.input.name, d.input.kind, key);
      this.stage(
        op,
        'uploading',
        `Uploading to ${destinations.length} destination${destinations.length === 1 ? '' : 's'}`,
        storedBytes * destinations.length,
      );
      const totals = new Map<string, number>();
      const results = await Promise.all(
        destinations.map((d) =>
          this.uploadOne(
            op,
            runId,
            d.id,
            d.input,
            staging,
            key,
            manifest,
            storedBytes,
            sha256,
            config.verifyAfterUpload,
            log,
            (bytes) => {
              totals.set(d.id, bytes);
              this.bytes(
                op,
                [...totals.values()].reduce((a, b) => a + b, 0),
              );
            },
          ),
        ),
      );
      const ok = results.filter(Boolean).length;
      const status = ok === destinations.length ? 'success' : ok > 0 ? 'partial' : 'failed';
      if (status !== 'failed' && output.fileIndex)
        this.deps.store.setFileIndex(runId, output.fileIndex);
      const failedNames = destinations.filter((_, i) => !results[i]).map((d) => d.input.name);
      this.deps.store.updateRun(runId, {
        status,
        finishedAt: this.now(),
        error: status === 'success' ? null : `upload failed: ${failedNames.join(', ')}`,
      });
      if (signal.aborted) throw new Error('cancelled');

      if (status !== 'failed') await this.applyRetention(job, log);
      const summary = `${fileName} · ${formatSize(storedBytes)} · ${ok}/${destinations.length} destination${destinations.length === 1 ? '' : 's'}`;
      this.deps.audit.append(
        'settings_changed',
        null,
        `backup ${status}: ${job.name} (${summary})`,
      );
      if (status === 'success') {
        log('info', `Backup finished in ${Math.round((this.now() - started) / 1000)} s`);
        this.notify(
          'success',
          `Backup succeeded: ${job.name}`,
          summary,
          runId,
          { job: job.name, runId, sha256 },
          config.notifyOnSuccess,
        );
      } else {
        this.notify(
          status === 'partial' ? 'warning' : 'error',
          status === 'partial'
            ? `Backup stored with problems: ${job.name}`
            : `Backup failed: ${job.name}`,
          `Could not store on ${failedNames.join(', ')}. ${summary}`,
          runId,
          { job: job.name, runId },
          config.notifyOnFailure,
        );
      }
      this.finish(
        op,
        status,
        status === 'success' ? null : `upload failed: ${failedNames.join(', ')}`,
      );
    } catch (error) {
      const cancelled = signal.aborted;
      const message = redactSecrets(
        cancelled ? 'cancelled by the user' : errorMessage(error),
        secrets,
      );
      log(cancelled ? 'warn' : 'error', message);
      this.deps.store.updateRun(runId, {
        status: cancelled ? 'cancelled' : 'failed',
        finishedAt: this.now(),
        error: message,
      });
      if (!cancelled) {
        this.deps.audit.append('settings_changed', null, `backup failed: ${job.name} (${message})`);
        this.notify(
          'error',
          `Backup failed: ${job.name}`,
          message,
          runId,
          { job: job.name, runId, error: message },
          config.notifyOnFailure,
        );
      }
      this.finish(op, cancelled ? 'cancelled' : 'failed', message);
    } finally {
      release?.();
      await rm(staging, { force: true }).catch(() => undefined);
    }
  }

  private async uploadOne(
    op: ActiveOperation,
    runId: string,
    destinationId: string,
    input: DestinationInput,
    file: string,
    key: string,
    manifest: BackupManifest,
    size: number,
    sha256: string,
    verify: boolean,
    log: (level: LogLine['level'], message: string) => void,
    onBytes: (bytes: number) => void,
  ): Promise<boolean> {
    const view = op.progress.destinations.find((d) => d.destinationId === destinationId)!;
    const rate = new RateTracker(this.now);
    let adapter: DestinationAdapter | null = null;
    try {
      adapter = await openDestination(input, this.destinationDeps());
      view.status = 'uploading';
      this.deps.store.updateTarget(runId, destinationId, { status: 'uploading' });
      this.emitProgress(op, true);
      await adapter.upload(
        file,
        key,
        (bytes) => {
          view.bytes = bytes;
          view.bytesPerSec = rate.update(bytes);
          view.percent = size > 0 ? Math.min(100, Math.floor((bytes / size) * 100)) : 100;
          view.etaSeconds = view.bytesPerSec ? Math.round((size - bytes) / view.bytesPerSec) : null;
          onBytes(bytes);
        },
        op.controller.signal,
      );
      await adapter.writeText(`${key}.manifest.json`, JSON.stringify(manifest, null, 2));
      const remote = await adapter.stat(key);
      if (!remote || remote.size !== size)
        throw new Error(`uploaded size ${remote?.size ?? 'missing'} ≠ ${size}`);
      view.bytes = size;
      view.percent = 100;
      onBytes(size);
      let status: 'uploaded' | 'verified' = 'uploaded';
      if (verify) {
        view.status = 'uploaded';
        this.emitProgress(op, true);
        const remoteHash =
          (await adapter.remoteSha256?.(key)) ?? (await hashStream(await adapter.download(key)));
        if (remoteHash !== sha256)
          throw new Error(
            `checksum mismatch after upload (${remoteHash.slice(0, 12)}… ≠ ${sha256.slice(0, 12)}…)`,
          );
        status = 'verified';
      }
      view.status = status;
      this.deps.store.updateTarget(runId, destinationId, {
        status,
        bytes: size,
        error: null,
        finishedAt: this.now(),
      });
      log(
        'info',
        `${input.name}: stored as ${key}${status === 'verified' ? ' (SHA-256 verified)' : ''}`,
      );
      this.emitProgress(op, true);
      return true;
    } catch (error) {
      const message = errorMessage(error);
      view.status = 'failed';
      view.error = message;
      this.deps.store.updateTarget(runId, destinationId, {
        status: 'failed',
        error: message,
        finishedAt: this.now(),
      });
      log('error', `${input.name}: ${message}`);
      await adapter?.cleanupPartial(key).catch(() => undefined);
      this.notify(
        'warning',
        `Storage error: ${input.name}`,
        message,
        runId,
        { destination: input.name, error: message },
        true,
      );
      this.emitProgress(op, true);
      return false;
    } finally {
      await adapter?.close().catch(() => undefined);
    }
  }

  /** Deletes backups the job's policy no longer keeps (only files GRIDCITY created and recorded). */
  private async applyRetention(
    job: JobRecord,
    log: (level: LogLine['level'], message: string) => void,
  ): Promise<void> {
    const runs = this.deps.store.usableRuns(job.id);
    const expired = selectExpired(
      runs.map((r) => ({
        id: r.id,
        startedAt: r.startedAt,
        type: r.type,
        parentRunId: r.parentRunId,
      })),
      job.config.retention,
      this.now(),
    );
    for (const id of expired) {
      const outcome = await this.deleteRunFiles(id);
      log(
        outcome.failed.length ? 'warn' : 'info',
        `Retention: removed the backup of ${new Date(this.deps.store.run(id)!.startedAt).toLocaleString()}${outcome.failed.length ? ` (could not delete on ${outcome.failed.join(', ')})` : ''}`,
      );
    }
  }

  private async deleteRunFiles(runId: string): Promise<{ failed: string[] }> {
    const run = this.deps.store.run(runId);
    if (!run) throw new BackupError('backup not found', 404);
    const failed: string[] = [];
    for (const target of run.targets) {
      if (!target.remoteKey || target.status === 'deleted') continue;
      const destination = this.deps.store.destination(target.destinationId);
      if (!destination) {
        failed.push(target.destinationName);
        continue;
      }
      try {
        const adapter = await openDestination(destination.input, this.destinationDeps());
        try {
          await adapter.remove(target.remoteKey);
          await adapter.remove(`${target.remoteKey}.manifest.json`);
        } finally {
          await adapter.close();
        }
        this.deps.store.updateTarget(runId, target.destinationId, { status: 'deleted' });
      } catch (error) {
        failed.push(`${target.destinationName} (${errorMessage(error)})`);
      }
    }
    if (failed.length === 0) this.deps.store.updateRun(runId, { status: 'deleted' });
    this.deps.audit.append(
      'settings_changed',
      null,
      `backup deleted: ${run.jobName} ${run.fileName ?? runId}`,
    );
    return { failed };
  }

  /** "Delete this backup" (asked by the user). Refused when a kept backup still depends on it. */
  async deleteRun(runId: string): Promise<{ failed: string[] }> {
    const run = this.deps.store.run(runId);
    if (!run) throw new BackupError('backup not found', 404);
    if (run.status === 'running') throw new BackupError('this backup is still running', 409);
    const dependents = this.deps.store.usableRuns(run.jobId).filter((r) => r.parentRunId === runId);
    if (dependents.length > 0)
      throw new BackupError(
        `${dependents.length} later backup(s) build on this one: delete them first`,
        409,
      );
    const result = await this.deleteRunFiles(runId);
    this.deps.emit({ type: 'changed', what: 'runs' });
    return result;
  }

  // ── restore & verify ───────────────────────────────────────────────────

  /** The backups needed to restore this one, oldest first. */
  chainOf(runId: string): RunSummary[] {
    const chain: RunSummary[] = [];
    let current = this.deps.store.run(runId);
    while (current) {
      chain.unshift(current);
      if (current.type === 'full' || !current.parentRunId) break;
      current = this.deps.store.run(current.parentRunId);
      if (!current) throw new BackupError('a backup this one depends on is missing from history');
    }
    if (chain[0]?.type !== 'full')
      throw new BackupError('the chain does not start with a full backup');
    for (const r of chain) {
      if (r.status === 'deleted')
        throw new BackupError(`a backup in the chain (${r.fileName}) was deleted`);
    }
    return chain;
  }

  /** The label a restore must be confirmed with, and what will happen. */
  async restorePlan(input: Pick<RestoreInput, 'runId' | 'target'>) {
    const run = this.deps.store.run(input.runId);
    if (!run) throw new BackupError('backup not found', 404);
    const job = this.deps.store.jobAny(run.jobId);
    if (!job) throw new BackupError('the job of this backup is gone');
    const target = mergeTarget(job.config.source, input.target);
    const resources = await this.deps.resources();
    const resource = target.resourceId ? resources.get(target.resourceId) : undefined;
    const adapter = SOURCE_ADAPTERS[target.kind];
    const chain = this.chainOf(run.id);
    const problems = [...adapter.validate(target, resource)];
    if (target.tool.runner !== 'local' && !this.deps.hostExists(target.tool.runner))
      problems.push(`server "${target.tool.runner}" is not in hosts.yaml`);
    return {
      label: adapter.targetLabel(target, resource),
      chain: chain.map((r) => ({
        id: r.id,
        type: r.type,
        startedAt: r.startedAt,
        storedBytes: r.storedBytes,
        fileName: r.fileName,
      })),
      problems,
      encrypted: chain.some((r) => r.encrypted),
      sameAsOriginal: JSON.stringify(target) === JSON.stringify(job.config.source),
    };
  }

  async restore(input: RestoreInput & { passphrase?: string }): Promise<string> {
    const plan = await this.restorePlan(input);
    if (plan.problems.length > 0) throw new BackupError(plan.problems.join('; '), 422);
    if (input.confirm.trim() !== plan.label) {
      throw new BackupError(
        `type "${plan.label}" to confirm: the restore replaces data there`,
        422,
      );
    }
    const run = this.deps.store.run(input.runId)!;
    const job = this.deps.store.jobAny(run.jobId)!;
    const restoreId = newId('rst');
    this.deps.store.createRestore({
      id: restoreId,
      runId: run.id,
      jobName: run.jobName,
      target: plan.label,
      startedAt: this.now(),
    });
    const op = this.begin(
      'restore',
      `Restore ${run.jobName} → ${plan.label}`,
      run.jobId,
      null,
      restoreId,
    );
    this.deps.audit.append(
      'settings_changed',
      null,
      `restore started: ${run.jobName} ${run.fileName} → ${plan.label}`,
    );
    this.deps.emit({ type: 'changed', what: 'restores' });
    void this.executeRestore(op, restoreId, input, job, plan.label).finally(() =>
      this.deps.emit({ type: 'changed', what: 'restores' }),
    );
    return restoreId;
  }

  /** Candidate passphrases for a job's backups: the current one, then older ones. */
  private passphrases(jobId: string, given?: string): string[] {
    const list = [given, this.deps.vault.get(passphraseId(jobId))];
    for (const id of this.deps.vault
      .ids()
      .filter((i) => i.startsWith(previousPassphrasePrefix(jobId)))
      .sort()
      .reverse()) {
      list.push(this.deps.vault.get(id));
    }
    return [...new Set(list.filter((p): p is string => Boolean(p)))];
  }

  /** Downloads one artifact, checks its SHA-256 and turns it into the raw backup (decrypted, decompressed). */
  private async fetchArtifact(
    op: ActiveOperation,
    run: RunSummary,
    preferred: string | undefined,
    dir: string,
    passphrases: string[],
    log: (level: LogLine['level'], message: string) => void,
  ): Promise<{ raw: string; manifest: BackupManifest }> {
    const manifest = this.deps.store.manifest(run.id);
    if (!manifest) throw new Error(`backup ${run.id} has no manifest`);
    const targets = run.targets
      .filter((t) => (t.status === 'uploaded' || t.status === 'verified') && t.remoteKey)
      .sort((a, b) =>
        a.destinationId === preferred
          ? -1
          : b.destinationId === preferred
            ? 1
            : a.status === 'verified'
              ? -1
              : 1,
      );
    if (targets.length === 0) throw new Error(`no stored copy of ${run.fileName} is available`);
    const stored = join(dir, `${run.id}.stored`);
    let lastError = '';
    for (const target of targets) {
      const destination = this.deps.store.destination(target.destinationId);
      if (!destination) continue;
      try {
        this.stage(
          op,
          'downloading',
          `Downloading ${run.fileName} from ${destination.input.name}`,
          manifest.storedBytes,
        );
        const adapter = await openDestination(destination.input, this.destinationDeps());
        try {
          const meter = new MeterStream((n) => this.bytes(op, n));
          await pipeline(
            await adapter.download(target.remoteKey!),
            meter,
            createWriteStream(stored),
            { signal: op.controller.signal },
          );
          const hash = meter.digest();
          if (hash !== manifest.sha256) {
            this.deps.store.updateTarget(run.id, target.destinationId, {
              status: 'failed',
              error: 'checksum mismatch on download',
            });
            throw new Error(`checksum mismatch: the copy on ${destination.input.name} is damaged`);
          }
          log(
            'info',
            `${run.fileName}: downloaded from ${destination.input.name}, SHA-256 matches`,
          );
        } finally {
          await adapter.close();
        }
        lastError = '';
        break;
      } catch (error) {
        if (op.controller.signal.aborted) throw error;
        lastError = errorMessage(error);
        log('warn', `${destination.input.name}: ${lastError}`);
      }
    }
    if (lastError) throw new Error(`no intact copy could be downloaded (${lastError})`);

    const raw = join(dir, `${run.id}.raw`);
    this.stage(op, 'validating', `Decrypting and checking ${run.fileName}`, manifest.rawBytes);
    const candidates = manifest.encryption ? passphrases : [''];
    if (manifest.encryption && candidates.length === 0)
      throw new Error('this backup is encrypted: enter its passphrase');
    let decrypted = false;
    let failure = '';
    for (const passphrase of candidates) {
      try {
        const meter = new MeterStream((n) => this.bytes(op, n));
        const steps: (Readable | Transform | Writable)[] = [createReadStream(stored)];
        if (manifest.encryption) steps.push(createDecryptStream(passphrase));
        const decompress = createDecompressStream(manifest.compression);
        if (decompress) steps.push(decompress);
        steps.push(meter, createWriteStream(raw));
        await pipeline(steps as unknown as [Readable, Writable], { signal: op.controller.signal });
        if (meter.bytes !== manifest.rawBytes)
          throw new Error(`size ${meter.bytes} ≠ ${manifest.rawBytes} recorded`);
        decrypted = true;
        break;
      } catch (error) {
        failure = errorMessage(error);
        if (op.controller.signal.aborted) throw error;
      }
    }
    if (!decrypted) throw new Error(`the backup could not be read: ${failure}`);
    await rm(stored, { force: true });
    log(
      'info',
      `${run.fileName}: intact (${manifest.rawBytes.toLocaleString()} bytes of backup data)`,
    );
    return { raw, manifest };
  }

  private async executeRestore(
    op: ActiveOperation,
    restoreId: string,
    input: RestoreInput & { passphrase?: string },
    job: JobRecord,
    label: string,
  ) {
    const signal = op.controller.signal;
    const dir = join(this.deps.stagingDir, restoreId);
    const secrets: (string | undefined)[] = [input.passphrase, input.targetPassword];
    let log = this.logger(op, restoreId, secrets);
    let release: (() => void) | null = null;
    try {
      release = await this.slot(op);
      await mkdir(dir, { recursive: true });
      const chain = this.chainOf(input.runId);
      const target = mergeTarget(job.config.source, input.target);
      log(
        'info',
        `Restoring ${chain.length > 1 ? `a chain of ${chain.length} backups` : 'one backup'} into ${label}`,
      );
      const passphrases = this.passphrases(job.id, input.passphrase);
      secrets.push(...passphrases);

      // 1. Every artifact downloaded and proven intact before anything is changed.
      const artifacts: { raw: string; manifest: BackupManifest }[] = [];
      for (const run of chain)
        artifacts.push(
          await this.fetchArtifact(op, run, input.destinationId, dir, passphrases, log),
        );

      // 2. Restore, oldest first.
      const sameJobSource =
        target.resourceId === job.config.source.resourceId &&
        target.tool.runner === job.config.source.tool.runner;
      const { resource, password, runner } = await this.resolveSource(
        target,
        sameJobSource ? job.id : null,
        input.targetPassword,
      );
      secrets.push(password);
      log = this.logger(op, restoreId, secrets);
      const adapter = SOURCE_ADAPTERS[target.kind];
      const base: SourceContext = {
        source: target,
        resource,
        password,
        runner,
        connectorContext: this.deps.context,
        log,
        signal,
      };
      for (const [index, artifact] of artifacts.entries()) {
        this.stage(
          op,
          'restoring',
          `Restoring ${chain[index]!.type} backup ${index + 1} of ${artifacts.length}`,
          artifact.manifest.rawBytes,
        );
        const meter = new MeterStream((n) => this.bytes(op, n));
        const reader = createReadStream(artifact.raw);
        const fed = new PassThrough();
        reader.pipe(meter).pipe(fed);
        await adapter.restore(
          {
            ...base,
            manifest: artifact.manifest,
            chainIndex: index,
            chainLength: artifacts.length,
            applyDeletions: input.applyDeletions,
            createDatabase: input.createDatabase,
          },
          fed,
        );
      }
      if (adapter.check) {
        // Keep the restored byte count visible while checking.
        const restoredBytes = artifacts.reduce((sum, a) => sum + a.manifest.rawBytes, 0);
        this.stage(op, 'checking', 'Checking the restored data', restoredBytes);
        this.bytes(op, restoredBytes);
        try {
          const proof = await adapter.check({
            ...base,
            manifest: artifacts.at(-1)!.manifest,
            chainIndex: 0,
            chainLength: artifacts.length,
            applyDeletions: false,
            createDatabase: false,
          });
          log('info', `Check after restore: ${proof}`);
        } catch (error) {
          log('warn', `Could not check the result: ${errorMessage(error)}`);
        }
      }
      this.deps.store.finishRestore(restoreId, 'success', this.now(), null);
      this.deps.audit.append('settings_changed', null, `restore finished: ${job.name} → ${label}`);
      this.notify(
        'success',
        `Restore completed: ${job.name}`,
        `Restored into ${label}`,
        input.runId,
        { job: job.name, target: label },
        true,
      );
      this.finish(op, 'success', null);
    } catch (error) {
      const cancelled = signal.aborted;
      const message = redactSecrets(
        cancelled ? 'cancelled by the user' : errorMessage(error),
        secrets,
      );
      log(cancelled ? 'warn' : 'error', message);
      this.deps.store.finishRestore(
        restoreId,
        cancelled ? 'cancelled' : 'failed',
        this.now(),
        message,
      );
      this.deps.audit.append(
        'settings_changed',
        null,
        `restore ${cancelled ? 'cancelled' : 'failed'}: ${job.name} → ${label} (${message})`,
      );
      if (!cancelled)
        this.notify(
          'error',
          `Restore failed: ${job.name}`,
          message,
          input.runId,
          { job: job.name, target: label, error: message },
          true,
        );
      this.finish(op, cancelled ? 'cancelled' : 'failed', message);
    } finally {
      release?.();
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Downloads a stored copy, checks the SHA-256 and reads it to the end (decrypt + decompress). */
  async verify(runId: string, destinationId?: string, passphrase?: string): Promise<string> {
    const run = this.deps.store.run(runId);
    if (!run) throw new BackupError('backup not found', 404);
    const op = this.begin('verify', `Verify ${run.fileName}`, run.jobId, null);
    const dir = join(this.deps.stagingDir, op.progress.id);
    const log = this.logger(op, runId, [passphrase]);
    void (async () => {
      let release: (() => void) | null = null;
      try {
        release = await this.slot(op);
        await mkdir(dir, { recursive: true });
        const preferredTargets = destinationId
          ? run.targets.filter((t) => t.destinationId === destinationId)
          : run.targets;
        for (const target of preferredTargets.filter(
          (t) => t.status === 'uploaded' || t.status === 'verified',
        )) {
          const destination = this.deps.store.destination(target.destinationId);
          if (!destination) continue;
          const adapter = await openDestination(destination.input, this.destinationDeps());
          const exists = await adapter.stat(target.remoteKey!).finally(() => adapter.close());
          if (!exists) {
            this.deps.store.updateTarget(runId, target.destinationId, {
              status: 'missing',
              error: 'the file is no longer there',
            });
            log('error', `${destination.input.name}: the file is missing`);
            continue;
          }
          const single: RunSummary = { ...run, targets: [target] };
          await this.fetchArtifact(
            op,
            single,
            target.destinationId,
            dir,
            this.passphrases(run.jobId, passphrase),
            log,
          );
          await rm(join(dir, `${run.id}.raw`), { force: true });
          this.deps.store.updateTarget(runId, target.destinationId, {
            status: 'verified',
            error: null,
          });
          log('info', `${destination.input.name}: verified`);
        }
        this.finish(op, 'success', null);
      } catch (error) {
        const message = errorMessage(error);
        log('error', `Verification failed: ${message}`);
        this.notify(
          'error',
          `Verification failed: ${run.jobName}`,
          message,
          runId,
          { runId, error: message },
          true,
        );
        this.finish(op, op.controller.signal.aborted ? 'cancelled' : 'failed', message);
      } finally {
        release?.();
        this.deps.emit({ type: 'changed', what: 'runs' });
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    })();
    return op.progress.id;
  }
}

/** The original source with the restore's overrides (only fields that were given). */
export function mergeTarget(
  original: SourceConfig,
  overrides: RestoreInput['target'],
): SourceConfig {
  const given = <T extends object>(o: T) =>
    Object.fromEntries(
      Object.entries(o).filter(([, v]) => v !== undefined && v !== ''),
    ) as Partial<T>;
  const { tool, ...rest } = overrides;
  return {
    ...original,
    ...given(rest),
    kind: original.kind,
    tool: { ...original.tool, ...given(tool ?? {}) },
  };
}

async function hashStream(stream: Readable): Promise<string> {
  const meter = new MeterStream();
  await pipeline(stream, meter, new Writable({ write: (_c, _e, done) => done() }));
  return meter.digest();
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
