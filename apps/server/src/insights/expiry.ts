import type { Resource, ResourceState, ThreatSeverity, UpcomingItem } from '@app/shared';
import type { ResourceConfig } from '../config/resources-file';
import type { ThreatDraft } from '../threats/detect';
import type { InsightProducer, ProducerResult } from '../threats/threat-hub';

const DAY = 86_400_000;
/** RDAP answers are cached this long (domain dates change rarely). */
const RDAP_TTL_MS = 12 * 3_600_000;

export interface ExpiryDeps {
  /** Reads a certificate directly (HTTPS and TLS probes), whatever the probe's own result. */
  readCertificate?: (
    host: string,
    port: number,
  ) => Promise<{ daysLeft: number; issuer: string | null } | null>;
  resources(): readonly Resource[];
  states(): readonly ResourceState[];
  configs(): Promise<ReadonlyMap<string, ResourceConfig>>;
  fetch?: typeof fetch;
  cache: {
    getJson<T>(key: string): T | null;
    setJson(key: string, value: unknown, now: number): void;
  };
}

/** 30, 7 and 1 days out: each step alerts once (the severity rises). */
export function expirySeverity(daysLeft: number): ThreatSeverity | null {
  if (daysLeft <= 1) return 'critical';
  if (daysLeft <= 7) return 'high';
  if (daysLeft <= 30) return 'medium';
  return null;
}

export function upcomingStatus(daysLeft: number | null): UpcomingItem['status'] {
  if (daysLeft === null) return 'unknown';
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= 7) return 'urgent';
  if (daysLeft <= 30) return 'soon';
  return 'ok';
}

const describeDays = (days: number) =>
  days < 0
    ? `expired ${-days} day${days === -1 ? '' : 's'} ago`
    : days === 0
      ? 'expires today'
      : `expires in ${days} day${days === 1 ? '' : 's'}`;

/** Two-label public suffixes common enough to matter ("example.co.uk"). */
const SECOND_LEVEL = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'co.in',
  'net.in',
  'org.in',
  'co.jp',
  'com.br',
  'com.mx',
  'co.za',
  'com.sg',
  'com.tr',
  'com.cn',
  'com.hk',
]);

/** The domain a registrar sells for a host name, or null for IPs and local names. */
export function registrableDomain(host: string): string | null {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (/^[\d.]+$/.test(name) || name.includes(':') || !name.includes('.')) return null;
  if (/\.(local|localhost|internal|lan|test|example|invalid|home\.arpa)$/.test(name)) return null;
  const labels = name.split('.');
  const lastTwo = labels.slice(-2).join('.');
  return SECOND_LEVEL.has(lastTwo) && labels.length >= 3 ? labels.slice(-3).join('.') : lastTwo;
}

interface RdapAnswer {
  expiresAt: number | null;
  registrar: string | null;
  error: string | null;
  checkedAt: number;
}

/** IANA's map from top-level domain to its registry's RDAP server. */
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const BOOTSTRAP_TTL_MS = 7 * DAY;
let bootstrap: { at: number; services: [string[], string[]][] } | null = null;

async function rdapBase(domain: string, send: typeof fetch, now: number): Promise<string | null> {
  if (!bootstrap || now - bootstrap.at > BOOTSTRAP_TTL_MS) {
    const response = await send(BOOTSTRAP_URL, { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`IANA bootstrap answered ${response.status}`);
    const body = (await response.json()) as { services: [string[], string[]][] };
    bootstrap = { at: now, services: body.services };
  }
  const tld = domain.split('.').pop()!;
  const service = bootstrap.services.find(([tlds]) => tlds.includes(tld));
  return service?.[1]?.[0] ?? null;
}

/** Forgets the cached IANA map (tests). */
export function resetRdapBootstrap(): void {
  bootstrap = null;
}

/** The expiration date of a domain from RDAP (the registries' public JSON WHOIS). */
export async function lookupDomain(
  domain: string,
  send: typeof fetch,
  now: number,
): Promise<RdapAnswer> {
  try {
    const base = await rdapBase(domain, send, now);
    if (!base) {
      return {
        expiresAt: null,
        registrar: null,
        error: `.${domain.split('.').pop()} has no RDAP service`,
        checkedAt: now,
      };
    }
    const response = await send(
      `${base.replace(/\/+$/, '')}/domain/${encodeURIComponent(domain)}`,
      {
        headers: { accept: 'application/rdap+json, application/json' },
        redirect: 'follow',
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 404)
      return {
        expiresAt: null,
        registrar: null,
        error: 'the registry does not publish this domain over RDAP',
        checkedAt: now,
      };
    if (!response.ok)
      return {
        expiresAt: null,
        registrar: null,
        error: `RDAP answered ${response.status}`,
        checkedAt: now,
      };
    const body = (await response.json()) as {
      events?: { eventAction?: string; eventDate?: string }[];
      entities?: { roles?: string[]; vcardArray?: [string, [string, unknown, string, string][]] }[];
    };
    const expiry = body.events?.find((event) => event.eventAction === 'expiration')?.eventDate;
    const registrarEntity = body.entities?.find((entity) => entity.roles?.includes('registrar'));
    const registrar =
      registrarEntity?.vcardArray?.[1]?.find((field) => field[0] === 'fn')?.[3] ?? null;
    const expiresAt = expiry ? Date.parse(expiry) : NaN;
    return {
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
      registrar: typeof registrar === 'string' ? registrar : null,
      error: Number.isFinite(expiresAt) ? null : 'the registry does not publish an expiry date',
      checkedAt: now,
    };
  } catch (error) {
    return {
      expiresAt: null,
      registrar: null,
      error: `RDAP unreachable: ${(error as Error).message}`,
      checkedAt: now,
    };
  }
}

function tlsEndpoint(config: ResourceConfig): { host: string; port: number } | null {
  if (config.kind === 'http' && config.url.startsWith('https://')) {
    try {
      const url = new URL(config.url);
      return { host: url.hostname, port: Number(url.port) || 443 };
    } catch {
      return null;
    }
  }
  if (config.kind === 'tcp' && config.tls) return { host: config.host, port: config.port };
  return null;
}

function hostOf(config: ResourceConfig): string | null {
  if (config.kind === 'http') {
    try {
      return new URL(config.url).hostname;
    } catch {
      return null;
    }
  }
  if (config.kind === 'tcp') return config.host;
  return null;
}

/**
 * Certificates (from the probes' and load balancers' own readings) and
 * domain registrations (RDAP) that expire: findings at 30, 7 and 1 days,
 * and every date in the Upcoming calendar.
 */
export function createExpiryProducer(deps: ExpiryDeps): InsightProducer {
  const send = deps.fetch ?? ((...args) => globalThis.fetch(...args));
  return {
    name: 'expiry',
    intervalMs: 30 * 60_000,
    async run(now) {
      const results: ProducerResult[] = [];
      const states = new Map(deps.states().map((state) => [state.resourceId, state]));
      const resources = deps.resources();
      const configs = await deps.configs();

      // Certificates. HTTPS and TLS probes: a fresh handshake, so an expired certificate (which
      // makes the probe itself fail) is still read. Others (load balancers): their own reading.
      for (const resource of resources) {
        const config = configs.get(resource.sourceId);
        const endpoint = config ? tlsEndpoint(config) : null;
        let days: number | null;
        let issuer: string | null;
        if (endpoint && deps.readCertificate) {
          const certificate = await deps
            .readCertificate(endpoint.host, endpoint.port)
            .catch(() => null);
          days = certificate ? Math.floor(certificate.daysLeft) : null;
          issuer = certificate?.issuer ?? null;
        } else {
          const metric = states.get(resource.id)?.metrics.find((m) => m.key === 'certDays');
          if (!metric) continue;
          days = typeof metric.value === 'number' ? Math.floor(metric.value) : null;
          issuer = states.get(resource.id)?.metrics.find((m) => m.key === 'issuer')?.text ?? null;
        }
        const result: ProducerResult = {
          targetId: resource.id,
          targetName: resource.name,
          drafts: [],
          checkedScopes: days === null ? [] : ['certificate'],
          coverage: [
            {
              name: 'Certificate',
              ok: days !== null,
              note: days === null ? 'could not read the certificate' : null,
            },
          ],
          upcoming: [
            {
              targetId: resource.id,
              kind: 'certificate',
              label: resource.target || resource.name,
              at: days === null ? null : now + days * DAY,
              status: upcomingStatus(days),
              detail:
                days === null
                  ? 'certificate could not be read'
                  : `TLS certificate ${describeDays(days)}${issuer ? ` (${issuer})` : ''}`,
            },
          ],
        };
        const severity = days === null ? null : expirySeverity(days);
        if (days !== null && severity) {
          result.drafts.push(
            draft({
              key: 'certificate',
              scope: 'certificate',
              category: 'certificate',
              severity,
              title: `Certificate for ${resource.name} ${describeDays(days)}`,
              detail: `The TLS certificate served by ${resource.target || resource.name} ${describeDays(days)}${issuer ? `; issued by ${issuer}` : ''}. Visitors and clients will get errors once it expires.`,
              advice:
                'Renew it (certbot renew, your CA or cloud console) and check that automatic renewal runs.',
              now,
            }),
          );
        }
        results.push(result);
      }

      // Domains: one lookup per registrable domain, attached to every probe that uses it.
      const byDomain = new Map<string, Resource[]>();
      for (const resource of resources) {
        const config = configs.get(resource.sourceId);
        const host = config ? hostOf(config) : null;
        const domain = host ? registrableDomain(host) : null;
        if (domain) byDomain.set(domain, [...(byDomain.get(domain) ?? []), resource]);
      }
      for (const [domain, users] of byDomain) {
        let answer = deps.cache.getJson<RdapAnswer>(`rdap:${domain}`);
        if (!answer || now - answer.checkedAt > RDAP_TTL_MS) {
          answer = await lookupDomain(domain, send, now);
          deps.cache.setJson(`rdap:${domain}`, answer, now);
        }
        const days = answer.expiresAt === null ? null : Math.floor((answer.expiresAt - now) / DAY);
        const owner = users[0]!;
        const severity = days === null ? null : expirySeverity(days);
        results.push({
          targetId: owner.id,
          targetName: owner.name,
          drafts:
            days !== null && severity
              ? [
                  draft({
                    key: `domain:${domain}`,
                    scope: 'domain',
                    category: 'domain',
                    severity,
                    title: `Domain ${domain} ${describeDays(days)}`,
                    detail: `The registration of ${domain}${answer.registrar ? ` at ${answer.registrar}` : ''} ${describeDays(days)}. When it lapses, ${users.map((u) => u.name).join(', ')} and every other site and mail on it stop working.`,
                    advice:
                      'Renew it at your registrar and turn on auto-renew with a payment method that will not expire.',
                    now,
                  }),
                ]
              : [],
          checkedScopes: days === null ? [] : ['domain'],
          coverage: [{ name: 'Domain expiry', ok: days !== null, note: answer.error }],
          upcoming: [
            {
              targetId: owner.id,
              kind: 'domain',
              label: domain,
              at: answer.expiresAt,
              status: upcomingStatus(days),
              detail:
                days === null
                  ? (answer.error ?? 'expiry unknown')
                  : `domain registration ${describeDays(days)}${answer.registrar ? ` (${answer.registrar})` : ''}`,
            },
          ],
        });
      }
      return results;
    },
  };
}

function draft(input: {
  key: string;
  scope: string;
  category: ThreatDraft['category'];
  severity: ThreatSeverity;
  title: string;
  detail: string;
  advice: string;
  now: number;
}): ThreatDraft {
  return {
    key: input.key,
    scope: input.scope,
    source: 'builtin',
    severity: input.severity,
    category: input.category,
    title: input.title,
    detail: input.detail,
    advice: input.advice,
    attackerIp: null,
    count: 1,
    firstSeen: input.now,
    lastSeen: input.now,
    blocked: null,
  };
}

export { draft as insightDraft };
