import type { ListeningPort } from '@app/shared';
import { parseListening } from '../metrics/parse-inventory';
import {
  SWEEP_END,
  SWEEP_JAIL,
  SWEEP_SECTION,
  SWEEP_SECTIONS,
  SWEEP_SOURCE,
  type SweepSectionName,
} from './sweep-script';

/** One SSH or sudo event from the auth log. */
export interface AuthEvent {
  at: number;
  kind: 'failed' | 'accepted' | 'sudo-failed';
  user: string;
  /** Remote address (SSH); null for sudo. */
  ip: string | null;
  /** sshd process id: one connection can try several passwords. */
  pid: string | null;
}

export interface PasswdEntry {
  name: string;
  uid: number;
  shell: string;
}

export interface CrowdsecAlert {
  id: number;
  scenario: string;
  message: string;
  ip: string | null;
  country: string | null;
  events: number;
  startAt: number;
  stopAt: number;
}

export interface Fail2banJail {
  name: string;
  currentlyFailed: number;
  totalFailed: number;
  currentlyBanned: number;
  totalBanned: number;
  bannedIps: string[];
}

export type ToolState<T> =
  | { state: 'ok'; source: string; data: T }
  | { state: 'missing' }
  | { state: 'denied' }
  | { state: 'unavailable' };

export interface SweepResult {
  /** The host's clock (ms) and UTC offset (minutes), for syslog timestamps without a zone. */
  remoteNow: number;
  offsetMinutes: number;
  auth: ToolState<AuthEvent[]>;
  users: ToolState<PasswdEntry[]>;
  listening: ToolState<ListeningPort[]>;
  /**
   * `bannedIps`: CrowdSec decided to ban them. `enforced`: a bouncer is
   * installed, so the ban actually blocks traffic (without one it does not).
   */
  crowdsec: ToolState<{ alerts: CrowdsecAlert[]; bannedIps: string[]; enforced: boolean }>;
  fail2ban: ToolState<Fail2banJail[]>;
}

/** Parses the sweep script's output; null when it did not finish. */
export function parseSweepOutput(output: string, localNow: number): SweepResult | null {
  const sections = splitSections(output);
  if (!sections) return null;
  const clock = (sections.get('clock') ?? '').trim().split('\n');
  const epoch = Number(clock[0]);
  const remoteNow = Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : localNow;
  const offsetMinutes = parseOffset(clock[1] ?? '') ?? 0;

  const raw = (name: SweepSectionName) => sections.get(name) ?? '';
  const crowdAlerts = state(raw('crowdsec-alerts'), (text) => parseCrowdsecAlerts(text));
  const crowdDecisions = state(raw('crowdsec-decisions'), (text) => parseCrowdsecDecisions(text));
  const crowdBouncers = state(raw('crowdsec-bouncers'), (text) => parseJsonArray(text).length);
  return {
    remoteNow,
    offsetMinutes,
    auth: state(raw('auth'), (text) => parseAuthLog(text, remoteNow, offsetMinutes)),
    users: state(raw('users'), parsePasswd),
    listening: state(raw('listen'), parseListening),
    crowdsec:
      crowdAlerts.state === 'ok'
        ? {
            state: 'ok',
            source: crowdAlerts.source,
            data: {
              alerts: crowdAlerts.data,
              bannedIps: crowdDecisions.state === 'ok' ? crowdDecisions.data : [],
              enforced: crowdBouncers.state === 'ok' && crowdBouncers.data > 0,
            },
          }
        : crowdAlerts,
    fail2ban: state(raw('fail2ban'), parseFail2ban),
  };
}

function splitSections(output: string): Map<SweepSectionName, string> | null {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  if (!lines.some((line) => line.trim() === SWEEP_END)) return null;
  const sections = new Map<SweepSectionName, string>();
  let current: SweepSectionName | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) sections.set(current, buffer.join('\n'));
  };
  for (const line of lines) {
    if (line.startsWith(SWEEP_SECTION)) {
      flush();
      const name = line.slice(SWEEP_SECTION.length).trim() as SweepSectionName;
      current = (SWEEP_SECTIONS as readonly string[]).includes(name) ? name : null;
      buffer = [];
    } else if (line.trim() === SWEEP_END) {
      flush();
      current = null;
    } else if (current) {
      buffer.push(line);
    }
  }
  return sections;
}

/** Reads the `@@source` / `@@missing` / `@@denied` / `@@unavailable` line, then parses the rest. */
function state<T>(text: string, parse: (body: string) => T): ToolState<T> {
  const trimmed = text.trim();
  if (trimmed === '@@missing') return { state: 'missing' };
  if (trimmed === '@@denied') return { state: 'denied' };
  if (trimmed === '@@unavailable' || trimmed === '') return { state: 'unavailable' };
  let source = 'shell';
  let body = text;
  const firstLine = text.split('\n', 1)[0] ?? '';
  if (firstLine.startsWith(SWEEP_SOURCE)) {
    source = firstLine.slice(SWEEP_SOURCE.length).trim();
    body = text.slice(firstLine.length + 1);
  }
  return { state: 'ok', source, data: parse(body) };
}

function parseOffset(text: string): number | null {
  const match = /^([+-])(\d{2}):?(\d{2})$/.exec(text.trim());
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The timestamp at the start of a log line: ISO (rsyslog on current
 * Ubuntu/Debian, `journalctl -o short-iso`) or classic syslog ("Nov 12
 * 07:01:02", in the host's local time and without a year).
 */
export function parseLogTime(
  line: string,
  remoteNow: number,
  offsetMinutes: number,
): { at: number; rest: string } | null {
  const iso = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?\s+(.*)$/.exec(
    line,
  );
  if (iso) {
    const zone = iso[2] ?? '';
    const normalizedZone =
      zone === ''
        ? offsetText(offsetMinutes)
        : zone === 'Z'
          ? 'Z'
          : zone.replace(/(\d{2})(\d{2})$/, '$1:$2');
    const at = Date.parse(`${iso[1]}${normalizedZone}`);
    return Number.isFinite(at) ? { at, rest: iso[3]! } : null;
  }
  const syslog = /^([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2})\s+(.*)$/.exec(line);
  if (!syslog) return null;
  const month = MONTHS.indexOf(syslog[1]!);
  if (month < 0) return null;
  const remoteDate = new Date(remoteNow + offsetMinutes * 60_000);
  let year = remoteDate.getUTCFullYear();
  const build = (y: number) =>
    Date.UTC(y, month, Number(syslog[2]), Number(syslog[3]), Number(syslog[4]), Number(syslog[5])) -
    offsetMinutes * 60_000;
  // A December line read in January belongs to last year.
  if (build(year) > remoteNow + 86_400_000) year -= 1;
  return { at: build(year), rest: syslog[6]! };
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

const SSHD = /^\S+\s+sshd(?:-session)?\[(\d+)\]:\s+(.*)$/;
const SUDO = /^\S+\s+sudo(?:\[\d+\])?:\s+(.*)$/;
const FAILED =
  /^Failed (?:password|publickey|keyboard-interactive\/pam|none) for (?:invalid user )?(\S*) from (\S+) port/;
const ACCEPTED = /^Accepted (?:\S+) for (\S+) from (\S+) port/;
const PREAUTH_FAILURE =
  /^(?:Invalid user (\S*) from (\S+)|Connection (?:closed|reset) by (?:invalid|authenticating) user (\S*) (\S+) port \d+ \[preauth\]|Disconnected from (?:invalid|authenticating) user (\S*) (\S+) port \d+ \[preauth\])/;
const SUDO_FAILED =
  /^\s*(\S+) : (?:\d+ incorrect password attempts?|user NOT in sudoers|command not allowed)/;

/**
 * SSH failures and logins, and refused sudo, from auth.log / secure / the
 * journal. One connection that only shows "Invalid user" or a pre-auth
 * disconnect counts as one attempt; every "Failed password" line counts.
 */
export function parseAuthLog(text: string, remoteNow: number, offsetMinutes: number): AuthEvent[] {
  const events: AuthEvent[] = [];
  /** Connections with a pre-auth failure marker but (so far) no "Failed …" line. */
  const preauth = new Map<string, AuthEvent>();
  const pidsWithFailedLine = new Set<string>();
  for (const line of text.split('\n')) {
    const stamped = parseLogTime(line.trim(), remoteNow, offsetMinutes);
    if (!stamped) continue;
    const sshd = SSHD.exec(stamped.rest);
    if (sshd) {
      const pid = sshd[1]!;
      const message = sshd[2]!;
      const failed = FAILED.exec(message);
      if (failed) {
        pidsWithFailedLine.add(pid);
        events.push({ at: stamped.at, kind: 'failed', user: failed[1] ?? '', ip: failed[2]!, pid });
        continue;
      }
      const accepted = ACCEPTED.exec(message);
      if (accepted) {
        events.push({
          at: stamped.at,
          kind: 'accepted',
          user: accepted[1]!,
          ip: accepted[2]!,
          pid,
        });
        continue;
      }
      const pre = PREAUTH_FAILURE.exec(message);
      if (pre && !preauth.has(pid)) {
        const user = pre[1] ?? pre[3] ?? pre[5] ?? '';
        const ip = pre[2] ?? pre[4] ?? pre[6] ?? null;
        if (ip) preauth.set(pid, { at: stamped.at, kind: 'failed', user, ip, pid });
      }
      continue;
    }
    const sudo = SUDO.exec(stamped.rest);
    if (sudo) {
      const refused = SUDO_FAILED.exec(sudo[1]!);
      if (refused)
        events.push({
          at: stamped.at,
          kind: 'sudo-failed',
          user: refused[1]!,
          ip: null,
          pid: null,
        });
    }
  }
  for (const [pid, event] of preauth) if (!pidsWithFailedLine.has(pid)) events.push(event);
  return events.sort((a, b) => a.at - b.at);
}

export function parsePasswd(text: string): PasswdEntry[] {
  const entries: PasswdEntry[] = [];
  for (const line of text.split('\n')) {
    const [name, uid, shell] = line.trim().split(':');
    if (!name || uid === undefined || !/^\d+$/.test(uid)) continue;
    entries.push({ name, uid: Number(uid), shell: shell ?? '' });
  }
  return entries;
}

const toMs = (value: unknown): number => {
  const at = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(at) ? at : 0;
};

interface RawCrowdsecAlert {
  id?: number;
  scenario?: string;
  message?: string;
  events_count?: number;
  start_at?: string;
  stop_at?: string;
  created_at?: string;
  source?: { ip?: string; value?: string; scope?: string; cn?: string };
  decisions?: { value?: string; type?: string; duration?: string; scope?: string }[] | null;
}

function parseJsonArray(text: string): RawCrowdsecAlert[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed === 'null') return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? (parsed as RawCrowdsecAlert[]) : [];
  } catch {
    return [];
  }
}

/** `cscli alerts list -o json`: one entry per alert (scenario, source IP, event count). */
export function parseCrowdsecAlerts(text: string): CrowdsecAlert[] {
  return parseJsonArray(text)
    .filter((alert) => typeof alert.scenario === 'string')
    .map((alert) => ({
      id: Number(alert.id ?? 0),
      scenario: alert.scenario!,
      message: alert.message ?? '',
      ip: alert.source?.ip ?? (alert.source?.scope === 'Ip' ? (alert.source.value ?? null) : null),
      country: alert.source?.cn ?? null,
      events: Number(alert.events_count ?? 0),
      startAt: toMs(alert.start_at ?? alert.created_at),
      stopAt: toMs(alert.stop_at ?? alert.created_at),
    }));
}

/** `cscli decisions list -o json`: the IPs CrowdSec is blocking right now. */
export function parseCrowdsecDecisions(text: string): string[] {
  const ips = new Set<string>();
  for (const alert of parseJsonArray(text)) {
    for (const decision of alert.decisions ?? []) {
      if (decision.value && (decision.scope ?? 'Ip').toLowerCase() === 'ip')
        ips.add(decision.value);
    }
  }
  return [...ips];
}

/** `fail2ban-client status <jail>` for every jail, each after an `@@jail` line. */
export function parseFail2ban(text: string): Fail2banJail[] {
  const jails: Fail2banJail[] = [];
  let jail: Fail2banJail | null = null;
  const number = (line: string) => Number(/:\s*(\d+)/.exec(line)?.[1] ?? 0);
  for (const line of text.split('\n')) {
    if (line.startsWith(SWEEP_JAIL)) {
      jail = {
        name: line.slice(SWEEP_JAIL.length).trim(),
        currentlyFailed: 0,
        totalFailed: 0,
        currentlyBanned: 0,
        totalBanned: 0,
        bannedIps: [],
      };
      jails.push(jail);
      continue;
    }
    if (!jail) continue;
    if (/Currently failed:/.test(line)) jail.currentlyFailed = number(line);
    else if (/Total failed:/.test(line)) jail.totalFailed = number(line);
    else if (/Currently banned:/.test(line)) jail.currentlyBanned = number(line);
    else if (/Total banned:/.test(line)) jail.totalBanned = number(line);
    else if (/Banned IP list:/.test(line)) {
      jail.bannedIps = (line.split(/Banned IP list:/)[1] ?? '').trim().split(/\s+/).filter(Boolean);
    }
  }
  return jails;
}
