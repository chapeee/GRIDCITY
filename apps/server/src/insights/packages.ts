import type { Host, ThreatSeverity } from '@app/shared';
import type { InsightProducer, ProducerResult, SweepRunner } from '../threats/threat-hub';
import { insightDraft } from './expiry';

const OSV = 'https://api.osv.dev/v1';
const DAY = 86_400_000;
/** Vulnerability details are cached this long. */
const DETAIL_TTL_MS = 7 * DAY;
/** At most this many detail lookups per server per round (the rest wait for the next one). */
const MAX_DETAILS = 250;

/** OS release and installed packages, read-only. Source package names are what Debian's OSV data uses. */
export const PACKAGES_SCRIPT = `export LC_ALL=C
. /etc/os-release 2>/dev/null; echo "@@os $ID $VERSION_ID"
if command -v dpkg-query >/dev/null 2>&1; then echo '@@format dpkg'; dpkg-query -W -f='\${source:Package}\\t\${source:Version}\\n' 2>/dev/null
elif command -v rpm >/dev/null 2>&1; then echo '@@format rpm'; rpm -qa --qf '%{NAME}\\t%{VERSION}-%{RELEASE}\\n' 2>/dev/null
elif command -v apk >/dev/null 2>&1; then echo '@@format apk'; apk info -v 2>/dev/null
else echo '@@format none'; fi
echo '@@end'
`;

export interface InstalledPackages {
  /** OSV ecosystem ("Debian:12"), or null when GRIDCITY cannot map this OS. */
  ecosystem: string | null;
  os: string;
  packages: { name: string; version: string }[];
}

/** OSV's name for the OS, from /etc/os-release. */
export function osvEcosystem(id: string, versionId: string): string | null {
  const major = versionId.split('.')[0] ?? '';
  switch (id) {
    case 'debian':
      return major ? `Debian:${major}` : null;
    case 'ubuntu': {
      // LTS releases are April releases of even years (22.04, 24.04).
      const [year, month] = versionId.split('.').map(Number);
      return versionId
        ? `Ubuntu:${versionId}${month === 4 && (year ?? 1) % 2 === 0 ? ':LTS' : ''}`
        : null;
    }
    case 'alpine':
      return versionId ? `Alpine:v${versionId.split('.').slice(0, 2).join('.')}` : null;
    case 'rocky':
      return major ? `Rocky Linux:${major}` : null;
    case 'almalinux':
      return major ? `AlmaLinux:${major}` : null;
    default:
      return null;
  }
}

export function parsePackages(output: string): InstalledPackages | null {
  if (!output.includes('@@end')) return null;
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  const os = (lines.find((l) => l.startsWith('@@os ')) ?? '@@os unknown ').slice(5).trim();
  const [id = '', versionId = ''] = os.split(' ');
  const format = (lines.find((l) => l.startsWith('@@format ')) ?? '@@format none').slice(9).trim();
  const seen = new Set<string>();
  const packages: { name: string; version: string }[] = [];
  for (const line of lines) {
    if (line.startsWith('@@') || !line.trim()) continue;
    let name: string | undefined;
    let version: string | undefined;
    if (format === 'apk') {
      // "busybox-1.36.1-r29": the version starts at the last "-<digit>" before "-r<n>".
      const match = /^(.+?)-(\d[^-]*-r\d+)$/.exec(line.trim());
      name = match?.[1];
      version = match?.[2];
    } else {
      [name, version] = line.trim().split('\t');
    }
    if (!name || !version) continue;
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    packages.push({ name, version });
  }
  return { ecosystem: osvEcosystem(id, versionId), os: os || 'unknown', packages };
}

const CVSS_WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

/** The CVSS 3.x base score of a vector ("CVSS:3.1/AV:N/AC:L/…"), or null. */
export function cvss3Score(vector: string): number | null {
  const parts = Object.fromEntries(
    vector
      .split('/')
      .slice(1)
      .map((part) => part.split(':') as [string, string]),
  );
  const scopeChanged = parts.S === 'C';
  const av = CVSS_WEIGHTS.AV[parts.AV as keyof typeof CVSS_WEIGHTS.AV];
  const ac = CVSS_WEIGHTS.AC[parts.AC as keyof typeof CVSS_WEIGHTS.AC];
  const ui = CVSS_WEIGHTS.UI[parts.UI as keyof typeof CVSS_WEIGHTS.UI];
  const pr = { N: 0.85, L: scopeChanged ? 0.68 : 0.62, H: scopeChanged ? 0.5 : 0.27 }[
    parts.PR as 'N' | 'L' | 'H'
  ];
  const c = CVSS_WEIGHTS.CIA[parts.C as 'H' | 'L' | 'N'];
  const i = CVSS_WEIGHTS.CIA[parts.I as 'H' | 'L' | 'N'];
  const a = CVSS_WEIGHTS.CIA[parts.A as 'H' | 'L' | 'N'];
  if ([av, ac, ui, pr, c, i, a].some((value) => value === undefined)) return null;
  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const exploitability = 8.22 * av! * ac! * pr! * ui!;
  const raw = scopeChanged
    ? Math.min(1.08 * (impact + exploitability), 10)
    : Math.min(impact + exploitability, 10);
  // CVSS "round up" to one decimal, done in integers to avoid float noise.
  const scaled = Math.round(raw * 100000);
  return scaled % 10000 === 0 ? scaled / 100000 : (Math.floor(scaled / 10000) + 1) / 10;
}

export function scoreSeverity(score: number | null): ThreatSeverity {
  if (score === null) return 'medium';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

/** What GRIDCITY keeps of an OSV record. */
export interface VulnFacts {
  id: string;
  score: number | null;
  /** Upstream ids ("CVE-2025-9230"). */
  aliases: string[];
  /** Fixed version per package for this ecosystem, when a fix was released. */
  fixed: Record<string, string>;
  summary: string;
  checkedAt: number;
}

export function vulnFacts(
  record: Record<string, unknown>,
  ecosystem: string,
  now: number,
): VulnFacts {
  const severity = (record.severity as { type: string; score: string }[] | undefined) ?? [];
  const vector = severity.find((s) => s.type === 'CVSS_V3')?.score;
  let score = vector ? cvss3Score(vector) : null;
  const ubuntu = severity.find((s) => s.type === 'Ubuntu')?.score;
  if (score === null && ubuntu)
    score = { critical: 9.5, high: 7.5, medium: 5, low: 2, negligible: 0.5 }[ubuntu] ?? null;
  const fixed: Record<string, string> = {};
  for (const affected of (record.affected as
    | {
        package?: { name?: string; ecosystem?: string };
        ranges?: { events?: { fixed?: string }[] }[];
      }[]
    | undefined) ?? []) {
    if (affected.package?.ecosystem !== ecosystem || !affected.package.name) continue;
    const fix = affected.ranges
      ?.flatMap((range) => range.events ?? [])
      .find((event) => event.fixed)?.fixed;
    if (fix) fixed[affected.package.name] = fix;
  }
  const upstream = [
    ...((record.upstream as string[] | undefined) ?? []),
    ...((record.aliases as string[] | undefined) ?? []),
  ];
  const text = String(record.summary ?? record.details ?? '');
  return {
    id: String(record.id),
    score,
    aliases: [...new Set(upstream.filter((alias) => alias.startsWith('CVE-')))],
    fixed,
    summary: text
      .split('\n')[0]!
      .replace(/^Issue summary:\s*/i, '')
      .slice(0, 160),
    checkedAt: now,
  };
}

export interface PackagesDeps {
  hosts(): readonly Host[];
  runnerFor(hostId: string): SweepRunner | undefined;
  fetch?: typeof fetch;
  cache: {
    getJson<T>(key: string): T | null;
    setJson(key: string, value: unknown, now: number): void;
  };
}

interface PackageReport {
  name: string;
  version: string;
  vulns: VulnFacts[];
}

/**
 * Installed packages with known vulnerabilities, from OSV.dev (Google's open
 * vulnerability database, fed by Debian, Ubuntu, Alpine, Rocky and Alma
 * security data). One finding per server, worst first; "fixable" means a
 * fixed version has been released.
 */
export function createPackagesProducer(deps: PackagesDeps): InsightProducer {
  const send = deps.fetch ?? ((...args) => globalThis.fetch(...args));
  return {
    name: 'packages',
    intervalMs: 12 * 3_600_000,
    async run(now) {
      const results: ProducerResult[] = [];
      for (const host of deps.hosts()) {
        const runner = deps.runnerFor(host.id);
        if (!runner) continue;
        try {
          const installed = parsePackages(
            (await runner.exec('sh -s', PACKAGES_SCRIPT, 60_000)).stdout,
          );
          if (!installed || installed.packages.length === 0 || !installed.ecosystem) {
            results.push({
              targetId: host.id,
              targetName: host.name,
              drafts: [],
              checkedScopes: [],
              coverage: [
                {
                  name: 'Vulnerable packages',
                  ok: false,
                  note: !installed
                    ? 'could not list packages'
                    : !installed.ecosystem
                      ? `${installed.os} is not covered by OSV here (Debian, Ubuntu, Alpine, Rocky and Alma are)`
                      : 'no packages found',
                },
              ],
            });
            continue;
          }
          const report = await checkPackages(installed, send, deps.cache, now);
          results.push(packageResult(host, installed, report, now));
        } catch (error) {
          results.push({
            targetId: host.id,
            targetName: host.name,
            drafts: [],
            checkedScopes: [],
            coverage: [
              {
                name: 'Vulnerable packages',
                ok: false,
                note: (error as Error).message.slice(0, 200),
              },
            ],
          });
        }
      }
      return results;
    },
  };
}

async function checkPackages(
  installed: InstalledPackages,
  send: typeof fetch,
  cache: PackagesDeps['cache'],
  now: number,
): Promise<PackageReport[]> {
  const ecosystem = installed.ecosystem!;
  const hits: { name: string; version: string; ids: string[] }[] = [];
  for (let start = 0; start < installed.packages.length; start += 1000) {
    const chunk = installed.packages.slice(start, start + 1000);
    const response = await send(`${OSV}/querybatch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        queries: chunk.map((p) => ({ package: { name: p.name, ecosystem }, version: p.version })),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`OSV answered ${response.status}`);
    const body = (await response.json()) as { results: { vulns?: { id: string }[] }[] };
    body.results.forEach((result, index) => {
      if (result.vulns?.length) hits.push({ ...chunk[index]!, ids: result.vulns.map((v) => v.id) });
    });
  }
  // Details not cached yet are fetched eight at a time (up to MAX_DETAILS per round).
  const missing = [...new Set(hits.flatMap((hit) => hit.ids))]
    .filter((id) => {
      const facts = cache.getJson<VulnFacts>(`osv:${ecosystem}:${id}`);
      return !facts || now - facts.checkedAt > DETAIL_TTL_MS;
    })
    .slice(0, MAX_DETAILS);
  const queue = [...missing];
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const response = await send(`${OSV}/vulns/${encodeURIComponent(id)}`, {
          signal: AbortSignal.timeout(15_000),
        }).catch(() => null);
        if (response?.ok) {
          const facts = vulnFacts(
            (await response.json()) as Record<string, unknown>,
            ecosystem,
            now,
          );
          cache.setJson(`osv:${ecosystem}:${id}`, facts, now);
        }
      }
    }),
  );
  const reports: PackageReport[] = hits.map((hit) => ({
    name: hit.name,
    version: hit.version,
    vulns: hit.ids.map(
      (id) =>
        cache.getJson<VulnFacts>(`osv:${ecosystem}:${id}`) ?? {
          id,
          score: null,
          aliases: [],
          fixed: {},
          summary: '',
          checkedAt: 0,
        },
    ),
  }));
  return reports;
}

function packageResult(
  host: Host,
  installed: InstalledPackages,
  report: PackageReport[],
  now: number,
): ProducerResult {
  const fixable = report
    .map((pkg) => ({ ...pkg, vulns: pkg.vulns.filter((v) => v.fixed[pkg.name]) }))
    .filter((pkg) => pkg.vulns.length > 0);
  const worst = (pkg: PackageReport) => Math.max(...pkg.vulns.map((v) => v.score ?? 5));
  fixable.sort((a, b) => worst(b) - worst(a));
  const coverage = [
    {
      name: 'Vulnerable packages',
      ok: true,
      note: `${installed.packages.length} packages checked against OSV (${installed.ecosystem})`,
    },
  ];
  if (report.length === 0) {
    return {
      targetId: host.id,
      targetName: host.name,
      drafts: [],
      checkedScopes: ['packages'],
      coverage,
    };
  }
  const topScore = fixable.length > 0 ? worst(fixable[0]!) : null;
  const severity: ThreatSeverity = fixable.length > 0 ? scoreSeverity(topScore) : 'low';
  const top = (fixable.length > 0 ? fixable : report).slice(0, 5).map((pkg) => {
    const fix = pkg.vulns.map((v) => v.fixed[pkg.name]).find(Boolean);
    const cves =
      pkg.vulns
        .flatMap((v) => v.aliases)
        .slice(0, 2)
        .join(', ') || pkg.vulns[0]?.id;
    return `${pkg.name} ${pkg.version}${fix ? ` → ${fix}` : ''} (${pkg.vulns.length} issue${pkg.vulns.length === 1 ? '' : 's'}, e.g. ${cves})`;
  });
  const fixableCount = fixable.length;
  return {
    targetId: host.id,
    targetName: host.name,
    drafts: [
      insightDraft({
        key: 'packages',
        scope: 'packages',
        category: 'vulnerable-package',
        severity,
        title:
          fixableCount > 0
            ? `${fixableCount} package${fixableCount === 1 ? '' : 's'} on ${host.name} ha${fixableCount === 1 ? 's' : 've'} security fixes waiting`
            : `${report.length} package${report.length === 1 ? '' : 's'} on ${host.name} with known issues, no fix released yet`,
        detail: `${report.length} of ${installed.packages.length} installed packages have known vulnerabilities (OSV, ${installed.ecosystem}); ${fixableCount} can be fixed by updating${topScore !== null ? `, the worst scoring ${topScore.toFixed(1)} (CVSS)` : ''}. ${fixableCount > 0 ? 'Top' : 'Most affected'}: ${top.join('; ')}.`,
        advice:
          fixableCount > 0
            ? 'Install the updates (apt upgrade / dnf upgrade / apk upgrade), restart the services that use them, and turn on unattended security updates.'
            : 'Nothing to install yet: keep updates automatic so fixes land when the distribution releases them.',
        now,
      }),
    ],
    checkedScopes: ['packages'],
    coverage,
  };
}
