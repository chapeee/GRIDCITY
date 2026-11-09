import type { ConnectionPhase, Host } from '@app/shared';
// ssh2 is CommonJS; plain Node ESM only exposes its default export.
import ssh2, { type Client, type ConnectConfig } from 'ssh2';
import type { SshAuthOptions } from './auth-options';
import { backoffDelayMs, DEFAULT_BACKOFF, type BackoffOptions } from './backoff';
import {
  fingerprintSha256,
  knownHostsName,
  preferredHostKeyAlgorithms,
  presentedKeyFromBlob,
  verifyHostKey,
  type KnownHostEntry,
} from './known-hosts';

export interface HostKeyRefusal {
  reason: 'unknown' | 'changed';
  fingerprint: string;
}

export interface PhaseChange {
  phase: ConnectionPhase;
  /** Human-readable reason for `failed`. */
  error: string | null;
  /** Set when the failure is a refused host key. */
  hostKeyRefusal: HostKeyRefusal | null;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface HostConnectionOptions {
  host: Host;
  /** Read on every attempt, so fixing known_hosts takes effect on the next retry. */
  loadKnownHosts(): KnownHostEntry[];
  buildAuth(host: Host): Promise<SshAuthOptions>;
  onPhaseChange(change: PhaseChange): void;
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  readyTimeoutMs?: number;
  backoff?: BackoffOptions;
  /** For tests. */
  createClient?: () => Client;
}

/** Output beyond this is cut off; the collector script prints a few KiB. */
const MAX_EXEC_OUTPUT_BYTES = 1024 * 1024;

/**
 * One persistent SSH connection to one host: keepalive, exponential backoff
 * reconnect, strict host key checking. Never auto-accepts a host key.
 */
export class HostConnection {
  private client: Client | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private stopped = true;
  private currentPhase: ConnectionPhase = 'connecting';
  private lastError: string | null = null;
  private refusal: HostKeyRefusal | null = null;

  constructor(private readonly options: HostConnectionOptions) {}

  get phase(): ConnectionPhase {
    return this.currentPhase;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.client?.end();
    this.client = null;
  }

  /** Drops the current connection (tests and "reconnect now"); backoff then reconnects. */
  dropConnection(): void {
    this.client?.end();
  }

  /** Runs a command on the open connection, writing `stdin` to it. */
  exec(command: string, stdin: string, timeoutMs: number): Promise<ExecResult> {
    const client = this.client;
    if (!client || this.currentPhase !== 'connected') {
      return Promise.reject(new Error('not connected'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let closeChannel: (() => void) | null = null;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        action();
      };
      // A hung command must not block polling forever: close its channel and fail.
      const timer = setTimeout(() => {
        closeChannel?.();
        finish(() => reject(new Error(`command timed out after ${timeoutMs} ms`)));
      }, timeoutMs);

      client.exec(command, (error, stream) => {
        if (error) return finish(() => reject(error));
        closeChannel = () => stream.close();
        let stdout = '';
        let stderr = '';
        stream.on('data', (chunk: Buffer) => {
          if (stdout.length < MAX_EXEC_OUTPUT_BYTES) stdout += chunk.toString('utf8');
        });
        stream.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < MAX_EXEC_OUTPUT_BYTES) stderr += chunk.toString('utf8');
        });
        stream.on('close', (code: number | null) =>
          finish(() => resolve({ stdout, stderr, exitCode: code ?? null })),
        );
        stream.end(stdin);
      });
    });
  }

  private setPhase(phase: ConnectionPhase): void {
    this.currentPhase = phase;
    this.options.onPhaseChange({
      phase,
      error: phase === 'failed' ? (this.lastError ?? 'connection closed') : null,
      hostKeyRefusal: phase === 'failed' ? this.refusal : null,
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const { host } = this.options;
    this.lastError = null;
    this.refusal = null;
    this.setPhase('connecting');

    let auth: SshAuthOptions;
    try {
      auth = await this.options.buildAuth(host);
    } catch (error) {
      this.lastError = (error as Error).message;
      this.setPhase('failed');
      this.scheduleRetry();
      return;
    }
    if (this.stopped) return;

    const lookupName = knownHostsName(host.address, host.port);
    const knownHosts = this.options.loadKnownHosts();
    const preferredAlgorithms = preferredHostKeyAlgorithms(knownHosts, lookupName);

    const client = (this.options.createClient ?? (() => new ssh2.Client()))();
    this.client = client;
    let closed = false;

    client.on('ready', () => {
      this.attempt = 0;
      this.setPhase('connected');
    });
    client.on('error', (error: Error & { level?: string }) => {
      // A refused host key surfaces as a generic error; keep our clearer message.
      if (!this.refusal) this.lastError = describeConnectionError(error, host);
    });
    client.on('close', () => {
      if (closed) return;
      closed = true;
      if (this.client === client) this.client = null;
      if (this.stopped) return;
      this.setPhase('failed');
      this.scheduleRetry();
    });

    const config: ConnectConfig = {
      host: host.address,
      port: host.port,
      username: host.user,
      ...auth,
      readyTimeout: this.options.readyTimeoutMs ?? 10_000,
      keepaliveInterval: this.options.keepaliveIntervalMs ?? 5000,
      keepaliveCountMax: this.options.keepaliveCountMax ?? 3,
      hostVerifier: (keyBlob: Buffer) => {
        const presented = presentedKeyFromBlob(keyBlob);
        const { verdict } = verifyHostKey(knownHosts, lookupName, presented);
        if (verdict === 'trusted') return true;
        const fingerprint = fingerprintSha256(keyBlob);
        this.refusal = { reason: verdict === 'unknown' ? 'unknown' : 'changed', fingerprint };
        this.lastError =
          verdict === 'unknown'
            ? `Host key not in known_hosts (${presented.keyType} ${fingerprint}). Verify the fingerprint out of band, then connect once with ssh to trust it.`
            : verdict === 'revoked'
              ? `Host key is revoked in known_hosts (${fingerprint}). Refusing to connect.`
              : `HOST KEY CHANGED for ${lookupName} (${presented.keyType} ${fingerprint}). This could be a man-in-the-middle attack. Refusing to connect.`;
        return false;
      },
      ...(preferredAlgorithms
        ? { algorithms: { serverHostKey: preferredAlgorithms as never } }
        : {}),
    };

    try {
      client.connect(config);
    } catch (error) {
      this.lastError = (error as Error).message;
      closed = true;
      this.client = null;
      this.setPhase('failed');
      this.scheduleRetry();
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const backoff = this.options.backoff ?? DEFAULT_BACKOFF;
    // A refused host key will not fix itself quickly: retry at the slowest pace.
    const delay = this.refusal ? backoff.maxMs : backoffDelayMs(this.attempt++, backoff);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }
}

/** Turns low-level errors into messages a user can act on. */
export function describeConnectionError(
  error: Error & { code?: string; level?: string },
  host: Host,
): string {
  const target = `${host.address}:${host.port}`;
  switch (error.code) {
    case 'ECONNREFUSED':
      return `connect ECONNREFUSED ${target} (no SSH server listening?)`;
    case 'ETIMEDOUT':
      return `connect ETIMEDOUT ${target}`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `cannot resolve host "${host.address}"`;
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `host ${target} unreachable`;
  }
  if (/keepalive timeout/i.test(error.message)) return 'heartbeat lost (keepalive timeout)';
  if (/timed out while waiting for handshake/i.test(error.message))
    return `SSH handshake timed out (${target})`;
  if (error.level === 'client-authentication') {
    return `authentication failed for ${host.user}@${target} (key not accepted)`;
  }
  return error.message;
}
