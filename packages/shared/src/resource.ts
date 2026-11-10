import { z } from 'zod';
import { HostStatusSchema } from './host-state';

/**
 * Resources beyond SSH: databases, managed database instances and object
 * storage buckets. Each kind is watched by one connector on the server and
 * drawn with its own fixed shape in the city.
 *
 * This file is the wire model (what the browser sees). The server's config
 * model (resources.yaml) lives in apps/server and never reaches the browser,
 * because one config entry can expand into many resources (every RDS
 * instance in a region, every bucket of an account).
 */
export const ResourceKindSchema = z.enum([
  'postgres',
  'mysql',
  'mongodb',
  'redis',
  'mssql',
  'sqlite',
  'rds',
  's3',
]);
export type ResourceKind = z.infer<typeof ResourceKindSchema>;

/** The fixed 3D shape of each kind (see docs/VISUAL_LANGUAGE.md). */
export type ResourceShape = 'drum' | 'prism' | 'caged-drum' | 'warehouse';

export const RESOURCE_SHAPES: Record<ResourceKind, ResourceShape> = {
  postgres: 'drum',
  mysql: 'drum',
  mongodb: 'drum',
  mssql: 'drum',
  sqlite: 'drum',
  redis: 'prism',
  rds: 'caged-drum',
  s3: 'warehouse',
};

/** Short engine tag shown on captions and in the palette. */
export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mongodb: 'MongoDB',
  redis: 'Redis',
  mssql: 'SQL Server',
  sqlite: 'SQLite',
  rds: 'RDS',
  s3: 'S3',
};

/** A resource as shown in the world. Contains no secrets, ever. */
export const ResourceSchema = z.object({
  /** Unique across hosts and resources (they share the layout). */
  id: z.string().min(1),
  name: z.string().min(1),
  kind: ResourceKindSchema,
  /** Engine label, e.g. "PostgreSQL", "MariaDB", "RDS · postgres", "S3 · R2". */
  engine: z.string().min(1),
  district: z.string().min(1),
  tags: z.array(z.string()).default([]),
  /** Where it lives, for display only: "db.internal:5432", a file path, an endpoint. */
  target: z.string(),
  /** The resources.yaml entry this resource came from. */
  sourceId: z.string().min(1),
});
export type Resource = z.infer<typeof ResourceSchema>;

export const MetricUnitSchema = z.enum([
  'percent',
  'bytes',
  'perSec',
  'perHour',
  'count',
  'seconds',
  'ms',
  'bytesPerHour',
  'text',
]);
export type MetricUnit = z.infer<typeof MetricUnitSchema>;

/** One line in the resource's focus HUD. `value: null` means unknown. */
export const ResourceMetricSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  unit: MetricUnitSchema,
  value: z.number().nullable(),
  /** For `unit: 'text'` (role, version, instance class). */
  text: z.string().nullable().default(null),
  /** Shown as "≥ value": the true number is at least this (counting was capped). */
  atLeast: z.boolean().default(false),
});
export type ResourceMetric = z.infer<typeof ResourceMetricSchema>;

/**
 * The few typed numbers the 3D encodings use. Every field is nullable and
 * `null` always means "not known", never zero.
 */
export const ResourceGaugesSchema = z.object({
  /** Queries, transactions or commands per second (pulse speed of drums and prisms). */
  opsPerSec: z.number().nonnegative().nullable(),
  /** CPU percent of a managed instance (pulse speed of RDS). */
  cpuPercent: z.number().min(0).max(100).nullable(),
  /** Client connections; `max` null when the engine does not say (no bands drawn). */
  connections: z
    .object({ used: z.number().nonnegative(), max: z.number().positive().nullable() })
    .nullable(),
  /** Bytes stored; `totalBytes` null when there is no known limit (no ring drawn). */
  storage: z
    .object({ usedBytes: z.number().nonnegative(), totalBytes: z.number().positive().nullable() })
    .nullable(),
  /** Net growth of stored bytes per hour (S3 particles; only growth is drawn). */
  growthBytesPerHour: z.number().nullable(),
});
export type ResourceGauges = z.infer<typeof ResourceGaugesSchema>;

export const EMPTY_GAUGES: ResourceGauges = {
  opsPerSec: null,
  cpuPercent: null,
  connections: null,
  storage: null,
  growthBytesPerHour: null,
};

/** Live state of one resource. Same truth rules as hosts. */
export const ResourceStateSchema = z.object({
  resourceId: z.string().min(1),
  status: HostStatusSchema,
  statusReason: z.string().nullable(),
  lastSeenAt: z.number().int().nullable(),
  stale: z.boolean(),
  /** This resource's poll interval; the client uses it to detect staleness on its own clock. */
  pollIntervalMs: z.number().int().positive(),
  gauges: ResourceGaugesSchema,
  metrics: z.array(ResourceMetricSchema),
  error: z.string().nullable(),
});
export type ResourceState = z.infer<typeof ResourceStateSchema>;

export function createUnknownResourceState(
  resourceId: string,
  pollIntervalMs: number,
): ResourceState {
  return {
    resourceId,
    status: 'unknown',
    statusReason: 'waiting for first poll',
    lastSeenAt: null,
    stale: false,
    pollIntervalMs,
    gauges: EMPTY_GAUGES,
    metrics: [],
    error: null,
  };
}

/** Tunable rules for the `degraded` status of resources. */
export const ResourceThresholdsSchema = z.object({
  /** Polls without data before a resource counts as stale. */
  staleAfterPolls: z.number().int().min(1).default(3),
  /** Connections in use above this percent of the maximum. */
  connectionsDegradedPercent: z.number().min(0).max(100).default(90),
  /** Replica lag above this many seconds. */
  replicationLagDegradedSeconds: z.number().min(0).default(30),
  /** Slow queries seen for this many polls in a row. */
  slowQueryDegradedPolls: z.number().int().min(1).default(3),
  /** Cache hit ratio below this percent (only judged with enough reads in the poll). */
  cacheHitDegradedPercent: z.number().min(0).max(100).default(90),
  /** Used storage above this percent of the limit. */
  storageDegradedPercent: z.number().min(0).max(100).default(90),
  /** Managed instance CPU above this percent for `cpuDegradedPolls` polls. */
  cpuDegradedPercent: z.number().min(0).max(100).default(90),
  cpuDegradedPolls: z.number().int().min(1).default(3),
});
export type ResourceThresholds = z.infer<typeof ResourceThresholdsSchema>;
export const DEFAULT_RESOURCE_THRESHOLDS: ResourceThresholds = ResourceThresholdsSchema.parse({});
