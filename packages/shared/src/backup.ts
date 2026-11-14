import { z } from 'zod';

/**
 * Backup & Restore (v1.2): what the browser and the server agree on.
 *
 * Sources reuse what is already connected: databases from resources.yaml
 * (their saved passwords), servers from hosts.yaml (their SSH connection),
 * buckets from resources.yaml (their access keys). Nothing here carries a
 * secret value; secrets live in the encrypted vault on the server.
 */

export const BACKUP_SOURCE_KINDS = [
  'postgres',
  'mysql',
  'mongodb',
  'redis',
  'sqlite',
  'mssql',
  'firebird',
  'docker-volume',
  'docker-container',
  'files',
  'custom',
] as const;
export type BackupSourceKind = (typeof BACKUP_SOURCE_KINDS)[number];

export const BACKUP_SOURCE_LABELS: Record<BackupSourceKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL / MariaDB',
  mongodb: 'MongoDB',
  redis: 'Redis / Valkey',
  sqlite: 'SQLite',
  mssql: 'SQL Server',
  firebird: 'Firebird',
  'docker-volume': 'Docker volume',
  'docker-container': 'Docker container',
  files: 'Files and folders',
  custom: 'Custom command',
};

export const BACKUP_TYPES = ['full', 'incremental', 'differential'] as const;
export type BackupType = (typeof BACKUP_TYPES)[number];

/** What a source can do (the UI only offers what is real). */
export interface SourceCapabilities {
  incremental: boolean;
  differential: boolean;
  restore: boolean;
  /** How the tool is found: the modes this source accepts. */
  modes: ToolMode[];
}

export const SOURCE_CAPABILITIES: Record<BackupSourceKind, SourceCapabilities> = {
  postgres: {
    incremental: false,
    differential: false,
    restore: true,
    modes: ['docker-image', 'docker-exec', 'native'],
  },
  mysql: {
    incremental: false,
    differential: false,
    restore: true,
    modes: ['docker-image', 'docker-exec', 'native'],
  },
  mongodb: {
    incremental: false,
    differential: false,
    restore: true,
    modes: ['driver', 'docker-image', 'docker-exec', 'native'],
  },
  redis: { incremental: false, differential: false, restore: true, modes: ['driver'] },
  sqlite: { incremental: false, differential: false, restore: true, modes: ['driver', 'native'] },
  mssql: {
    incremental: false,
    differential: true,
    restore: true,
    modes: ['docker-exec', 'native'],
  },
  firebird: {
    incremental: false,
    differential: false,
    restore: true,
    modes: ['docker-image', 'docker-exec', 'native'],
  },
  'docker-volume': { incremental: false, differential: false, restore: true, modes: ['native'] },
  'docker-container': { incremental: false, differential: false, restore: true, modes: ['native'] },
  files: { incremental: true, differential: true, restore: true, modes: ['native'] },
  custom: { incremental: false, differential: false, restore: true, modes: ['native'] },
};

/**
 * Where the backup tool runs.
 * - driver: inside GRIDCITY, with the database driver it already uses (no tool needed)
 * - native: the tool installed on the runner (pg_dump on the server, or on this machine)
 * - docker-image: a throwaway container of the official image (`docker run --rm`)
 * - docker-exec: inside the database's own container (`docker exec`), tools always match
 */
export const TOOL_MODES = ['driver', 'native', 'docker-image', 'docker-exec'] as const;
export type ToolMode = (typeof TOOL_MODES)[number];

const idText = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._:@/-]+$/, 'only letters, digits and . _ : @ / -');

/** Absolute POSIX path or Windows path; no newlines or NUL. */
const pathText = z
  .string()
  .trim()
  .min(1)
  .max(1000)
  .refine((value) => !/[\0\r\n]/.test(value), 'no line breaks');

export const ToolSchema = z.strictObject({
  /** "local" = the machine GRIDCITY runs on; otherwise a server id from hosts.yaml. */
  runner: z.union([z.literal('local'), idText]).default('local'),
  mode: z.enum(TOOL_MODES).default('driver'),
  /** docker-image: image to run ("postgres:17"); a sensible default per kind otherwise. */
  image: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._/:@-]*$/, 'not an image name')
    .optional(),
  /** docker-exec: the container name or id. */
  container: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._-]*$/, 'not a container name')
    .optional(),
});
export type ToolConfig = z.infer<typeof ToolSchema>;

export const SourceSchema = z.strictObject({
  kind: z.enum(BACKUP_SOURCE_KINDS),
  /** A resources.yaml entry (databases): host, user and saved password are reused. */
  resourceId: idText.optional(),
  tool: ToolSchema.prefault({}),
  /** Database name (postgres, mysql, mssql, mongodb); empty = the entry's default / all. */
  database: z.string().trim().max(200).optional(),
  /** files / sqlite / firebird: a path on the runner. */
  path: pathText.optional(),
  /** files: patterns left out ("node_modules", "*.log"). */
  exclude: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  /** docker-volume / docker-container: the name. */
  dockerName: z
    .string()
    .trim()
    .max(200)
    .regex(/^[A-Za-z0-9._-]*$/, 'not a docker name')
    .optional(),
  /** firebird (no resources.yaml kind): connection details; the password goes to the vault. */
  host: z.string().trim().max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().trim().max(200).optional(),
  /** custom: commands run on the runner. Backup writes the backup to stdout; restore reads stdin. */
  backupCommand: z.string().max(4000).optional(),
  restoreCommand: z.string().max(4000).optional(),
});
export type SourceConfig = z.infer<typeof SourceSchema>;

export const DESTINATION_KINDS = ['local', 's3', 'sftp'] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const DestinationInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('local'),
    name: z.string().trim().min(1).max(80),
    path: pathText,
  }),
  z.strictObject({
    kind: z.literal('s3'),
    name: z.string().trim().min(1).max(80),
    /** An s3 entry in resources.yaml: its endpoint and saved access keys. */
    resourceId: idText,
    bucket: z
      .string()
      .trim()
      .min(3)
      .max(63)
      .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/, 'not a bucket name'),
    prefix: z
      .string()
      .trim()
      .max(500)
      .regex(/^[^\0\r\n]*$/)
      .default(''),
  }),
  z.strictObject({
    kind: z.literal('sftp'),
    name: z.string().trim().min(1).max(80),
    /** A server in hosts.yaml: its SSH connection is reused. */
    hostId: idText,
    path: pathText,
  }),
]);
export type DestinationInput = z.infer<typeof DestinationInputSchema>;

export type DestinationView = DestinationInput & {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** Jobs that upload here (a destination in use cannot be removed). */
  usedBy: string[];
  /** Bytes of GRIDCITY backups stored here (from history; null = unknown). */
  storedBytes: number;
  backupCount: number;
};

/** "keep the last 7", "a daily for 14 days", grandfather-father-son. Empty = keep everything. */
export const RetentionSchema = z.strictObject({
  keepLast: z.number().int().min(1).max(10_000).optional(),
  keepDaily: z.number().int().min(1).max(3650).optional(),
  keepWeekly: z.number().int().min(1).max(520).optional(),
  keepMonthly: z.number().int().min(1).max(1200).optional(),
  maxAgeDays: z.number().int().min(1).max(36_500).optional(),
});
export type RetentionPolicy = z.infer<typeof RetentionSchema>;

export const COMPRESSIONS = ['gzip', 'zstd', 'none'] as const;
export type Compression = (typeof COMPRESSIONS)[number];

export const JobInputSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  source: SourceSchema,
  destinationIds: z.array(z.string().min(1).max(64)).min(1).max(10),
  /** Five-field cron ("0 3 * * *"), in the server's local time. Null = manual only. */
  schedule: z.string().trim().max(100).nullable().default(null),
  scheduleEnabled: z.boolean().default(true),
  /** full: every run is full. incremental / differential: with a full every `fullEvery` runs. */
  strategy: z.enum(BACKUP_TYPES).default('full'),
  fullEvery: z.number().int().min(1).max(365).default(7),
  retention: RetentionSchema.prefault({}),
  compression: z.enum(COMPRESSIONS).default('gzip'),
  /** AES-256-GCM with a key derived from this passphrase (scrypt). Write it down. */
  encrypt: z.boolean().default(false),
  /** Typed on create or to change it; kept in the vault, never returned. */
  passphrase: z.string().min(8).max(1024).optional(),
  /** Download each upload again and compare the SHA-256. */
  verifyAfterUpload: z.boolean().default(true),
  notifyOnSuccess: z.boolean().default(true),
  notifyOnFailure: z.boolean().default(true),
  /** A password the source needs that resources.yaml cannot hold (firebird). */
  sourcePassword: z.string().max(1024).optional(),
});
export type JobInput = z.infer<typeof JobInputSchema>;

export type JobView = Omit<JobInput, 'passphrase' | 'sourcePassword'> & {
  id: string;
  createdAt: number;
  updatedAt: number;
  hasPassphrase: boolean;
  hasSourcePassword: boolean;
  lastRun: RunSummary | null;
  nextRunAt: number | null;
  /** Problems found with the schedule, source or destinations (shown on the card). */
  problems: string[];
};

export type RunStatus =
  'running' | 'success' | 'partial' | 'failed' | 'interrupted' | 'cancelled' | 'deleted';

export type TargetStatus =
  'pending' | 'uploading' | 'uploaded' | 'verified' | 'failed' | 'deleted' | 'missing';

export interface RunTargetView {
  destinationId: string;
  destinationName: string;
  kind: DestinationKind;
  status: TargetStatus;
  remoteKey: string | null;
  bytes: number;
  error: string | null;
  finishedAt: number | null;
}

export interface RunSummary {
  id: string;
  jobId: string;
  jobName: string;
  sourceKind: BackupSourceKind;
  type: BackupType;
  status: RunStatus;
  trigger: 'manual' | 'schedule';
  startedAt: number;
  finishedAt: number | null;
  /** Bytes the source produced (before compression). */
  rawBytes: number | null;
  /** Bytes of the stored file. */
  storedBytes: number | null;
  sha256: string | null;
  fileName: string | null;
  parentRunId: string | null;
  error: string | null;
  targets: RunTargetView[];
  encrypted: boolean;
  compression: Compression;
}

export interface BackupManifest {
  format: 'gridcity-backup';
  formatVersion: 1;
  appVersion: string;
  runId: string;
  jobId: string;
  jobName: string;
  type: BackupType;
  parentRunId: string | null;
  baseRunId: string | null;
  source: {
    kind: BackupSourceKind;
    label: string;
    /** What the artifact contains: pg custom dump, tar, mysqldump SQL, gridcity redis records… */
    contentFormat: string;
    tool: string | null;
    details: Record<string, unknown>;
  };
  createdAt: string;
  finishedAt: string;
  rawBytes: number;
  storedBytes: number;
  sha256: string;
  compression: Compression;
  encryption: null | {
    algorithm: 'aes-256-gcm';
    kdf: 'scrypt';
    /** Salt and IV are in the file header too; repeated here for tooling. */
    saltHex: string;
    N: number;
    r: number;
    p: number;
  };
  /** files: removed since the parent backup (applied on restore when asked). */
  deleted?: string[];
  fileCount?: number;
}

/** Live progress of one operation. Percent is null whenever it cannot be measured. */
export interface OperationProgress {
  id: string;
  kind: 'backup' | 'restore' | 'verify';
  jobId: string | null;
  runId: string | null;
  title: string;
  stage: string;
  stageLabel: string;
  startedAt: number;
  processedBytes: number;
  /** Known only when it is measurable. */
  totalBytes: number | null;
  /** True when totalBytes is the source's size, not the exact output size. */
  totalIsEstimate: boolean;
  percent: number | null;
  bytesPerSec: number | null;
  etaSeconds: number | null;
  destinations: {
    destinationId: string;
    name: string;
    status: TargetStatus;
    bytes: number;
    totalBytes: number | null;
    percent: number | null;
    bytesPerSec: number | null;
    etaSeconds: number | null;
    error: string | null;
  }[];
  status: 'running' | 'success' | 'failed' | 'partial' | 'cancelled';
  error: string | null;
  finishedAt: number | null;
}

export interface LogLine {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface BackupNotification {
  id: number;
  at: number;
  level: 'success' | 'error' | 'warning' | 'info';
  title: string;
  body: string;
  runId: string | null;
  read: boolean;
}

export interface RestoreSummary {
  id: string;
  runId: string;
  jobName: string;
  status: 'running' | 'success' | 'failed' | 'cancelled' | 'interrupted';
  targetLabel: string;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
}

export interface BackupDashboard {
  health: 'healthy' | 'warning' | 'failing' | 'empty';
  healthReasons: string[];
  jobs: number;
  activeOperations: OperationProgress[];
  last7Days: { success: number; failed: number; partial: number };
  last30Days: { success: number; failed: number; partial: number };
  daily: { date: string; success: number; failed: number }[];
  storage: {
    destinationId: string;
    name: string;
    kind: DestinationKind;
    bytes: number;
    count: number;
  }[];
  upcoming: { jobId: string; jobName: string; at: number }[];
  recent: RunSummary[];
  unread: number;
}

/** A thing found on a server or in resources.yaml that can be backed up. */
export interface DiscoveredItem {
  key: string;
  label: string;
  detail: string;
  where: string;
  source: Partial<SourceConfig> & { kind: BackupSourceKind };
  /** Already covered by these jobs. */
  coveredBy: string[];
}

export interface DiscoveryResult {
  items: DiscoveredItem[];
  /** Per runner: what could not be looked at, and why. */
  problems: { where: string; message: string }[];
  scannedAt: number;
}

/** Restore request: which backup, where to, and the typed confirmation. */
export const RestoreInputSchema = z.strictObject({
  runId: z.string().min(1).max(64),
  /** Download from this destination; the first healthy copy otherwise. */
  destinationId: z.string().min(1).max(64).optional(),
  /**
   * Overrides of the source for the target; empty = restore to the original.
   * No defaults inside: a field that is not given keeps the backup's value.
   */
  target: z
    .strictObject({
      resourceId: idText.optional(),
      database: z.string().trim().max(200).optional(),
      path: pathText.optional(),
      dockerName: z
        .string()
        .trim()
        .max(200)
        .regex(/^[A-Za-z0-9._-]*$/, 'not a docker name')
        .optional(),
      host: z.string().trim().max(255).optional(),
      port: z.number().int().min(1).max(65535).optional(),
      user: z.string().trim().max(200).optional(),
      tool: z
        .strictObject({
          runner: idText.optional(),
          mode: z.enum(TOOL_MODES).optional(),
          image: ToolSchema.shape.image,
          container: ToolSchema.shape.container,
        })
        .optional(),
    })
    .default({}),
  /** files: also delete files that the incremental chain recorded as removed. */
  applyDeletions: z.boolean().default(false),
  /** Databases: create the target database when it does not exist. */
  createDatabase: z.boolean().default(true),
  /** Firebird / custom on another server: its password (not saved). */
  targetPassword: z.string().max(1024).optional(),
  /** Encrypted backups: the passphrase, when it is not the one saved with the job. */
  passphrase: z.string().max(1024).optional(),
  /** Must equal the target's label shown in the dialog (destructive operation). */
  confirm: z.string().max(500),
});
export type RestoreInput = z.infer<typeof RestoreInputSchema>;

/** Server → browser over /api/backup/events (Server-Sent Events). */
export type BackupEvent =
  | { type: 'progress'; operation: OperationProgress }
  | { type: 'log'; operationId: string; line: LogLine }
  | { type: 'notification'; notification: BackupNotification }
  | { type: 'changed'; what: 'jobs' | 'runs' | 'destinations' | 'restores' };
