import type { Host } from '@app/shared';
import { z } from 'zod';
import type { SweepRunner } from '../threats/threat-hub';

export const LogSearchSchema = z.strictObject({
  query: z.string().trim().min(2).max(200),
  /** Empty: every connected server. */
  hostIds: z.array(z.string().min(1)).max(200).default([]),
  since: z.enum(['15m', '1h', '6h', '24h', '7d']).default('1h'),
  regex: z.boolean().default(false),
  sources: z
    .array(z.enum(['journal', 'files', 'containers']))
    .min(1)
    .default(['journal', 'files', 'containers']),
  /** Lines per server. */
  limit: z.number().int().min(10).max(1000).default(200),
});
export type LogSearch = z.infer<typeof LogSearchSchema>;

export interface LogLine {
  source: string;
  text: string;
}

export interface HostLogResult {
  hostId: string;
  hostName: string;
  ok: boolean;
  lines: LogLine[];
  truncated: boolean;
  notes: string[];
}

const SINCE: Record<LogSearch['since'], { journal: string; docker: string; minutes: number }> = {
  '15m': { journal: '-15min', docker: '15m', minutes: 15 },
  '1h': { journal: '-1h', docker: '1h', minutes: 60 },
  '6h': { journal: '-6h', docker: '6h', minutes: 360 },
  '24h': { journal: '-24h', docker: '24h', minutes: 1440 },
  '7d': { journal: '-7d', docker: '168h', minutes: 10080 },
};

/**
 * The search script. The query travels base64-encoded and is decoded on the
 * server into a variable, so nothing the user types is ever parsed by the
 * shell. grep -F (or -E for regex) reads it with -e, never as an option.
 */
export function logSearchScript(search: LogSearch): string {
  const encoded = Buffer.from(search.query, 'utf8').toString('base64');
  const mode = search.regex ? '-E' : '-F';
  const since = SINCE[search.since];
  const limit = search.limit;
  const parts = [
    'export LC_ALL=C',
    `P=$(printf '%s' '${encoded}' | base64 -d 2>/dev/null)`,
    `[ -n "$P" ] || { echo '@@note cannot decode the search (base64 missing)'; echo '@@end'; exit 0; }`,
  ];
  if (search.sources.includes('journal')) {
    parts.push(
      `echo '@@source journal'`,
      `if command -v journalctl >/dev/null 2>&1 && { [ "$(id -u)" = 0 ] || id -nG 2>/dev/null | grep -qwE 'systemd-journal|adm|wheel'; }; then journalctl --no-pager -q -o short-iso --since '${since.journal}' 2>/dev/null | grep -i ${mode} -e "$P" | tail -n ${limit}; elif command -v journalctl >/dev/null 2>&1; then echo '@@note journal: this user may not read the system journal (add it to the systemd-journal or adm group)'; else echo '@@note journal: not available'; fi`,
    );
  }
  if (search.sources.includes('files')) {
    parts.push(
      `echo '@@source files'`,
      // Only files changed within the window; each match keeps its file name.
      `find /var/log -maxdepth 2 -type f \\( -name '*.log' -o -name syslog -o -name messages -o -name secure -o -name auth.log \\) -mmin -${since.minutes} -readable 2>/dev/null | head -n 60 | while read -r f; do grep -H -i ${mode} -e "$P" "$f" 2>/dev/null | tail -n 50; done | tail -n ${limit}`,
    );
  }
  if (search.sources.includes('containers')) {
    parts.push(
      `echo '@@source containers'`,
      `if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then for c in $(docker ps --format '{{.Names}}' 2>/dev/null | head -n 50); do docker logs --since ${since.docker} --tail 5000 "$c" 2>&1 | grep -i ${mode} -e "$P" | tail -n 30 | sed "s|^|$c: |"; done | tail -n ${limit}; elif command -v docker >/dev/null 2>&1; then echo '@@note containers: this user may not use docker'; fi`,
    );
  }
  parts.push(`echo '@@end'`);
  return `${parts.join('\n')}\n`;
}

export function parseLogSearch(
  output: string,
  limit: number,
): { lines: LogLine[]; notes: string[]; complete: boolean; truncated: boolean } {
  const lines: LogLine[] = [];
  const notes: string[] = [];
  let source = 'log';
  const counts = new Map<string, number>();
  for (const raw of output.replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('@@source ')) {
      source = raw.slice(9).trim();
      continue;
    }
    if (raw.startsWith('@@note ')) {
      notes.push(raw.slice(7).trim());
      continue;
    }
    if (raw === '@@end' || !raw.trim()) continue;
    counts.set(source, (counts.get(source) ?? 0) + 1);
    lines.push({ source, text: raw.length > 2000 ? `${raw.slice(0, 2000)}…` : raw });
  }
  return {
    lines,
    notes,
    complete: output.includes('@@end'),
    truncated: [...counts.values()].some((count) => count >= limit),
  };
}

/** Runs one search on every chosen, connected server at once. */
export async function searchLogs(
  search: LogSearch,
  hosts: readonly Host[],
  runnerFor: (hostId: string) => SweepRunner | undefined,
): Promise<HostLogResult[]> {
  const chosen =
    search.hostIds.length > 0 ? hosts.filter((h) => search.hostIds.includes(h.id)) : hosts;
  const script = logSearchScript(search);
  return Promise.all(
    chosen.map(async (host): Promise<HostLogResult> => {
      const runner = runnerFor(host.id);
      if (!runner) {
        return {
          hostId: host.id,
          hostName: host.name,
          ok: false,
          lines: [],
          truncated: false,
          notes: ['not connected'],
        };
      }
      try {
        const { stdout } = await runner.exec('sh -s', script, 45_000);
        const parsed = parseLogSearch(stdout, search.limit);
        return {
          hostId: host.id,
          hostName: host.name,
          ok: parsed.complete,
          lines: parsed.lines,
          truncated: parsed.truncated,
          notes: parsed.complete
            ? parsed.notes
            : [...parsed.notes, 'the search did not finish in 45 s; showing what came back'],
        };
      } catch (error) {
        return {
          hostId: host.id,
          hostName: host.name,
          ok: false,
          lines: [],
          truncated: false,
          notes: [(error as Error).message],
        };
      }
    }),
  );
}
