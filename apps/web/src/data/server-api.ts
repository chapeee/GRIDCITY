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

/** What the "Add host" dialog sends; the server derives everything else. */
export interface HostDraft {
  /** As typed: "root@192.168.1.155", "ops@box.lan:2222". */
  target: string;
  name?: string;
  district?: string;
  auth?: { method: 'agent' } | { method: 'keyFile'; path: string };
}

export interface DraftHost {
  id: string;
  name: string;
  address: string;
  port: number;
  user: string;
}

export interface HostTestResponse {
  host: DraftHost;
  result:
    | { ok: true }
    | {
        ok: false;
        problem: 'host-key' | 'auth' | 'unreachable' | 'other';
        message: string;
        hostKeyRefusal: { reason: 'unknown' | 'changed'; fingerprint: string } | null;
      };
  /** Next steps with commands for the server's OS. */
  advice: string[];
}

const postJson = <T>(path: string, body: unknown) =>
  request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Tests an SSH connection with the city's exact checks. Saves nothing. */
export const testHost = (draft: HostDraft) => postJson<HostTestResponse>('/api/hosts/test', draft);

/** Appends the host to hosts.yaml; the city reloads it live. */
export const addHost = (draft: HostDraft) =>
  postJson<{ host: DraftHost; demoMode: boolean }>('/api/hosts', draft);

// ---- "Connect a server" flow ----------------------------------------------

/** A key the server found in ssh-agent or ~/.ssh (public half only). */
export interface LocalKey {
  id: string;
  source: 'agent' | 'file';
  label: string;
  keyType: string;
  fingerprint: string;
  privatePath?: string;
  usable: boolean;
  note?: string;
}

export interface HostKeyProbe {
  endpoint: { address: string; port: number; user: string };
  keyType: string;
  fingerprint: string;
  /** Against known_hosts: trusted, unknown (never seen), changed or revoked. */
  trust: 'trusted' | 'unknown' | 'changed' | 'revoked';
}

export const listKeys = () => request<{ keys: LocalKey[]; sshDir: string }>('/api/ssh/keys');

/** Creates a new key pair in the user's SSH directory (never overwrites). */
export const createKey = () => postJson<{ key?: LocalKey }>('/api/ssh/keys', {});

/**
 * Uploads a private key the user already has (.pem, .ppk, OpenSSH) into
 * their SSH folder. PuTTY keys are converted; only the public half comes back.
 */
export const importKey = (fileName: string, content: string) =>
  postJson<{ key?: LocalKey; created: boolean }>('/api/ssh/keys/import', { fileName, content });

/** Reads the server's host key fingerprint without logging in. */
export const probeHost = (target: string) =>
  postJson<HostKeyProbe>('/api/connect/probe', { target });

/** Adds the host key to known_hosts after the user confirmed this fingerprint. */
export const trustHost = (target: string, fingerprint: string) =>
  postJson<{ result: 'added' | 'already-trusted' }>('/api/connect/trust', { target, fingerprint });

/** Installs the chosen public key on the server using the password once (never stored). */
export const installKey = (target: string, keyId: string, password: string) =>
  postJson<{ installed: true }>('/api/connect/install', { target, keyId, password });

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
