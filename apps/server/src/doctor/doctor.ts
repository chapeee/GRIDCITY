import {
  detectProvider,
  hintOf,
  rankDiagnoses,
  type Diagnosis,
  type DoctorHint,
  type DoctorReport,
  type Fix,
} from '@app/shared';
import { resolveSrv } from 'node:dns/promises';
import type { ResourceConfig } from '../config/resources-file';
import {
  climbLadder,
  runningInContainer,
  type Endpoint,
  type LadderOptions,
  type LadderResult,
} from './ladder';
import { fix as makeFix, matchRules, type RuleContext } from './rules';

/** One real connection attempt with a config; the Doctor's only way to prove a fix. */
export type ConnectionTest = (
  config: ResourceConfig,
) => Promise<{ ok: boolean; error: string | null }>;

export interface DoctorOptions {
  /** The error already seen (skips the first test). */
  error?: string | null;
  test: ConnectionTest;
  /** Try the proposed patches against the real target (default true). */
  verify?: boolean;
  inContainer?: boolean;
  ladder?: LadderOptions;
  /** At most this many verification attempts (each is a real connection). */
  maxAttempts?: number;
  now?: () => number;
}

/**
 * Settings the Doctor may change by itself, and only after proving the
 * change works. Everything else (addresses of other machines, users,
 * grants, firewalls) is a manual step for a person.
 */
export const PATCHABLE_KEYS = new Set([
  'tls',
  'tlsVerify',
  'port',
  'host',
  'authSource',
  'database',
  'region',
  'forcePathStyle',
  'encrypt',
  'trustServerCertificate',
  'insecure',
  'followRedirects',
  'expectStatus',
  'passwordSecret',
  'passwordEnv',
  'passwordFile',
]);

export function applyPatch(config: ResourceConfig, patch: Record<string, unknown>): ResourceConfig {
  const next = { ...config } as Record<string, unknown>;
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE_KEYS.has(key)) continue;
    if (value === undefined || value === null) delete next[key];
    else next[key] = value;
  }
  return next as ResourceConfig;
}

/** Where a config connects, for the ladder. Null when there is no network endpoint (SQLite). */
export async function endpointOf(config: ResourceConfig): Promise<Endpoint | null> {
  switch (config.kind) {
    case 'postgres':
    case 'mysql':
    case 'mssql':
      return { host: config.host, port: config.port, rawTls: false };
    case 'redis':
      return { host: config.host, port: config.port, rawTls: config.tls };
    case 'tcp':
      return { host: config.host, port: config.port, rawTls: config.tls };
    case 'mongodb': {
      const srv = config.url.startsWith('mongodb+srv://');
      const url = new URL(config.url.replace(/^mongodb(\+srv)?:/, 'http:'));
      const first = url.hostname.split(',')[0] ?? url.hostname;
      if (srv) {
        try {
          const [record] = await resolveSrv(`_mongodb._tcp.${first}`);
          if (record) return { host: record.name, port: record.port, rawTls: config.tls !== false };
        } catch {
          return { host: first, port: 27017, rawTls: true };
        }
      }
      return { host: first, port: Number(url.port) || 27017, rawTls: config.tls === true };
    }
    case 'http': {
      const url = new URL(config.url);
      const tls = url.protocol === 'https:';
      return { host: url.hostname, port: Number(url.port) || (tls ? 443 : 80), rawTls: tls };
    }
    case 's3': {
      if (config.endpoint) {
        const url = new URL(config.endpoint);
        const tls = url.protocol === 'https:';
        return { host: url.hostname, port: Number(url.port) || (tls ? 443 : 80), rawTls: tls };
      }
      return { host: `s3.${config.region}.amazonaws.com`, port: 443, rawTls: true };
    }
    case 'rds':
      return { host: `rds.${config.region}.amazonaws.com`, port: 443, rawTls: true };
    case 'loadbalancer':
      return {
        host: `elasticloadbalancing.${config.region}.amazonaws.com`,
        port: 443,
        rawTls: true,
      };
    case 'sqlite':
      return null;
  }
}

/** The host name used for provider detection. */
function hostOf(config: ResourceConfig): string {
  if ('host' in config && typeof config.host === 'string') return config.host;
  if (config.kind === 'mongodb') return config.url;
  if (config.kind === 'http') return config.url;
  if (config.kind === 's3') return config.endpoint ?? '';
  return '';
}

/**
 * Diagnoses one resource: reproduce the failure, climb the ladder, match
 * the rules, then prove or disprove each proposed patch with a real
 * connection. A patch that gets further but hits a new problem is followed
 * one step (TLS on → now the certificate is untrusted → …), so the report
 * ends at a change that really works, or says clearly that a person must act.
 */
export async function diagnoseResource(
  config: ResourceConfig,
  options: DoctorOptions,
): Promise<DoctorReport> {
  const now = options.now ?? Date.now;
  const name = config.name ?? config.id;
  let error = options.error ?? null;
  if (error === null || error === undefined) {
    const first = await options.test(config);
    if (first.ok) {
      return {
        targetId: config.id,
        targetName: name,
        ok: true,
        error: null,
        ladder: [],
        diagnoses: [],
        at: now(),
      };
    }
    error = first.error ?? 'unknown error';
  }

  const endpoint = await endpointOf(config);
  const ladder: LadderResult = endpoint
    ? await climbLadder(endpoint, options.ladder)
    : { steps: [], addresses: [], failedAt: null };
  const context: RuleContext = {
    kind: config.kind,
    config: config as unknown as Record<string, unknown>,
    error,
    ladder: ladder.steps,
    provider: detectProvider(config.kind, hostOf(config)),
    inContainer: options.inContainer ?? runningInContainer(),
    addresses: ladder.addresses,
  };
  let diagnoses = matchRules(context);
  if (diagnoses.length === 0) diagnoses = [unknownDiagnosis(context, ladder)];

  if (options.verify !== false) {
    diagnoses = await verifyFixes(config, diagnoses, context, options);
  }
  return {
    targetId: config.id,
    targetName: name,
    ok: false,
    error,
    ladder: ladder.steps,
    diagnoses: rankDiagnoses(diagnoses),
    at: now(),
  };
}

async function verifyFixes(
  config: ResourceConfig,
  diagnoses: Diagnosis[],
  context: RuleContext,
  options: DoctorOptions,
): Promise<Diagnosis[]> {
  let attempts = options.maxAttempts ?? 6;
  const tried = new Map<string, { ok: boolean; error: string | null }>();
  const attempt = async (patch: Record<string, unknown>) => {
    const key = JSON.stringify(Object.entries(patch).sort());
    const cached = tried.get(key);
    if (cached) return cached;
    if (attempts <= 0) return null;
    attempts -= 1;
    const result = await options.test(applyPatch(config, patch)).catch((reason: Error) => ({
      ok: false,
      error: reason.message,
    }));
    tried.set(key, result);
    return result;
  };

  const out: Diagnosis[] = [];
  for (const diagnosis of diagnoses) {
    const fixes: Fix[] = [];
    for (const candidate of diagnosis.fixes) {
      if (candidate.kind !== 'patch' || !candidate.patch) {
        fixes.push(candidate);
        continue;
      }
      const result = await attempt(candidate.patch);
      if (!result) {
        fixes.push(candidate);
        continue;
      }
      if (result.ok) {
        fixes.push({ ...candidate, verified: 'works', verifyNote: 'connected with this change' });
        continue;
      }
      fixes.push({ ...candidate, verified: 'fails', verifyNote: result.error });
      // One step further: what does the server say now, and does that have a patch?
      const next = matchRules({
        ...context,
        error: result.error ?? '',
        config: { ...context.config, ...candidate.patch },
      });
      for (const follow of next) {
        for (const followFix of follow.fixes) {
          if (followFix.kind !== 'patch' || !followFix.patch) continue;
          const combined = { ...candidate.patch, ...followFix.patch };
          const second = await attempt(combined);
          if (!second) continue;
          fixes.push(
            makeFix({
              label: `${candidate.label}, and ${lowerFirst(followFix.label)}`,
              patch: combined,
              risk:
                candidate.risk === 'lower-security' || followFix.risk === 'lower-security'
                  ? 'lower-security'
                  : 'safe',
              steps: [...candidate.steps, `Then: ${follow.title}.`, ...followFix.steps],
              verified: second.ok ? 'works' : 'fails',
              verifyNote: second.ok ? 'connected with these changes' : second.error,
            }),
          );
        }
        // Manual follow-ups (paste the CA) stay visible too.
        for (const followFix of follow.fixes) {
          if (followFix.kind === 'manual' && !fixes.some((f) => f.label === followFix.label))
            fixes.push(followFix);
        }
      }
    }
    out.push({ ...diagnosis, fixes });
  }
  return out;
}

function unknownDiagnosis(context: RuleContext, ladder: LadderResult): Diagnosis {
  const failed = ladder.steps.find((step) => step.status === 'failed');
  return {
    id: 'unknown',
    title: failed
      ? `Stopped at ${failed.step.toUpperCase()}: ${failed.detail}`
      : 'The network path works; the service refused for another reason',
    explanation: failed
      ? 'The connection ladder shows where it breaks; the rungs above it worked.'
      : 'DNS and the port work, so the problem is in the service itself (login, permissions or protocol). The exact message is below.',
    confidence: 'possible',
    evidence: [`error: "${context.error.slice(0, 200)}"`],
    fixes: [],
  };
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** The top diagnosis from the error text alone: no ladder, no attempts. For live state. */
export function quickHint(config: ResourceConfig, error: string): DoctorHint | null {
  return hintOf(
    matchRules({
      kind: config.kind,
      config: config as unknown as Record<string, unknown>,
      error,
      ladder: [],
      provider: detectProvider(config.kind, hostOf(config)),
      inContainer: runningInContainer(),
      addresses: [],
    }),
  );
}
