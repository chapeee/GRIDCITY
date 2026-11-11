import type { Host, RunResult } from '@app/shared';
import type { ExecResult } from '../ssh/host-connection';

export interface CommandRunnerOptions {
  /** Runs a command on a connected host; rejects when not connected. */
  exec(hostId: string, command: string, timeoutMs: number): Promise<ExecResult>;
  isConnected(hostId: string): boolean;
  /** Hosts worked on at the same time (default 4: gentle on the fleet and the SSH connections). */
  concurrency?: number;
  now?: () => number;
}

/** Output kept per host; a runaway command never floods the browser. */
const MAX_OUTPUT_CHARS = 64_000;

/**
 * Runs one command on many hosts with bounded concurrency and returns one
 * result per host, in the order asked. A host that is not connected gets a
 * result saying so instead of being skipped: the table always answers for
 * every server the user picked.
 */
export async function runOnHosts(
  hosts: readonly Host[],
  command: string,
  timeoutMs: number,
  options: CommandRunnerOptions,
): Promise<RunResult[]> {
  const now = options.now ?? Date.now;
  const results: RunResult[] = new Array(hosts.length);
  let next = 0;
  const worker = async () => {
    while (next < hosts.length) {
      const index = next++;
      const host = hosts[index]!;
      results[index] = await runOnHost(host, command, timeoutMs, options, now);
    }
  };
  const workers = Math.max(1, Math.min(options.concurrency ?? 4, hosts.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

async function runOnHost(
  host: Host,
  command: string,
  timeoutMs: number,
  options: CommandRunnerOptions,
  now: () => number,
): Promise<RunResult> {
  const startedAt = now();
  const base = { hostId: host.id, hostName: host.name, stdout: '', stderr: '' };
  if (!options.isConnected(host.id)) {
    return { ...base, ok: false, exitCode: null, error: 'not connected', durationMs: 0 };
  }
  try {
    const result = await options.exec(host.id, command, timeoutMs);
    return {
      ...base,
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
      error: null,
      durationMs: now() - startedAt,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      exitCode: null,
      error: (error as Error).message,
      durationMs: now() - startedAt,
    };
  }
}

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = text.slice(0, MAX_OUTPUT_CHARS / 2);
  const tail = text.slice(-MAX_OUTPUT_CHARS / 2);
  return `${head}\n… ${text.length - MAX_OUTPUT_CHARS} characters left out …\n${tail}`;
}
