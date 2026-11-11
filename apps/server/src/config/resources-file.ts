import { ResourceThresholdsSchema, type ResourceThresholds } from '@app/shared';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseDocument } from 'yaml';
import { z } from 'zod';

/**
 * resources.yaml: databases, RDS regions and object storage accounts.
 *
 * Secrets are never written here. A password is named, not stored:
 * `passwordEnv` (an environment variable) or `passwordFile` (a file you
 * point to, read at connect time). AWS credentials come from the standard
 * AWS chain or a named `profile`. A `password:` key, or a URL with a
 * password in it, is refused with an explanation.
 */

const idSchema = z
  .string({ error: 'id must be text such as "orders-db" (a-z, 0-9, "-" and "_")' })
  .min(1)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'id may only contain a-z, 0-9, "-" and "_"');

const envNameSchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'must be an environment variable name');

const baseFields = {
  id: idSchema,
  name: z.string().min(1).optional(),
  district: z.string().min(1).optional(),
  tags: z.array(z.string().min(1)).default([]),
  /** Poll interval in ms; each kind has its own default. */
  pollIntervalMs: z.number().int().min(1000).optional(),
  /** Overrides of the file-wide resource thresholds. */
  thresholds: ResourceThresholdsSchema.partial().optional(),
  /** Ids of servers or resources this one uses (drawn as links in the city). */
  dependsOn: z.array(z.string().min(1)).default([]),
};

/** Password by reference only. */
const secretFields = {
  /** Name of an environment variable holding the password. */
  passwordEnv: envNameSchema.optional(),
  /** Path of a file holding the password (first line). */
  passwordFile: z.string().min(1).optional(),
};

const hostPort = (defaultPort: number) => ({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(defaultPort),
});

/** Queries running longer than this count as slow. */
const slowQueryMs = z.number().int().min(10).default(1000);

const PostgresSchema = z.strictObject({
  kind: z.literal('postgres'),
  ...baseFields,
  ...hostPort(5432),
  ...secretFields,
  user: z.string().min(1),
  database: z.string().min(1).default('postgres'),
  tls: z.boolean().default(false),
  slowQueryMs,
});

const MysqlSchema = z.strictObject({
  kind: z.literal('mysql'),
  ...baseFields,
  ...hostPort(3306),
  ...secretFields,
  user: z.string().min(1),
  database: z.string().min(1).optional(),
  tls: z.boolean().default(false),
  slowQueryMs,
});

const MongoSchema = z.strictObject({
  kind: z.literal('mongodb'),
  ...baseFields,
  ...secretFields,
  /** mongodb:// or mongodb+srv:// URL without a password. */
  url: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
  user: z.string().min(1).optional(),
  authSource: z.string().min(1).optional(),
  slowQueryMs,
});

const RedisSchema = z.strictObject({
  kind: z.literal('redis'),
  ...baseFields,
  ...hostPort(6379),
  ...secretFields,
  user: z.string().min(1).optional(),
  tls: z.boolean().default(false),
});

const MssqlSchema = z.strictObject({
  kind: z.literal('mssql'),
  ...baseFields,
  ...hostPort(1433),
  ...secretFields,
  user: z.string().min(1),
  database: z.string().min(1).default('master'),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(false),
  slowQueryMs,
});

const SqliteSchema = z.strictObject({
  kind: z.literal('sqlite'),
  ...baseFields,
  /** Database file; opened read-only, never created. */
  path: z.string().min(1),
});

const RdsSchema = z.strictObject({
  kind: z.literal('rds'),
  ...baseFields,
  region: z.string().min(1),
  /** Named profile from ~/.aws; otherwise the standard AWS credential chain. */
  profile: z.string().min(1).optional(),
  /** DB instance identifiers to watch; all instances in the region when omitted. */
  instances: z.array(z.string().min(1)).optional(),
  /** Custom API endpoint (tests, VPC endpoints). */
  endpoint: z.url().optional(),
});

export const S3_PROVIDERS = ['aws', 'spaces', 'minio', 'r2', 'other'] as const;

const S3Schema = z.strictObject({
  kind: z.literal('s3'),
  ...baseFields,
  provider: z.enum(S3_PROVIDERS).default('aws'),
  /** Custom endpoint for Spaces, MinIO, R2 or any S3-compatible service. */
  endpoint: z.url().optional(),
  region: z.string().min(1).default('us-east-1'),
  profile: z.string().min(1).optional(),
  /** Environment variables holding the access key pair (for non-AWS providers). */
  accessKeyIdEnv: envNameSchema.optional(),
  secretAccessKeyEnv: envNameSchema.optional(),
  /** Buckets to watch; all buckets the credentials can list when omitted. */
  buckets: z.array(z.string().min(1)).optional(),
  /** Stop counting after this many objects per bucket (shown as "≥ N"). */
  maxObjects: z.number().int().min(1).default(100_000),
  forcePathStyle: z.boolean().optional(),
});

/** An HTTP(S) endpoint checked from this machine: status, latency, certificate. */
const HttpSchema = z.strictObject({
  kind: z.literal('http'),
  ...baseFields,
  url: z
    .string()
    .regex(/^https?:\/\//, 'must start with http:// or https://')
    .refine((value) => !/\/\/[^/@\s]*:[^/@\s]*@/.test(value), 'no password in the URL'),
  method: z.enum(['GET', 'HEAD']).default('GET'),
  /** Accept only this status; any 2xx or 3xx otherwise. */
  expectStatus: z.number().int().min(100).max(599).optional(),
  /** The body must contain this text (GET only). */
  expectBody: z.string().min(1).max(200).optional(),
  /** Follow redirects (up to 5). */
  followRedirects: z.boolean().default(true),
  /** Accept self-signed or otherwise untrusted certificates (still reports expiry). */
  insecure: z.boolean().default(false),
  timeoutMs: z.number().int().min(500).max(60_000).default(10_000),
});

/** A TCP port checked from this machine: open or not, connect time, optional TLS. */
const TcpSchema = z.strictObject({
  kind: z.literal('tcp'),
  ...baseFields,
  ...hostPort(443),
  /** Do a TLS handshake after connecting and report the certificate. */
  tls: z.boolean().default(false),
  /** The first line the server sends must contain this (SSH, SMTP, Redis banners). */
  expectBanner: z.string().min(1).max(200).optional(),
  timeoutMs: z.number().int().min(500).max(60_000).default(5_000),
});

export const LOAD_BALANCER_PROVIDERS = ['aws'] as const;

/** AWS Application / Network Load Balancers: state, target health and CloudWatch traffic. */
const LoadBalancerSchema = z.strictObject({
  kind: z.literal('loadbalancer'),
  ...baseFields,
  provider: z.enum(LOAD_BALANCER_PROVIDERS).default('aws'),
  region: z.string().min(1),
  profile: z.string().min(1).optional(),
  /** Load balancer names to watch; all in the region when omitted. */
  names: z.array(z.string().min(1)).optional(),
  endpoint: z.url().optional(),
});

export const ResourceConfigSchema = z.discriminatedUnion(
  'kind',
  [
    PostgresSchema,
    MysqlSchema,
    MongoSchema,
    RedisSchema,
    MssqlSchema,
    SqliteSchema,
    RdsSchema,
    S3Schema,
    HttpSchema,
    TcpSchema,
    LoadBalancerSchema,
  ],
  { error: (issue) => describeBadKind(issue.input) },
);
export type ResourceConfig = z.infer<typeof ResourceConfigSchema>;
export type ResourceConfigOf<K extends ResourceConfig['kind']> = Extract<
  ResourceConfig,
  { kind: K }
>;

function describeBadKind(input: unknown): string {
  const kind =
    typeof input === 'object' && input !== null && 'kind' in input
      ? String((input as { kind: unknown }).kind)
      : undefined;
  return `kind must be one of postgres, mysql, mongodb, redis, mssql, sqlite, rds, s3, http, tcp, loadbalancer${kind ? ` (got "${kind}")` : ''}`;
}

/** Default poll interval per kind: CloudWatch reports per minute, listing buckets is expensive. */
export const DEFAULT_POLL_INTERVAL_MS: Record<ResourceConfig['kind'], number> = {
  postgres: 10_000,
  mysql: 10_000,
  mongodb: 10_000,
  redis: 10_000,
  mssql: 10_000,
  sqlite: 10_000,
  rds: 60_000,
  s3: 300_000,
  http: 30_000,
  tcp: 30_000,
  loadbalancer: 60_000,
};

export const ResourcesFileSchema = z
  .object({
    thresholds: ResourceThresholdsSchema.prefault({}),
    resources: z.array(z.unknown()).prefault([]),
  })
  .transform((file, context) => {
    const resources: ResourceConfig[] = [];
    const seen = new Map<string, number>();
    file.resources.forEach((raw, index) => {
      const secretProblem = findInlineSecret(raw);
      if (secretProblem) {
        context.addIssue({ code: 'custom', path: ['resources', index], message: secretProblem });
        return;
      }
      const parsed = ResourceConfigSchema.safeParse(raw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({ ...issue, path: ['resources', index, ...issue.path] } as never);
        }
        return;
      }
      const first = seen.get(parsed.data.id);
      if (first !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['resources', index, 'id'],
          message: `duplicate id "${parsed.data.id}" (also used by resources[${first}])`,
        });
      }
      seen.set(parsed.data.id, index);
      resources.push(parsed.data);
    });
    return { thresholds: file.thresholds, resources };
  });

/**
 * Refuses secrets written into the file: `password`, `secretAccessKey` and
 * friends, and URLs that carry a password. They would sit in plain text.
 */
export function findInlineSecret(raw: unknown): string | null {
  if (typeof raw !== 'object' || raw === null) return null;
  for (const [key, value] of Object.entries(raw)) {
    if (/^(password|pass|pwd|secret|secretAccessKey|accessKeyId|token|apiKey)$/i.test(key)) {
      return (
        `"${key}" is not allowed: secrets are never stored in resources.yaml. ` +
        'Name an environment variable (passwordEnv / accessKeyIdEnv / secretAccessKeyEnv), ' +
        'point to a file (passwordFile), or use your AWS profile.'
      );
    }
    if (typeof value === 'string' && /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*:[^/@\s]*@/i.test(value)) {
      return (
        `"${key}" contains a password in the URL. Remove it and use passwordEnv or passwordFile ` +
        'instead; the URL may keep the user name.'
      );
    }
  }
  return null;
}

export interface ResourcesConfig {
  resources: ResourceConfig[];
  thresholds: ResourceThresholds;
}

export type ResourcesFileResult =
  { ok: true; config: ResourcesConfig } | { ok: false; errors: string[] };

export const RESOURCES_FILE_TEMPLATE = `# Databases, RDS and object storage shown in the city, next to your servers.
# A running server picks up changes automatically.
#
# Secrets are NEVER written here. Name an environment variable (passwordEnv)
# or a file (passwordFile); AWS uses your normal credential chain or a profile.
# Use read-only users: every connector only reads statistics.
#
# resources:
#   - kind: postgres             # postgres | mysql | mongodb | redis | mssql | sqlite | rds | s3
#     id: orders-db              # stable id: a-z, 0-9, "-" and "_"
#     host: db.internal
#     user: monitor              # GRANT pg_monitor TO monitor;
#     passwordEnv: ORDERS_DB_PASSWORD
#     district: Databases        # optional grouping
#
#   - kind: mysql                # also MariaDB
#     id: shop-db
#     host: 10.0.0.5
#     user: monitor              # GRANT PROCESS, REPLICATION CLIENT ON *.* TO monitor;
#     passwordFile: ~/.secrets/shop-db
#
#   - kind: mongodb
#     id: events
#     url: mongodb://monitor@10.0.0.6:27017/?authSource=admin   # no password in the URL
#     passwordEnv: EVENTS_MONGO_PASSWORD                         # role: clusterMonitor
#
#   - kind: redis
#     id: cache
#     host: 10.0.0.7
#     passwordEnv: REDIS_PASSWORD   # ACL: +info +slowlog|get +ping
#
#   - kind: mssql
#     id: erp
#     host: 10.0.0.8
#     user: monitor              # GRANT VIEW SERVER STATE TO monitor;
#     passwordEnv: ERP_SQL_PASSWORD
#
#   - kind: sqlite
#     id: app-db
#     path: /srv/app/data.db     # opened read-only
#
#   - kind: rds                  # every instance in the region, or list "instances"
#     id: aws-prod
#     region: eu-west-1
#     profile: monitoring        # optional; standard AWS chain otherwise
#
#   - kind: s3                   # aws | spaces | minio | r2 | other
#     id: media
#     provider: spaces
#     endpoint: https://blr1.digitaloceanspaces.com
#     accessKeyIdEnv: SPACES_KEY
#     secretAccessKeyEnv: SPACES_SECRET
#     buckets: [media-uploads]   # optional; all listable buckets otherwise
#
#   - kind: http                 # an endpoint checked from this machine
#     id: shop-health
#     url: https://shop.example.com/healthz
#     expectStatus: 200          # optional; any 2xx/3xx otherwise
#     expectBody: '"ok"'         # optional; the body must contain this
#     district: Edge
#     dependsOn: [shop-lb]       # draws a link to what it really hits
#
#   - kind: tcp                  # a port checked from this machine
#     id: mail-smtp
#     host: mail.example.com
#     port: 587
#     expectBanner: ESMTP        # optional
#
#   - kind: loadbalancer         # AWS ALB/NLB: state, target health, CloudWatch traffic
#     id: shop-lb
#     region: eu-west-1
#     names: [shop-prod]         # optional; every load balancer in the region otherwise
#     dependsOn: [web-01, web-02]  # the servers behind it, when target IPs cannot be matched
#
# thresholds:                    # optional; defaults shown
#   staleAfterPolls: 3
#   connectionsDegradedPercent: 90
#   replicationLagDegradedSeconds: 30
#   slowQueryDegradedPolls: 3
#   cacheHitDegradedPercent: 90
#   storageDegradedPercent: 90
#   cpuDegradedPercent: 90
#   cpuDegradedPolls: 3

resources: []
`;

export function parseResourcesYaml(text: string): ResourcesFileResult {
  const document = parseDocument(text, { prettyErrors: true });
  if (document.errors.length > 0) {
    return { ok: false, errors: document.errors.map((error) => `YAML: ${error.message}`) };
  }
  const result = ResourcesFileSchema.safeParse(document.toJS() ?? {});
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(file)'}: ${issue.message}`,
      ),
    };
  }
  return { ok: true, config: result.data };
}

/** Reads resources.yaml, creating the commented template on first run. */
export async function loadResourcesFile(filePath: string): Promise<ResourcesFileResult> {
  if (!existsSync(filePath)) {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, RESOURCES_FILE_TEMPLATE, { encoding: 'utf8', flag: 'wx' }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      },
    );
  }
  return parseResourcesYaml(await readFile(filePath, 'utf8'));
}
