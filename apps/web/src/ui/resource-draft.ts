import type { ResourceKind } from '@app/shared';
import type { ResourceDraft } from '../data/resource-api';

/**
 * The "Connect a database or bucket" form: which fields each kind asks for,
 * and how the typed values become a resources.yaml entry. Pure, so it is
 * unit tested. Secrets are never part of a draft: only where they live.
 */
export type FieldType = 'text' | 'number' | 'checkbox' | 'list';

export interface FieldSpec {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  /** Pre-filled value (numbers as text). Checkbox fields: the default state. */
  initial?: string | boolean;
  required?: boolean;
  help?: string;
  /** Shown under "Advanced" (environment variables, profiles): most people never need it. */
  advanced?: boolean;
}

export interface KindSpec {
  kind: ResourceKind;
  label: string;
  /** Short line under the tile. */
  blurb: string;
  fields: FieldSpec[];
  /** Asks for a password (saved encrypted; env var or file under Advanced). */
  password: boolean;
  /** Asks for an access key pair (S3, RDS, load balancers), saved encrypted. */
  keys?: boolean;
  /** Read-only grant to recommend. */
  grant?: string;
}

const host: FieldSpec = {
  key: 'host',
  label: 'Host',
  type: 'text',
  placeholder: 'db.internal or 10.0.0.5',
  required: true,
};
const port = (initial: number): FieldSpec => ({
  key: 'port',
  label: 'Port',
  type: 'number',
  initial: String(initial),
});
const user = (required = true): FieldSpec => ({
  key: 'user',
  label: 'User',
  type: 'text',
  placeholder: 'monitor',
  required,
});
const tls: FieldSpec = { key: 'tls', label: 'Use TLS', type: 'checkbox', initial: false };

export const RESOURCE_KINDS: KindSpec[] = [
  {
    kind: 'postgres',
    label: 'PostgreSQL',
    blurb: 'connections, transactions/s, slow queries, replica lag',
    fields: [
      host,
      port(5432),
      user(),
      { key: 'database', label: 'Database', type: 'text', initial: 'postgres' },
      tls,
    ],
    password: true,
    grant: 'CREATE ROLE monitor LOGIN PASSWORD …; GRANT pg_monitor TO monitor;',
  },
  {
    kind: 'mysql',
    label: 'MySQL / MariaDB',
    blurb: 'connections, queries/s, slow queries, buffer pool, lag',
    fields: [
      host,
      port(3306),
      user(),
      { key: 'database', label: 'Database', type: 'text', placeholder: 'optional' },
      tls,
    ],
    password: true,
    grant:
      "CREATE USER 'monitor'@'%' IDENTIFIED BY …; GRANT PROCESS, REPLICATION CLIENT ON *.* TO 'monitor'@'%';",
  },
  {
    kind: 'mongodb',
    label: 'MongoDB',
    blurb: 'connections, operations/s, cache, replica lag',
    fields: [
      {
        key: 'url',
        label: 'URL',
        type: 'text',
        placeholder: 'mongodb://monitor@10.0.0.6:27017/?authSource=admin',
        required: true,
        help: 'No password in the URL: choose where it lives below.',
      },
      user(false),
    ],
    password: true,
    grant:
      "db.createUser({ user: 'monitor', pwd: …, roles: [{ role: 'clusterMonitor', db: 'admin' }] })",
  },
  {
    kind: 'redis',
    label: 'Redis / Valkey',
    blurb: 'clients, commands/s, memory, hit ratio',
    fields: [host, port(6379), user(false), tls],
    password: true,
    grant: 'ACL SETUSER monitor on >… -@all +info +slowlog|get +ping',
  },
  {
    kind: 'mssql',
    label: 'SQL Server',
    blurb: 'connections, batches/s, buffer cache, slow requests',
    fields: [
      host,
      port(1433),
      user(),
      { key: 'database', label: 'Database', type: 'text', initial: 'master' },
      { key: 'encrypt', label: 'Encrypt', type: 'checkbox', initial: true },
      {
        key: 'trustServerCertificate',
        label: 'Trust server certificate',
        type: 'checkbox',
        initial: false,
      },
    ],
    password: true,
    grant: 'GRANT VIEW SERVER STATE TO monitor;',
  },
  {
    kind: 'sqlite',
    label: 'SQLite',
    blurb: 'a database file on this computer, opened read-only',
    fields: [
      { key: 'path', label: 'File', type: 'text', placeholder: '/srv/app/data.db', required: true },
    ],
    password: false,
  },
  {
    kind: 'rds',
    label: 'AWS RDS',
    blurb: 'every instance in a region, from CloudWatch',
    fields: [
      { key: 'region', label: 'Region', type: 'text', placeholder: 'eu-west-1', required: true },
      {
        key: 'profile',
        label: 'AWS profile',
        type: 'text',
        placeholder: 'from ~/.aws on this machine',
        advanced: true,
      },
      {
        key: 'instances',
        label: 'Only these instances',
        type: 'list',
        placeholder: 'optional, comma separated',
      },
    ],
    password: false,
    keys: true,
    grant: 'IAM: rds:DescribeDBInstances, cloudwatch:GetMetricData',
  },
  {
    kind: 's3',
    label: 'S3 / Spaces / MinIO / R2',
    blurb: 'buckets: objects, size, growth, reachability',
    fields: [
      {
        key: 'endpoint',
        label: 'Endpoint',
        type: 'text',
        placeholder: 'https://blr1.digitaloceanspaces.com',
      },
      { key: 'region', label: 'Region', type: 'text', initial: 'us-east-1' },
      {
        key: 'buckets',
        label: 'Only these buckets',
        type: 'list',
        placeholder: 'optional, comma separated',
      },
      {
        key: 'accessKeyIdEnv',
        label: 'Access key variable',
        type: 'text',
        placeholder: 'SPACES_KEY',
        advanced: true,
      },
      {
        key: 'secretAccessKeyEnv',
        label: 'Secret key variable',
        type: 'text',
        placeholder: 'SPACES_SECRET',
        advanced: true,
      },
      {
        key: 'profile',
        label: 'AWS profile',
        type: 'text',
        placeholder: 'from ~/.aws on this machine',
        advanced: true,
      },
    ],
    password: false,
    keys: true,
    grant: 'List-only keys: s3:ListAllMyBuckets, s3:ListBucket',
  },

  {
    kind: 'http',
    label: 'HTTP endpoint',
    blurb: 'status, latency, certificate expiry, checked from this machine',
    fields: [
      {
        key: 'url',
        label: 'URL',
        type: 'text',
        placeholder: 'https://shop.example.com/healthz',
        required: true,
      },
      { key: 'expectStatus', label: 'Expect status', type: 'number', placeholder: 'any 2xx/3xx' },
      { key: 'expectBody', label: 'Body contains', type: 'text', placeholder: 'optional' },
      { key: 'followRedirects', label: 'Follow redirects', type: 'checkbox', initial: true },
      { key: 'insecure', label: 'Accept untrusted certificates', type: 'checkbox', initial: false },
    ],
    password: false,
  },
  {
    kind: 'tcp',
    label: 'TCP port',
    blurb: 'is the port open, how fast, optional TLS certificate and banner',
    fields: [
      { ...host, placeholder: 'mail.example.com' },
      port(443),
      { key: 'tls', label: 'TLS handshake', type: 'checkbox', initial: false },
      {
        key: 'expectBanner',
        label: 'Banner contains',
        type: 'text',
        placeholder: 'optional, e.g. SSH-2.0',
      },
    ],
    password: false,
  },
  {
    kind: 'loadbalancer',
    label: 'AWS load balancer',
    blurb: 'ALB / NLB state, target health and CloudWatch traffic',
    fields: [
      { key: 'region', label: 'Region', type: 'text', placeholder: 'ap-south-1', required: true },
      {
        key: 'profile',
        label: 'AWS profile',
        type: 'text',
        placeholder: 'from ~/.aws on this machine',
        advanced: true,
      },
      {
        key: 'names',
        label: 'Only these names',
        type: 'list',
        placeholder: 'optional, comma separated',
      },
      {
        key: 'dependsOn',
        label: 'Servers behind it',
        type: 'list',
        placeholder: 'host ids, when target IPs cannot be matched',
      },
    ],
    password: false,
    keys: true,
    grant: 'IAM: elasticloadbalancing:Describe*, cloudwatch:GetMetricData',
  },
];

/** S3-compatible providers with their usual endpoint. */
export const S3_PROVIDERS = [
  { id: 'aws', label: 'AWS S3', endpoint: '' },
  {
    id: 'spaces',
    label: 'DigitalOcean Spaces',
    endpoint: 'https://<region>.digitaloceanspaces.com',
  },
  { id: 'minio', label: 'MinIO', endpoint: 'http://<host>:9000' },
  { id: 'r2', label: 'Cloudflare R2', endpoint: 'https://<account-id>.r2.cloudflarestorage.com' },
  { id: 'other', label: 'Other S3-compatible', endpoint: 'https://…' },
] as const;

/** `typed`: the password field in the dialog (saved encrypted). env/file: Advanced. */
export type PasswordSource = 'typed' | 'none' | 'env' | 'file';

export interface DraftInput {
  kind: ResourceKind;
  id: string;
  name: string;
  district: string;
  values: Record<string, string | boolean>;
  passwordSource: PasswordSource;
  passwordRef: string;
  provider?: string;
}

/** "Orders DB (prod)" -> "orders-db-prod": a valid, stable id. */
export function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || ''
  );
}

/** Builds the resources.yaml entry: only values the user set; defaults stay implicit. */
export function buildDraft(input: DraftInput): ResourceDraft {
  const spec = RESOURCE_KINDS.find((entry) => entry.kind === input.kind);
  if (!spec) throw new Error(`unknown kind ${input.kind}`);
  const draft: ResourceDraft = { kind: input.kind, id: input.id.trim() };
  if (input.name.trim() && input.name.trim() !== draft.id) draft.name = input.name.trim();
  if (input.district.trim()) draft.district = input.district.trim();
  if (input.kind === 's3' && input.provider) draft.provider = input.provider;

  for (const field of spec.fields) {
    const value = input.values[field.key];
    if (field.type === 'checkbox') {
      if (typeof value === 'boolean' && value !== field.initial) draft[field.key] = value;
      continue;
    }
    const text = typeof value === 'string' ? value.trim() : '';
    if (text === '') continue;
    if (field.type === 'number') {
      const number = Number(text);
      if (Number.isFinite(number) && String(number) !== field.initial) draft[field.key] = number;
    } else if (field.type === 'list') {
      const items = text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      if (items.length > 0) draft[field.key] = items;
    } else if (text !== field.initial) {
      draft[field.key] = text;
    }
  }

  if (spec.password && input.passwordRef.trim()) {
    if (input.passwordSource === 'env') draft.passwordEnv = input.passwordRef.trim();
    if (input.passwordSource === 'file') draft.passwordFile = input.passwordRef.trim();
  }
  return draft;
}

/** True when a host field points at this computer (inside Docker that is the container). */
export function pointsAtLocalhost(values: Record<string, string | boolean>): boolean {
  const candidates = [values.host, values.url, values.endpoint].filter(
    (v): v is string => typeof v === 'string',
  );
  return candidates.some((value) =>
    /(^|\/\/|@)(localhost|127\.0\.0\.1|\[::1\])([:/]|$)/i.test(value.trim()),
  );
}
