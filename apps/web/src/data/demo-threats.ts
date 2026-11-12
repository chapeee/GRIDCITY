import type { ThreatCoverage, ThreatFinding, ThreatsView, UpcomingItem } from '@app/shared';

/**
 * Simulated attacks, exposures and upcoming dates for the in-browser demo
 * (DEMO DATA), so the Security and Upcoming panels and the red rings on the
 * buildings can be seen without a server. Attacker addresses use the
 * documentation ranges (RFC 5737), never real hosts.
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function createDemoThreatFindings(now: number): ThreatFinding[] {
  const finding = (
    partial: Omit<ThreatFinding, 'status' | 'resolvedAt' | 'firstSeen' | 'lastSeen'> & {
      ageMs: number;
    },
  ): ThreatFinding => {
    const { ageMs, ...rest } = partial;
    return {
      ...rest,
      firstSeen: now - ageMs,
      lastSeen: now - Math.min(ageMs, 2 * MINUTE),
      status: 'open',
      resolvedAt: null,
    };
  };
  return [
    finding({
      id: 'demo-ssh-brute-ausia-edge',
      targetId: 'ausia-edge',
      source: 'builtin',
      severity: 'high',
      category: 'brute-force',
      title: 'SSH brute force from 203.0.113.9',
      detail: '1,284 failed logins for root, admin and ubuntu in the last hour.',
      advice: 'Password logins are off, so these fail. Block the address or install CrowdSec.',
      attackerIp: '203.0.113.9',
      count: 1284,
      blocked: false,
      ageMs: 3 * HOUR,
    }),
    finding({
      id: 'demo-web-attack-lekhix-web',
      targetId: 'lekhix-web',
      source: 'crowdsec',
      severity: 'medium',
      category: 'web-attack',
      title: 'Path traversal probes from 198.51.100.77',
      detail: 'Requests for /../../etc/passwd and /.env, answered with 404.',
      advice: 'CrowdSec already blocks this address. Nothing was exposed.',
      attackerIp: '198.51.100.77',
      count: 312,
      blocked: true,
      ageMs: 50 * MINUTE,
    }),
    finding({
      id: 'demo-exposure-whatson-db',
      targetId: 'whatson-db',
      source: 'builtin',
      severity: 'critical',
      category: 'exposure',
      title: 'MySQL answers on a public address',
      detail: 'Port 3306 accepts connections from the internet, not only the private network.',
      advice: 'Bind MySQL to 10.40.0.20 or allow 3306 only from the app servers.',
      attackerIp: null,
      count: 1,
      blocked: null,
      ageMs: 2 * DAY,
    }),
    finding({
      id: 'demo-new-port-yuruper-staging',
      targetId: 'yuruper-staging',
      source: 'builtin',
      severity: 'low',
      category: 'new-port',
      title: 'New listening port 9229 (node --inspect)',
      detail: 'A Node.js debugger port opened since the last check.',
      advice: 'Close it on anything reachable from outside: it allows running code.',
      attackerIp: null,
      count: 1,
      blocked: null,
      ageMs: 6 * HOUR,
    }),
    finding({
      id: 'demo-vuln-lekhix-backups',
      targetId: 'lekhix-backups',
      source: 'builtin',
      severity: 'high',
      category: 'vulnerable-package',
      title: 'openssl 3.0.13 has a known vulnerability',
      detail: 'Fixed in 3.0.15. 9 security updates are pending on this server.',
      advice: 'Run the updates and reboot (a reboot is already required).',
      attackerIp: null,
      count: 1,
      blocked: null,
      ageMs: 1 * DAY,
    }),
  ];
}

/** Soonest first, like the real list. */
function upcoming(now: number): UpcomingItem[] {
  const items: UpcomingItem[] = [
    {
      targetId: 'probe-myselfraj',
      kind: 'certificate',
      label: 'myselfraj.com',
      at: now + 5 * DAY,
      status: 'urgent',
      detail: "Let's Encrypt certificate expires in 5 days; auto-renew has not run.",
    },
    {
      targetId: 'whatson-db',
      kind: 'disk-full',
      label: '/var/lib/mysql',
      at: now + 11 * DAY,
      status: 'soon',
      detail: 'Grows 9 GiB a day since the last cleanup: full in about 11 days.',
    },
    {
      targetId: 'lekhix-backups',
      kind: 'backup',
      label: 'nightly pg_dump',
      at: now - 7 * HOUR,
      status: 'overdue',
      detail: "Last night's dump is missing from nightly-backups (expected by 02:30).",
    },
    {
      targetId: 'probe-lekhix',
      kind: 'domain',
      label: 'lekhix.com',
      at: now + 74 * DAY,
      status: 'ok',
      detail: 'Domain registration renews in 74 days (RDAP).',
    },
    {
      targetId: 'probe-portal',
      kind: 'certificate',
      label: 'portal.example.com',
      at: now + 61 * DAY,
      status: 'ok',
      detail: 'Certificate valid for 61 more days.',
    },
  ];
  return items.sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity));
}

function coverage(now: number, findings: ThreatFinding[]): ThreatCoverage[] {
  return [...new Set(findings.map((f) => f.targetId))].map((targetId) => ({
    targetId,
    checkedAt: now - 3 * MINUTE,
    checks: [
      { name: 'SSH logins', ok: true, note: null },
      { name: 'Listening ports', ok: true, note: null },
      { name: 'Packages (OSV.dev)', ok: true, note: null },
      { name: 'CrowdSec', ok: targetId === 'lekhix-web', note: null },
    ],
  }));
}

export function createDemoThreatsView(now = Date.now()): ThreatsView {
  const findings = createDemoThreatFindings(now);
  return { findings, coverage: coverage(now, findings), upcoming: upcoming(now), demo: true };
}
