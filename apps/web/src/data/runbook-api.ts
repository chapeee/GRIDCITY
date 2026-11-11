import type { RunResult } from '@app/shared';

/** Runbooks and fleet-wide commands: the local server runs them over the existing SSH connections. */

export interface RunResponse {
  command: string;
  runbookId: string | null;
  startedAt: number;
  results: RunResult[];
}

export interface RunRequest {
  runbookId?: string;
  command?: string;
  hostIds: string[];
  timeoutSeconds?: number;
}

export async function runOnServers(body: RunRequest): Promise<RunResponse> {
  const response = await fetch('/api/runbooks/run', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as RunResponse & { error?: string };
  if (!response.ok) throw new Error(json.error ?? `run failed (${response.status})`);
  return json;
}
