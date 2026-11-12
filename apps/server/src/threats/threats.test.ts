import { describe, expect, it } from 'vitest';
import { detectHostThreats, type HostBaseline } from './detect';
import {
  parseAuthLog,
  parseCrowdsecAlerts,
  parseCrowdsecDecisions,
  parseFail2ban,
  parseLogTime,
  parseSweepOutput,
} from './parse-sweep';

// 2026-11-12 07:30:00 at +05:30 (IST), a typical server clock.
const NOW = Date.parse('2026-11-12T07:30:00+05:30');
const IST = 330;

describe('log timestamps', () => {
  it('reads classic syslog in the host zone, ISO rsyslog and journal short-iso', () => {
    expect(parseLogTime('Nov 12 07:01:02 web sshd[1]: x', NOW, IST)?.at).toBe(
      Date.parse('2026-11-12T07:01:02+05:30'),
    );
    expect(parseLogTime('2026-11-12T07:01:02.123456+05:30 web sshd[1]: x', NOW, IST)?.at).toBe(
      Date.parse('2026-11-12T07:01:02.123+05:30'),
    );
    expect(parseLogTime('2026-11-12T01:31:02+0000 web sshd[1]: x', NOW, IST)?.at).toBe(
      Date.parse('2026-11-12T01:31:02Z'),
    );
    expect(parseLogTime('not a log line', NOW, IST)).toBeNull();
  });

  it('puts a December line read in January in last year', () => {
    const january = Date.parse('2027-01-02T00:00:00Z');
    expect(new Date(parseLogTime('Dec 31 23:59:00 h x: y', january, 0)!.at).getUTCFullYear()).toBe(
      2026,
    );
  });
});

/** Ubuntu 24.04 (ISO rsyslog), Debian 11 (syslog) and RHEL (secure) lines. */
const AUTH_LOG = [
  // One connection, two passwords tried (Ubuntu ISO format, sshd-session on OpenSSH 9.8+).
  '2026-11-12T07:10:01.000001+05:30 web sshd-session[2001]: Invalid user admin from 203.0.113.9 port 50001',
  '2026-11-12T07:10:02.000001+05:30 web sshd-session[2001]: Failed password for invalid user admin from 203.0.113.9 port 50001 ssh2',
  '2026-11-12T07:10:04.000001+05:30 web sshd-session[2001]: Failed password for invalid user admin from 203.0.113.9 port 50001 ssh2',
  // Key-only server: no "Failed" line, just a pre-auth disconnect (counts once).
  'Nov 12 07:11:00 web sshd[2002]: Invalid user oracle from 203.0.113.9 port 50002',
  'Nov 12 07:11:01 web sshd[2002]: Connection closed by invalid user oracle 203.0.113.9 port 50002 [preauth]',
  // RHEL /var/log/secure
  'Nov 12 07:12:00 web sshd[2003]: Failed password for root from 198.51.100.7 port 40000 ssh2',
  'Nov 12 07:12:30 web sshd[2003]: pam_unix(sshd:auth): authentication failure; logname= uid=0 euid=0 tty=ssh ruser= rhost=198.51.100.7  user=root',
  'Nov 12 07:13:00 web sshd[2004]: Accepted publickey for deploy from 192.0.2.10 port 51000 ssh2: ED25519 SHA256:abc',
  'Nov 12 07:14:00 web sudo:   deploy : 3 incorrect password attempts ; TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/bin/bash',
  'Nov 12 07:14:10 web sudo:    guest : user NOT in sudoers ; TTY=pts/1 ; PWD=/home/guest ; USER=root ; COMMAND=/bin/sh',
  'Nov 12 07:14:20 web sudo:   deploy : TTY=pts/0 ; PWD=/home/deploy ; USER=root ; COMMAND=/usr/bin/ls',
].join('\n');

describe('auth log', () => {
  it('counts every failed password, and a pre-auth-only connection once', () => {
    const events = parseAuthLog(AUTH_LOG, NOW, IST);
    const failed = events.filter((e) => e.kind === 'failed');
    expect(failed.filter((e) => e.ip === '203.0.113.9')).toHaveLength(3);
    expect(failed.filter((e) => e.ip === '198.51.100.7')).toHaveLength(1);
    expect(events.find((e) => e.kind === 'accepted')).toMatchObject({
      user: 'deploy',
      ip: '192.0.2.10',
    });
    expect(events.filter((e) => e.kind === 'sudo-failed').map((e) => e.user)).toEqual([
      'deploy',
      'guest',
    ]);
  });
});

function attackLog(ip: string, attempts: number, startMinute: number, extra: string[] = []) {
  const lines: string[] = [];
  for (let i = 0; i < attempts; i++) {
    const at = new Date(NOW - (startMinute - i * 0.1) * 60_000);
    lines.push(
      `${at.toISOString()} web sshd[${3000 + i}]: Failed password for root from ${ip} port ${40000 + i} ssh2`,
    );
  }
  return [...lines, ...extra].join('\n');
}

function sweepOutput(sections: Record<string, string>) {
  const order = [
    'clock',
    'auth',
    'users',
    'listen',
    'crowdsec-alerts',
    'crowdsec-decisions',
    'crowdsec-bouncers',
    'fail2ban',
  ];
  return [
    ...order.flatMap((name) => [`@@section ${name}`, sections[name] ?? '@@missing']),
    '@@end-sweep',
  ].join('\n');
}

const USERS = 'root:0:/bin/bash\ndaemon:1:/usr/sbin/nologin\ndeploy:1000:/bin/bash';
const LISTEN = 'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\ntcp LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*';
const clock = `${NOW / 1000}\n+0530`;

const baselineOf = (over: Partial<HostBaseline> = {}): HostBaseline => ({
  users: ['root:0', 'daemon:1', 'deploy:1000'],
  ports: ['tcp:22'],
  logins: ['deploy@192.0.2.10'],
  createdAt: 0,
  ...over,
});

describe('host detection', () => {
  it('turns a recent run of failures into a brute force, severity by volume', () => {
    const sweep = parseSweepOutput(
      sweepOutput({
        clock,
        auth: `@@source /var/log/auth.log\n${attackLog('203.0.113.9', 12, 20)}`,
        users: USERS,
        listen: LISTEN,
      }),
      NOW,
    )!;
    const { drafts, checkedScopes } = detectHostThreats(sweep, baselineOf());
    expect(checkedScopes).toEqual(['auth', 'users', 'listen']);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      key: 'brute-force:203.0.113.9',
      severity: 'medium',
      count: 12,
      blocked: null,
    });

    const heavy = parseSweepOutput(
      sweepOutput({ clock, auth: attackLog('203.0.113.9', 120, 30) }),
      NOW,
    )!;
    expect(detectHostThreats(heavy, baselineOf()).drafts[0]!.severity).toBe('high');
  });

  it('lets a brute force end when the address goes quiet', () => {
    const quiet = parseSweepOutput(
      sweepOutput({ clock, auth: attackLog('203.0.113.9', 30, 59) }),
      NOW,
    )!;
    // last attempt about 56 minutes ago: over
    expect(detectHostThreats(quiet, baselineOf()).drafts).toEqual([]);
  });

  it('flags a successful login right after failures as critical', () => {
    const login = `${new Date(NOW - 60_000).toISOString()} web sshd[9]: Accepted password for root from 203.0.113.9 port 1 ssh2`;
    const sweep = parseSweepOutput(
      sweepOutput({ clock, auth: attackLog('203.0.113.9', 6, 10, [login]) }),
      NOW,
    )!;
    const draft = detectHostThreats(sweep, baselineOf()).drafts.find(
      (d) => d.category === 'suspicious-login',
    );
    expect(draft).toMatchObject({
      severity: 'critical',
      title: 'Login as root from 203.0.113.9 after 6 failures',
    });
  });

  it('learns a baseline on the first sweep, then reports new accounts, ports and login addresses', () => {
    const first = parseSweepOutput(
      sweepOutput({ clock, auth: AUTH_LOG, users: USERS, listen: LISTEN }),
      NOW,
    )!;
    const learned = detectHostThreats(first, null);
    expect(learned.drafts.filter((d) => d.category !== 'privilege')).toEqual([]);
    expect(learned.baseline).toMatchObject({
      users: ['root:0', 'daemon:1', 'deploy:1000'],
      ports: ['tcp:22'],
      logins: ['deploy@192.0.2.10'],
    });

    const later = parseSweepOutput(
      sweepOutput({
        clock,
        auth: `${AUTH_LOG}\nNov 12 07:20:00 web sshd[77]: Accepted publickey for deploy from 192.0.2.99 port 2 ssh2`,
        users: `${USERS}\nbackdoor:1001:/bin/bash\ntoor:0:/bin/sh`,
        listen: `${LISTEN}\ntcp LISTEN 0 128 0.0.0.0:4444 0.0.0.0:* users:(("nc",pid=1,fd=3))`,
      }),
      NOW,
    )!;
    const keys = detectHostThreats(later, learned.baseline).drafts.map(
      (d) => `${d.key}=${d.severity}`,
    );
    expect(keys).toEqual(
      expect.arrayContaining([
        'new-login:deploy@192.0.2.99=medium',
        'user:backdoor=medium',
        'uid0:toor=critical',
        'port:tcp:4444=medium',
        'sudo:deploy=medium',
        'sudo:guest=medium',
      ]),
    );
  });

  it('merges the same attacker from the log, Fail2ban and CrowdSec into one blocked finding', () => {
    const crowdAlerts = JSON.stringify([
      {
        id: 7,
        scenario: 'crowdsecurity/ssh-bf',
        message: 'Ip 203.0.113.9 performed crowdsecurity/ssh-bf (6 events over 3s)',
        events_count: 6,
        start_at: new Date(NOW - 5 * 60_000).toISOString(),
        stop_at: new Date(NOW - 4 * 60_000).toISOString(),
        source: { ip: '203.0.113.9', scope: 'Ip', value: '203.0.113.9', cn: 'NL' },
      },
    ]);
    const decisions = JSON.stringify([
      { id: 7, decisions: [{ value: '203.0.113.9', type: 'ban', scope: 'Ip', duration: '3h59m' }] },
    ]);
    const jail =
      '@@jail sshd\nStatus for the jail: sshd\n|- Filter\n|  |- Currently failed:\t2\n|  |- Total failed:\t40\n`- Actions\n   |- Currently banned:\t1\n   |- Total banned:\t1\n   `- Banned IP list:\t203.0.113.9';
    const sweep = parseSweepOutput(
      sweepOutput({
        clock,
        auth: attackLog('203.0.113.9', 15, 15),
        'crowdsec-alerts': `@@source cscli\n${crowdAlerts}`,
        'crowdsec-decisions': `@@source cscli\n${decisions}`,
        'crowdsec-bouncers': '@@source cscli\n[{"name":"firewall"}]',
        fail2ban: `@@source fail2ban-client\n${jail}`,
      }),
      NOW,
    )!;
    const { drafts, coverage } = detectHostThreats(sweep, baselineOf());
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      key: 'brute-force:203.0.113.9',
      source: 'crowdsec',
      blocked: true,
      count: 15,
      title: 'SSH brute force from 203.0.113.9',
    });
    expect(drafts[0]!.scope.split('+').sort()).toEqual(['auth', 'crowdsec', 'fail2ban']);
    expect(coverage.map((c) => `${c.name}:${c.ok}`)).toEqual([
      'SSH logins:true',
      'Accounts:false',
      'Open ports:false',
      'CrowdSec:true',
      'Fail2ban:true',
    ]);
  });

  it('does not call an address blocked when CrowdSec has no bouncer to enforce the ban', () => {
    const alerts = JSON.stringify([
      {
        id: 1,
        scenario: 'crowdsecurity/ssh-bf',
        events_count: 6,
        start_at: new Date(NOW - 3 * 60_000).toISOString(),
        stop_at: new Date(NOW - 2 * 60_000).toISOString(),
        source: { ip: '198.51.100.20', scope: 'Ip', value: '198.51.100.20' },
      },
    ]);
    const decisions = JSON.stringify([{ decisions: [{ value: '198.51.100.20', scope: 'Ip' }] }]);
    const sweep = (bouncers: string) =>
      parseSweepOutput(
        sweepOutput({
          clock,
          'crowdsec-alerts': `@@source cscli\n${alerts}`,
          'crowdsec-decisions': `@@source cscli\n${decisions}`,
          'crowdsec-bouncers': `@@source cscli\n${bouncers}`,
        }),
        NOW,
      )!;
    const unenforced = detectHostThreats(sweep('null'), baselineOf()).drafts[0]!;
    expect(unenforced).toMatchObject({ blocked: false, severity: 'high' });
    expect(unenforced.detail).toMatch(/no bouncer is installed/);
    const enforced = detectHostThreats(sweep('[{"name":"firewall"}]'), baselineOf()).drafts[0]!;
    expect(enforced).toMatchObject({ blocked: true, severity: 'medium' });
  });

  it('explains what it could not read', () => {
    const sweep = parseSweepOutput(
      sweepOutput({
        clock,
        auth: '@@unavailable',
        'crowdsec-alerts': '@@denied',
        fail2ban: '@@missing',
      }),
      NOW,
    )!;
    const { coverage, checkedScopes } = detectHostThreats(sweep, null);
    expect(checkedScopes).toEqual([]);
    expect(coverage[0]!.note).toMatch(/adm/);
    expect(coverage.find((c) => c.name === 'CrowdSec')!.note).toMatch(/sudo -n cscli/);
    expect(coverage.find((c) => c.name === 'Fail2ban')!.note).toBe('not installed');
  });

  it('returns null for a sweep that did not finish', () => {
    expect(parseSweepOutput('@@section clock\n1', NOW)).toBeNull();
  });
});

describe('CrowdSec and Fail2ban output', () => {
  it('reads empty CrowdSec answers ("null") as nothing', () => {
    expect(parseCrowdsecAlerts('null')).toEqual([]);
    expect(parseCrowdsecDecisions('null\n')).toEqual([]);
    expect(parseCrowdsecAlerts('not json')).toEqual([]);
  });

  it('reads several jails', () => {
    const jails = parseFail2ban(
      '@@jail sshd\n   |- Currently banned:\t0\n   `- Banned IP list:\t\n@@jail nginx-http-auth\n   |- Total banned:\t3\n   `- Banned IP list:\t1.2.3.4 5.6.7.8',
    );
    expect(jails.map((j) => [j.name, j.bannedIps])).toEqual([
      ['sshd', []],
      ['nginx-http-auth', ['1.2.3.4', '5.6.7.8']],
    ]);
  });
});
