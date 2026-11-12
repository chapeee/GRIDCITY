import {
  SEVERITY_RANK,
  type ThreatCategory,
  type ThreatCoverage,
  type ThreatSeverity,
  type ThreatSource,
} from '@app/shared';
import type { AuthEvent, SweepResult, ToolState } from './parse-sweep';

/** What a host looked like when GRIDCITY first checked it, plus what the user accepted since. */
export interface HostBaseline {
  /** "name:uid" */
  users: string[];
  /** "tcp:22" */
  ports: string[];
  /** "user@ip" */
  logins: string[];
  createdAt: number;
}

/**
 * A finding as one check sees it right now. The store turns drafts into
 * findings: a draft that is no longer reported by a check that ran
 * successfully is resolved.
 */
export interface ThreatDraft {
  /** Stable key within the target, e.g. "brute-force:203.0.113.9". */
  key: string;
  /** The check that produces it; only checks that ran can resolve their findings. */
  scope: string;
  source: ThreatSource;
  severity: ThreatSeverity;
  category: ThreatCategory;
  title: string;
  detail: string;
  advice: string;
  attackerIp: string | null;
  count: number;
  firstSeen: number;
  lastSeen: number;
  blocked: boolean | null;
}

export interface HostDetection {
  drafts: ThreatDraft[];
  /** Scopes that ran successfully this time. */
  checkedScopes: string[];
  coverage: ThreatCoverage['checks'];
  /** The baseline to keep (created on the first successful sweep). */
  baseline: HostBaseline;
}

const MINUTE = 60_000;
/** Failed SSH attempts from one address within an hour that count as brute force. */
export const BRUTE_FORCE_ATTEMPTS = 10;
/** …and that many make it "high". */
export const BRUTE_FORCE_HIGH = 100;
/** A brute force is over when the address has been quiet this long. */
export const BRUTE_FORCE_QUIET_MS = 30 * MINUTE;
const WINDOW_MS = 60 * MINUTE;
/** Failures before a successful login that make the login suspicious. */
const FAILURES_BEFORE_LOGIN = 5;

const SSH_ADVICE =
  'Use SSH keys only (PasswordAuthentication no), disable root login, and install CrowdSec or Fail2ban to block repeat offenders.';

/** Runs every built-in rule and the CrowdSec/Fail2ban readers over one sweep. */
export function detectHostThreats(
  sweep: SweepResult,
  previous: HostBaseline | null,
): HostDetection {
  const drafts: ThreatDraft[] = [];
  const checkedScopes: string[] = [];
  const coverage: ThreatCoverage['checks'] = [];
  const now = sweep.remoteNow;

  const blockedBy = new Map<string, ThreatSource>();
  if (sweep.fail2ban.state === 'ok') {
    for (const jail of sweep.fail2ban.data)
      for (const ip of jail.bannedIps) blockedBy.set(ip, 'fail2ban');
  }
  /** CrowdSec decided to ban these, but no bouncer enforces it. */
  const decidedOnly = new Set<string>();
  if (sweep.crowdsec.state === 'ok') {
    for (const ip of sweep.crowdsec.data.bannedIps) {
      if (sweep.crowdsec.data.enforced) blockedBy.set(ip, 'crowdsec');
      else if (!blockedBy.has(ip)) decidedOnly.add(ip);
    }
  }

  // A baseline is only created from data that was actually read.
  const baseline: HostBaseline = previous ?? {
    users: sweep.users.state === 'ok' ? sweep.users.data.map((u) => `${u.name}:${u.uid}`) : [],
    ports: sweep.listening.state === 'ok' ? exposedPorts(sweep) : [],
    logins:
      sweep.auth.state === 'ok'
        ? [
            ...new Set(
              sweep.auth.data.filter((e) => e.kind === 'accepted').map((e) => `${e.user}@${e.ip}`),
            ),
          ]
        : [],
    createdAt: now,
  };
  const firstSweep = previous === null;

  // ── SSH logins ──
  coverage.push(
    toolCoverage(
      'SSH logins',
      sweep.auth,
      'cannot read the auth log: add this user to the "adm" group (Debian/Ubuntu) or allow it to read /var/log/secure',
    ),
  );
  if (sweep.auth.state === 'ok') {
    checkedScopes.push('auth');
    drafts.push(...authDrafts(sweep.auth.data, now, baseline, firstSweep, blockedBy));
  }

  // ── Accounts ──
  coverage.push(toolCoverage('Accounts', sweep.users, 'cannot read the account list'));
  if (sweep.users.state === 'ok') {
    checkedScopes.push('users');
    const known = new Set(baseline.users.map((entry) => entry.split(':')[0]));
    for (const user of sweep.users.data) {
      if (user.uid === 0 && user.name !== 'root') {
        drafts.push({
          key: `uid0:${user.name}`,
          scope: 'users',
          source: 'builtin',
          severity: 'critical',
          category: 'privilege',
          title: `Account "${user.name}" has root powers (uid 0)`,
          detail: `Besides root, the account "${user.name}" has user id 0, which gives it full control of the machine. Attackers add such accounts to keep access.`,
          advice: `If you did not create it, treat the server as compromised: remove the account (or set another uid), check ~/.ssh/authorized_keys and recent logins.`,
          attackerIp: null,
          count: 1,
          firstSeen: now,
          lastSeen: now,
          blocked: null,
        });
        continue;
      }
      if (firstSweep || known.has(user.name)) continue;
      const canLogIn = !/(nologin|false|sync|halt|shutdown)$/.test(user.shell);
      drafts.push({
        key: `user:${user.name}`,
        scope: 'users',
        source: 'builtin',
        severity: canLogIn ? 'medium' : 'low',
        category: 'new-user',
        title: `New account "${user.name}"`,
        detail: `The account "${user.name}" (uid ${user.uid}, shell ${user.shell || 'none'}) appeared since GRIDCITY started watching this server.`,
        advice:
          'If you or a package created it, mark it as expected. Otherwise remove it and check how it was added.',
        attackerIp: null,
        count: 1,
        firstSeen: now,
        lastSeen: now,
        blocked: null,
      });
    }
  }

  // ── Open ports ──
  coverage.push(toolCoverage('Open ports', sweep.listening, 'neither ss nor netstat is available'));
  if (sweep.listening.state === 'ok') {
    checkedScopes.push('listen');
    const known = new Set(baseline.ports);
    if (!firstSweep) {
      for (const port of sweep.listening.data) {
        const key = `${port.protocol}:${port.port}`;
        if (isLoopback(port.address) || known.has(key)) continue;
        drafts.push({
          key: `port:${key}`,
          scope: 'listen',
          source: 'builtin',
          severity: 'medium',
          category: 'new-port',
          title: `New open port ${port.port}/${port.protocol}`,
          detail: `Something started listening on ${port.address}:${port.port}${port.process ? ` (${port.process})` : ''} since GRIDCITY started watching. Backdoors and forgotten test services show up like this.`,
          advice:
            'If it is a service you started, mark it as expected. Otherwise find the process (ss -lntp) and stop it, and firewall the port.',
          attackerIp: null,
          count: 1,
          firstSeen: now,
          lastSeen: now,
          blocked: null,
        });
      }
    }
  }

  // ── CrowdSec ──
  coverage.push(
    toolCoverage(
      'CrowdSec',
      sweep.crowdsec,
      'installed, but reading it needs root: allow `sudo -n cscli` for this user',
    ),
  );
  if (sweep.crowdsec.state === 'ok') {
    checkedScopes.push('crowdsec');
    const grouped = new Map<string, ThreatDraft>();
    for (const alert of sweep.crowdsec.data.alerts) {
      if (now - alert.stopAt > WINDOW_MS) continue;
      const category = crowdsecCategory(alert.scenario);
      const key = alert.ip ? `${category}:${alert.ip}` : `crowdsec:${alert.scenario}`;
      const blocked = alert.ip ? blockedBy.has(alert.ip) : null;
      const unenforced = alert.ip !== null && decidedOnly.has(alert.ip);
      const existing = grouped.get(key);
      if (existing) {
        existing.count += alert.events;
        existing.firstSeen = Math.min(existing.firstSeen, alert.startAt);
        existing.lastSeen = Math.max(existing.lastSeen, alert.stopAt);
        continue;
      }
      grouped.set(key, {
        key,
        scope: 'crowdsec',
        source: 'crowdsec',
        severity: blocked ? 'medium' : 'high',
        category,
        title: `${scenarioLabel(alert.scenario)}${alert.ip ? ` from ${alert.ip}` : ''}`,
        detail: `CrowdSec scenario ${alert.scenario}: ${alert.message || 'triggered'}${alert.country ? ` (country ${alert.country})` : ''}.${blocked ? ' This address is blocked.' : unenforced ? ' CrowdSec decided to ban it, but no bouncer is installed, so nothing actually blocks it.' : ' No block is in place.'}`,
        advice: blocked
          ? 'Blocked already. Check that the targeted service is patched and not exposed more than needed.'
          : 'Install a CrowdSec bouncer (firewall or nginx) so CrowdSec can block it, and check the targeted service.',
        attackerIp: alert.ip,
        count: alert.events,
        firstSeen: alert.startAt,
        lastSeen: alert.stopAt,
        blocked,
      });
    }
    drafts.push(...grouped.values());
  }

  // ── Fail2ban ──
  coverage.push(
    toolCoverage(
      'Fail2ban',
      sweep.fail2ban,
      'installed, but reading it needs root: allow `sudo -n fail2ban-client` for this user',
    ),
  );
  if (sweep.fail2ban.state === 'ok') {
    checkedScopes.push('fail2ban');
    for (const jail of sweep.fail2ban.data) {
      for (const ip of jail.bannedIps) {
        drafts.push({
          key: `brute-force:${ip}`,
          scope: 'fail2ban',
          source: 'fail2ban',
          severity: 'medium',
          category: 'brute-force',
          title: `Brute force from ${ip} (banned by Fail2ban)`,
          detail: `Fail2ban's "${jail.name}" jail banned ${ip} after repeated failures (${jail.totalFailed} failures and ${jail.totalBanned} bans in this jail so far).`,
          advice: 'Blocked already. Keep password logins off where you can.',
          attackerIp: ip,
          count: 1,
          firstSeen: now,
          lastSeen: now,
          blocked: true,
        });
      }
    }
  }

  return { drafts: mergeSameAttack(drafts), checkedScopes, coverage, baseline };
}

function authDrafts(
  events: AuthEvent[],
  now: number,
  baseline: HostBaseline,
  firstSweep: boolean,
  blockedBy: Map<string, ThreatSource>,
): ThreatDraft[] {
  const drafts: ThreatDraft[] = [];
  const failuresByIp = new Map<string, AuthEvent[]>();
  for (const event of events) {
    if (event.kind !== 'failed' || !event.ip) continue;
    const list = failuresByIp.get(event.ip) ?? [];
    list.push(event);
    failuresByIp.set(event.ip, list);
  }

  for (const [ip, failures] of failuresByIp) {
    const recent = failures.filter((event) => now - event.at <= WINDOW_MS);
    const last = failures[failures.length - 1]!;
    if (recent.length < BRUTE_FORCE_ATTEMPTS || now - last.at > BRUTE_FORCE_QUIET_MS) continue;
    const users = [...new Set(failures.map((event) => event.user).filter(Boolean))];
    const blocker = blockedBy.get(ip);
    drafts.push({
      key: `brute-force:${ip}`,
      scope: 'auth',
      source: 'builtin',
      severity: recent.length >= BRUTE_FORCE_HIGH ? 'high' : 'medium',
      category: 'brute-force',
      title: `SSH brute force from ${ip}`,
      detail: `${recent.length} failed SSH logins from ${ip} in the last hour (${failures.length} in the log), trying ${describeUsers(users)}.${blocker ? ` ${blocker === 'crowdsec' ? 'CrowdSec' : 'Fail2ban'} is blocking it.` : ''}`,
      advice: SSH_ADVICE,
      attackerIp: ip,
      count: failures.length,
      firstSeen: failures[0]!.at,
      lastSeen: last.at,
      blocked: blocker ? true : null,
    });
  }

  const knownLogins = new Set(baseline.logins);
  for (const login of events) {
    if (login.kind !== 'accepted' || !login.ip) continue;
    const before = (failuresByIp.get(login.ip) ?? []).filter((event) => event.at <= login.at);
    if (before.length >= FAILURES_BEFORE_LOGIN) {
      drafts.push({
        key: `login-after-attack:${login.user}@${login.ip}`,
        scope: 'auth',
        source: 'builtin',
        severity: 'critical',
        category: 'suspicious-login',
        title: `Login as ${login.user} from ${login.ip} after ${before.length} failures`,
        detail: `${login.ip} failed to log in ${before.length} times, then logged in successfully as "${login.user}" at ${new Date(login.at).toISOString()}. This is what a guessed password looks like.`,
        advice: `If this was not you: change the password of "${login.user}" now, check ~/.ssh/authorized_keys, running processes and new accounts, and consider the server compromised.`,
        attackerIp: login.ip,
        count: 1,
        firstSeen: login.at,
        lastSeen: login.at,
        blocked: null,
      });
      continue;
    }
    const key = `${login.user}@${login.ip}`;
    if (firstSweep || knownLogins.has(key)) continue;
    drafts.push({
      key: `new-login:${key}`,
      scope: 'auth',
      source: 'builtin',
      severity: login.user === 'root' ? 'high' : 'medium',
      category: 'suspicious-login',
      title: `${login.user} logged in from a new address ${login.ip}`,
      detail: `"${login.user}" logged in over SSH from ${login.ip}, an address not seen for this account before.`,
      advice:
        'If it was you or a colleague, mark it as expected. Otherwise lock the account and check what it did.',
      attackerIp: login.ip,
      count: 1,
      firstSeen: login.at,
      lastSeen: login.at,
      blocked: null,
    });
  }

  const refusedSudo = new Map<string, AuthEvent[]>();
  for (const event of events) {
    if (event.kind !== 'sudo-failed' || now - event.at > WINDOW_MS) continue;
    refusedSudo.set(event.user, [...(refusedSudo.get(event.user) ?? []), event]);
  }
  for (const [user, refused] of refusedSudo) {
    drafts.push({
      key: `sudo:${user}`,
      scope: 'auth',
      source: 'builtin',
      severity: 'medium',
      category: 'privilege',
      title: `${user} was refused sudo ${refused.length} time${refused.length === 1 ? '' : 's'}`,
      detail: `"${user}" tried to become root and was refused (wrong password or not allowed) ${refused.length} time${refused.length === 1 ? '' : 's'} in the last hour.`,
      advice:
        'Usually a typo. If the account should not try sudo, someone may be using it to escalate.',
      attackerIp: null,
      count: refused.length,
      firstSeen: refused[0]!.at,
      lastSeen: refused[refused.length - 1]!.at,
      blocked: null,
    });
  }
  return drafts;
}

/**
 * The same attacker seen by several detectors (built-in log reading,
 * CrowdSec, Fail2ban) is one finding: the strongest source names it, and it
 * is blocked when any of them blocks it.
 */
function mergeSameAttack(drafts: ThreatDraft[]): ThreatDraft[] {
  const rank: Record<ThreatSource, number> = {
    crowdsec: 3,
    fail2ban: 2,
    wazuh: 2,
    falco: 2,
    guardduty: 2,
    builtin: 1,
  };
  const merged = new Map<string, ThreatDraft>();
  for (const draft of drafts) {
    const existing = merged.get(draft.key);
    if (!existing) {
      merged.set(draft.key, { ...draft });
      continue;
    }
    const [strong, weak] =
      rank[draft.source] > rank[existing.source] ? [draft, existing] : [existing, draft];
    merged.set(draft.key, {
      ...strong,
      // Every check that saw it keeps it open: it resolves when none reports it.
      scope: [...new Set([...existing.scope.split('+'), ...draft.scope.split('+')])].join('+'),
      severity:
        SEVERITY_RANK[weak.severity] > SEVERITY_RANK[strong.severity]
          ? weak.severity
          : strong.severity,
      detail: `${strong.detail} ${weak.source === 'builtin' ? 'GRIDCITY also saw it in the auth log' : `Also reported by ${sourceLabel(weak.source)}`}${weak.count ? ` (${weak.count} events)` : ''}.`,
      count: Math.max(strong.count, weak.count),
      firstSeen: Math.min(strong.firstSeen, weak.firstSeen),
      lastSeen: Math.max(strong.lastSeen, weak.lastSeen),
      blocked: strong.blocked === true || weak.blocked === true ? true : strong.blocked,
      advice: strong.blocked || weak.blocked ? strong.advice : weak.advice || strong.advice,
    });
  }
  return [...merged.values()];
}

export function sourceLabel(source: ThreatSource): string {
  return {
    builtin: 'GRIDCITY',
    crowdsec: 'CrowdSec',
    fail2ban: 'Fail2ban',
    wazuh: 'Wazuh',
    falco: 'Falco',
    guardduty: 'GuardDuty',
  }[source];
}

function toolCoverage(
  name: string,
  tool: ToolState<unknown>,
  deniedNote: string,
): ThreatCoverage['checks'][number] {
  switch (tool.state) {
    case 'ok':
      return { name, ok: true, note: tool.source === 'shell' ? null : `from ${tool.source}` };
    case 'missing':
      return { name, ok: false, note: 'not installed' };
    case 'denied':
      return { name, ok: false, note: deniedNote };
    default:
      return { name, ok: false, note: deniedNote };
  }
}

function exposedPorts(sweep: SweepResult): string[] {
  if (sweep.listening.state !== 'ok') return [];
  return [
    ...new Set(
      sweep.listening.data
        .filter((port) => !isLoopback(port.address))
        .map((port) => `${port.protocol}:${port.port}`),
    ),
  ];
}

function isLoopback(address: string): boolean {
  return (
    address.startsWith('127.') ||
    address === '::1' ||
    address === '[::1]' ||
    address === 'localhost'
  );
}

function describeUsers(users: string[]): string {
  if (users.length === 0) return 'unknown accounts';
  const shown = users
    .slice(0, 5)
    .map((user) => `"${user}"`)
    .join(', ');
  return users.length > 5 ? `${shown} and ${users.length - 5} more accounts` : shown;
}

function crowdsecCategory(scenario: string): ThreatCategory {
  const name = scenario.toLowerCase();
  if (/(bf|brute|bruteforce)/.test(name)) return 'brute-force';
  if (/(scan|probing|crawl)/.test(name)) return 'port-scan';
  if (/(http|cve|exploit|sqli|xss|traversal|wordpress|log4j)/.test(name)) return 'web-attack';
  return 'other';
}

function scenarioLabel(scenario: string): string {
  const name = scenario.split('/').pop() ?? scenario;
  const labels: Record<string, string> = {
    'ssh-bf': 'SSH brute force',
    'ssh-slow-bf': 'Slow SSH brute force',
    'ssh-cve-2024-6387': 'SSH exploit attempt (regreSSHion)',
    'http-probing': 'Web probing',
    'http-crawl-non_statics': 'Aggressive web crawling',
    'http-bad-user-agent': 'Known attack tool',
    portscan: 'Port scan',
  };
  return labels[name] ?? `CrowdSec: ${name.replace(/[-_]/g, ' ')}`;
}
