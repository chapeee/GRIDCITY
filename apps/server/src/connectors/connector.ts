import {
  EMPTY_GAUGES,
  RESOURCE_KIND_LABELS,
  type Resource,
  type ResourceGauges,
  type ResourceHealthSample,
  type ResourceMetric,
} from '@app/shared';
import { readFile } from 'node:fs/promises';
import { expandHome } from '../config/app-paths';
import { DEFAULT_POLL_INTERVAL_MS, type ResourceConfig } from '../config/resources-file';

/**
 * The common connector interface. Adding a new kind of resource means
 * writing one file that returns a {@link Connector}; polling, status rules,
 * staleness, history, audit and the city all work from what it reports.
 *
 * Rules every connector follows:
 * - read only: statistics views and commands, never writes;
 * - secrets by reference: passwords come from {@link readPassword} at
 *   connect time and are never logged, returned or kept beyond the driver;
 * - truth first: anything the engine (or the user's grants) does not show
 *   is `null`, never zero.
 */
export interface Connector {
  readonly config: ResourceConfig;
  /** Resources this entry currently stands for (one database, or every discovered instance/bucket). */
  resources(): Resource[];
  /** One round of measurements. Throwing means every resource of this entry is unreachable. */
  poll(): Promise<PollOutcome[]>;
  close(): Promise<void>;
  /** Addresses the resources talk to (load balancer targets), from the last poll. */
  peers?(): ResourcePeer[];
}

export type PollOutcome =
  | {
      resourceId: string;
      ok: true;
      sample: ResourceHealthSample;
      metrics: ResourceMetric[];
      /** When the data was true (CloudWatch datapoints lag); defaults to now. */
      observedAt?: number;
    }
  | { resourceId: string; ok: false; error: string };

export interface ConnectorContext {
  env: NodeJS.ProcessEnv;
  /** Credentials typed in the app (encrypted vault); absent in tests that do not need it. */
  secrets?: { get(id: string): string | undefined };
  homeDir: string;
  /** Application name sent to databases that record one (pg, mssql). */
  appName: string;
  now(): number;
}

export function pollIntervalOf(config: ResourceConfig): number {
  return config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS[config.kind];
}

/** The wire resource for a connector that watches exactly one thing. */
export function singleResource(config: ResourceConfig, engine: string, target: string): Resource {
  return {
    id: config.id,
    name: config.name ?? config.id,
    kind: config.kind,
    engine,
    district: config.district ?? 'Databases',
    tags: config.tags,
    target,
    sourceId: config.id,
    dependsOn: config.dependsOn,
  };
}

/**
 * An address a resource is known to talk to (a load balancer's targets),
 * for the topology. Matched against host addresses and resource targets;
 * never shown as a link when nothing matches.
 */
export interface ResourcePeer {
  resourceId: string;
  /** IP or hostname, or an instance id for AWS instance targets. */
  address: string;
  port: number | null;
  /** "healthy", "unhealthy", "draining"… */
  state: string;
}

export function defaultEngine(config: ResourceConfig): string {
  return RESOURCE_KIND_LABELS[config.kind];
}

/**
 * Reads a password by reference. Returns undefined when none is configured.
 * The value lives only in the caller's memory and the driver's.
 */
export async function readPassword(
  config: { passwordSecret?: string; passwordEnv?: string; passwordFile?: string },
  context: Pick<ConnectorContext, 'env' | 'homeDir' | 'secrets'>,
): Promise<string | undefined> {
  if (config.passwordSecret) {
    const value = context.secrets?.get(config.passwordSecret);
    if (value === undefined) {
      throw new Error('the saved password is missing: enter it again with Edit');
    }
    return value;
  }
  if (config.passwordEnv) {
    const value = context.env[config.passwordEnv];
    if (value === undefined || value === '') {
      throw new Error(`environment variable ${config.passwordEnv} is not set`);
    }
    return value;
  }
  if (config.passwordFile) {
    const path = expandHome(config.passwordFile, context.homeDir);
    try {
      return (await readFile(path, 'utf8')).split(/\r?\n/)[0] ?? '';
    } catch (error) {
      throw new Error(
        `cannot read passwordFile ${config.passwordFile} (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
        {
          cause: error,
        },
      );
    }
  }
  return undefined;
}

/**
 * Removes secrets from a message before it is logged, audited or shown:
 * every known secret value, passwords inside URLs and `password=` pairs.
 */
export function redactSecrets(
  message: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  let result = message;
  for (const secret of secrets) {
    if (secret && secret.length >= 3) result = result.split(secret).join('***');
  }
  return result
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:)[^/@\s]*@/gi, '$1***@')
    .replace(/\b(password|pwd|secret|token)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;,&]+)/gi, '$1$2***');
}

export function errorMessage(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return errorMessage(error.errors[0]);
  }
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/**
 * Turns cumulative counters (queries, hits) into per-second rates and
 * per-poll deltas. The first poll and counter resets (server restart) give
 * null, never an invented rate.
 */
export class CounterTracker {
  private readonly previous = new Map<string, { value: number; at: number }>();
  private readonly current = new Map<string, { value: number; at: number }>();

  /** Records a counter and returns the change since the last poll (null if unknown). */
  delta(key: string, value: number | null, at: number): number | null {
    if (value === null || !Number.isFinite(value)) {
      this.current.delete(key);
      return null;
    }
    this.current.set(key, { value, at });
    const before = this.previous.get(key);
    if (!before || value < before.value) return null;
    return value - before.value;
  }

  /** Change per second since the last poll. */
  rate(key: string, value: number | null, at: number): number | null {
    const before = this.previous.get(key);
    const change = this.delta(key, value, at);
    if (change === null || !before || at <= before.at) return null;
    return change / ((at - before.at) / 1000);
  }

  /** Call once per successful poll after all counters were recorded. */
  commit(): void {
    for (const [key, entry] of this.current) this.previous.set(key, entry);
    this.current.clear();
  }

  reset(): void {
    this.previous.clear();
    this.current.clear();
  }
}

/** Hit percent from per-poll deltas, or null with too few reads to judge. */
export function hitPercent(
  hits: number | null,
  misses: number | null,
  minimumReads = 100,
): number | null {
  if (hits === null || misses === null) return null;
  const total = hits + misses;
  if (total < minimumReads) return null;
  return (hits / total) * 100;
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function metric(
  key: string,
  label: string,
  unit: ResourceMetric['unit'],
  value: number | null,
  atLeast = false,
): ResourceMetric {
  return { key, label, unit, value, text: null, atLeast };
}

export function textMetric(key: string, label: string, text: string | null): ResourceMetric {
  return { key, label, unit: 'text', value: null, text, atLeast: false };
}

export function healthSample(
  gauges: Partial<ResourceGauges>,
  rest: Partial<Omit<ResourceHealthSample, 'gauges'>> = {},
): ResourceHealthSample {
  return {
    gauges: { ...EMPTY_GAUGES, ...gauges },
    replicationLagSeconds: rest.replicationLagSeconds ?? null,
    slowQueries: rest.slowQueries ?? null,
    cacheHitPercent: rest.cacheHitPercent ?? null,
    warnings: rest.warnings ?? [],
  };
}

/** Rejects after `ms`, so a hanging driver call can never freeze the poller. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs a query that needs an extra grant; a permission error just means "not visible" (null). */
export async function optional<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

/**
 * AWS keys for S3, RDS and load balancers: a pair typed in the app (vault),
 * or (S3) a pair named by environment variables; otherwise undefined and the
 * SDK uses the standard chain (environment, ~/.aws, SSO, instance role).
 */
export function awsCredentials(
  config: {
    accessKeyIdSecret?: string;
    secretAccessKeySecret?: string;
    accessKeyIdEnv?: string;
    secretAccessKeyEnv?: string;
  },
  context: Pick<ConnectorContext, 'env' | 'secrets'>,
): { accessKeyId: string; secretAccessKey: string } | undefined {
  if (config.accessKeyIdSecret && config.secretAccessKeySecret) {
    const accessKeyId = context.secrets?.get(config.accessKeyIdSecret);
    const secretAccessKey = context.secrets?.get(config.secretAccessKeySecret);
    if (accessKeyId && secretAccessKey) return { accessKeyId, secretAccessKey };
    return undefined;
  }
  const accessKeyId = config.accessKeyIdEnv ? context.env[config.accessKeyIdEnv] : undefined;
  const secretAccessKey = config.secretAccessKeyEnv
    ? context.env[config.secretAccessKeyEnv]
    : undefined;
  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : undefined;
}

/**
 * Node TLS options for a database connection: verification on unless the
 * user chose otherwise, with their pasted CA certificate, and the hostname
 * as SNI (managed services route on it).
 */
export function tlsOptions(config: {
  host?: string;
  tls?: boolean;
  tlsVerify?: boolean;
  tlsCa?: string;
}): { rejectUnauthorized: boolean; ca?: string; servername?: string } | undefined {
  if (!config.tls) return undefined;
  return {
    rejectUnauthorized: config.tlsVerify !== false,
    ...(config.tlsCa ? { ca: config.tlsCa } : {}),
    ...(config.host && !/^[\d.:]+$/.test(config.host) ? { servername: config.host } : {}),
  };
}
