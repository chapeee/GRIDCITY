/**
 * Calls to the local server's JSON API. The session cookie travels
 * automatically (same origin); the browser adds the Origin header the server
 * requires on writes.
 */

export interface ServerMeta {
  projectName: string;
  version: string;
  protocolVersion: number;
  dataMode?: 'real' | 'demo';
  /** Where hosts.yaml lives (real mode), shown in the empty-fleet screen. */
  hostsFile?: string;
}

export interface ImportReport {
  added: string[];
  skipped: { alias: string; reason: string }[];
  warnings: string[];
  hostsFile: string;
}

export interface AuditEntry {
  id: number;
  at: number;
  kind: string;
  hostId: string | null;
  detail: string | null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `${path} failed (${response.status})`);
  return body;
}

export const fetchMeta = () => request<ServerMeta>('/api/meta');

export const importSshConfig = () =>
  request<ImportReport>('/api/hosts/import-ssh-config', { method: 'POST' });

export const fetchAuditLog = (limit = 200) =>
  request<{ entries: AuditEntry[] }>(`/api/audit?limit=${limit}`).then((body) => body.entries);

/**
 * Trades the `?token=` from the printed URL for the session cookie, then
 * removes it from the address bar so it does not linger in history or
 * screenshots. In production the page request itself already set the cookie;
 * in development the page comes from Vite, so this call does it.
 */
export async function establishSession(): Promise<void> {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('token');
  if (!token) return;
  try {
    await fetch(`/api/meta?token=${encodeURIComponent(token)}`, { credentials: 'same-origin' });
  } catch {
    // Server not reachable yet: the link indicator will say so.
  }
  url.searchParams.delete('token');
  window.history.replaceState(null, '', url);
}
