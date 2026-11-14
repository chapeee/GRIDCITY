import { z } from 'zod';

/**
 * Runbooks: the commands an operator types a hundred times, saved once and
 * run on one server or on many at once, from the palette or the HUD. They
 * live in runbooks.yaml next to hosts.yaml; a handful of read-only ones ship
 * built in. Every run goes through the same SSH connection as the metrics and
 * lands in the audit log with who ran it and the exit code.
 *
 * A runbook never stores a secret and never runs on its own: the user picks
 * the servers and confirms before anything starts.
 */
export const RunbookMatchSchema = z.object({
  /** Any of these tags on the host. */
  tags: z.array(z.string().min(1)).default([]),
  /** Any of these district names. */
  districts: z.array(z.string().min(1)).default([]),
  /** These host ids exactly. */
  hosts: z.array(z.string().min(1)).default([]),
});
export type RunbookMatch = z.infer<typeof RunbookMatchSchema>;

export const RunbookSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'id may only contain a-z, 0-9, "-" and "_"'),
  name: z.string().min(1).max(80),
  description: z.string().max(300).nullable().default(null),
  /** The shell command, run with `sh -c` as the host user. */
  command: z.string().min(1).max(10_000),
  /** Declares that the command changes nothing; shown on the card and in the audit log. */
  readOnly: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(1).max(600).default(60),
  /** Which hosts it applies to; empty match = every host. */
  match: RunbookMatchSchema.default({ tags: [], districts: [], hosts: [] }),
  /** Shipped with the app (not in your runbooks.yaml). */
  builtin: z.boolean().default(false),
});
export type Runbook = z.infer<typeof RunbookSchema>;
export type RunbookInput = z.input<typeof RunbookSchema>;

/** The result of one runbook (or ad-hoc command) on one host. */
export const RunResultSchema = z.object({
  hostId: z.string(),
  hostName: z.string(),
  ok: z.boolean(),
  exitCode: z.number().int().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  /** Why it did not run at all (not connected, timed out), or null. */
  error: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
});
export type RunResult = z.infer<typeof RunResultSchema>;

/** Does a runbook apply to a host? Empty match means all. */
export function runbookMatches(
  runbook: Pick<Runbook, 'match'>,
  host: { id: string; district: string; tags: readonly string[] },
): boolean {
  const { tags, districts, hosts } = runbook.match;
  if (tags.length === 0 && districts.length === 0 && hosts.length === 0) return true;
  return (
    hosts.includes(host.id) ||
    districts.includes(host.district) ||
    tags.some((tag) => host.tags.includes(tag))
  );
}

/**
 * The runbooks every installation starts with: read-only diagnostics that
 * work on any Linux box without installing anything.
 */
export const BUILTIN_RUNBOOKS: Runbook[] = [
  {
    id: 'top-processes',
    name: 'Top processes',
    description: 'The ten processes using the most CPU and memory right now.',
    command: 'ps -eo pid,user,%cpu,%mem,rss,etime,comm --sort=-%cpu | head -n 11',
  },
  {
    id: 'disk-usage',
    name: 'What fills the disk?',
    description: 'The biggest directories on the root filesystem (takes a moment).',
    command: 'du -xh --max-depth=2 / 2>/dev/null | sort -rh | head -n 25',
    timeoutSeconds: 180,
  },
  {
    id: 'listening-ports',
    name: 'Listening ports',
    description: 'Every TCP and UDP port something listens on, with the process when visible.',
    command: 'ss -Hlntup 2>/dev/null || netstat -lntup 2>/dev/null',
  },
  {
    id: 'failed-services',
    name: 'Failed services',
    description: 'systemd units in the failed state and the last lines of their logs.',
    command:
      'systemctl --failed --no-legend --plain 2>/dev/null; journalctl -p err -n 30 --no-pager 2>/dev/null',
  },
  {
    id: 'containers',
    name: 'Containers',
    description: 'Docker containers with state, uptime and resource usage.',
    command:
      'docker ps -a --format "table {{.Names}}\\t{{.Image}}\\t{{.Status}}" 2>/dev/null && docker stats --no-stream --format "table {{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}" 2>/dev/null',
  },
  {
    id: 'recent-errors',
    name: 'Recent kernel and system errors',
    description: 'The last error-level log lines (journal, or dmesg where there is no journal).',
    command:
      'journalctl -p err -b -n 50 --no-pager 2>/dev/null || dmesg --level=err,crit 2>/dev/null | tail -n 50',
  },
  {
    id: 'pending-updates',
    name: 'List pending updates',
    description:
      'Lists the packages that can be upgraded (apt, dnf or apk). Installs nothing: run the upgrade yourself.',
    command:
      // dnf check-update exits 100 when updates exist, and a missing
      // reboot-required file is the normal case: neither is a failure.
      'if command -v apt >/dev/null; then apt list --upgradable 2>/dev/null | tail -n +2; elif command -v dnf >/dev/null; then dnf -q check-update 2>/dev/null; elif command -v apk >/dev/null; then apk version -l "<" 2>/dev/null; else echo "No apt, dnf or apk here ($(uname -s)): GRIDCITY lists updates on Debian, Ubuntu, Fedora, RHEL and Alpine."; fi; if [ -f /var/run/reboot-required ]; then echo "*** reboot required ***"; fi; true',
    timeoutSeconds: 120,
  },
  {
    id: 'who-is-connected',
    name: 'Who is connected?',
    description: 'Logged-in users and the busiest remote peers by established connections.',
    command:
      'who 2>/dev/null; echo; ss -Htn state established 2>/dev/null | awk \'{print $4}\' | sed "s/:[0-9]*$//" | sort | uniq -c | sort -rn | head -n 15',
  },
  {
    id: 'certificates',
    name: 'TLS certificates on this server',
    description: 'Expiry of the certificates nginx, apache or certbot manage here.',
    command:
      'for f in /etc/letsencrypt/live/*/fullchain.pem /etc/ssl/certs/*.pem /etc/nginx/ssl/*.crt; do [ -f "$f" ] || continue; printf "%s  " "$f"; openssl x509 -enddate -noout -in "$f" 2>/dev/null; done | head -n 40',
  },
  {
    id: 'recent-logins',
    name: 'Recent logins and failures',
    description: 'Who logged in lately, from where, and the latest failed SSH attempts.',
    command:
      'last -a -n 25 2>/dev/null | head -n 26; echo; echo "--- failed SSH logins ---"; (grep -hE "Failed password|Invalid user|authentication failure" /var/log/auth.log /var/log/secure 2>/dev/null || journalctl -u ssh -u sshd --no-pager -n 400 2>/dev/null | grep -E "Failed|Invalid") | tail -n 30',
  },
  {
    id: 'accounts',
    name: 'Accounts with power',
    description: 'Accounts that can log in, accounts with uid 0, and who may use sudo.',
    command:
      'echo "--- can log in ---"; getent passwd | awk -F: \'$7 !~ /(nologin|false|sync|halt|shutdown)$/ {print $1" (uid "$3", "$7")"}\'; echo; echo "--- uid 0 ---"; getent passwd | awk -F: \'$3 == 0 {print $1}\'; echo; echo "--- sudo/wheel/admin groups ---"; getent group sudo wheel admin 2>/dev/null',
  },
  {
    id: 'blocking-status',
    name: 'CrowdSec and Fail2ban status',
    description:
      'What CrowdSec and Fail2ban caught and who they block right now (needs sudo -n for them).',
    command:
      '(sudo -n cscli alerts list -l 15 2>/dev/null || cscli alerts list -l 15 2>/dev/null || echo "CrowdSec: not installed or not readable"); echo; (sudo -n cscli decisions list 2>/dev/null || true); echo; (sudo -n fail2ban-client status sshd 2>/dev/null || fail2ban-client status sshd 2>/dev/null || echo "Fail2ban: not installed or not readable")',
  },
].map((runbook) => RunbookSchema.parse({ ...runbook, readOnly: true, builtin: true }));

/** Built-in runbooks that help look into a kind of finding (servers only). */
export const RUNBOOKS_FOR_FINDING: Record<string, string[]> = {
  'brute-force': ['recent-logins', 'blocking-status', 'who-is-connected'],
  'suspicious-login': ['recent-logins', 'who-is-connected', 'accounts'],
  'new-user': ['accounts', 'recent-logins'],
  privilege: ['accounts', 'recent-logins'],
  'new-port': ['listening-ports', 'top-processes'],
  'vulnerable-package': ['pending-updates'],
  'disk-forecast': ['disk-usage'],
  container: ['containers', 'recent-errors'],
  certificate: ['certificates'],
  backup: ['disk-usage', 'recent-errors'],
};
