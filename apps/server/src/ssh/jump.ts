import type { Host } from '@app/shared';
import type { Duplex } from 'node:stream';
import ssh2, { type Client } from 'ssh2';
import type { SshAuthOptions } from './auth-options';
import { describeConnectionError, type HostKeyRefusal } from './host-connection';
import {
  fingerprintSha256,
  knownHostsName,
  preferredHostKeyAlgorithms,
  presentedKeyFromBlob,
  verifyHostKey,
  type KnownHostEntry,
} from './known-hosts';

/**
 * Jump hosts (bastions), like `ssh -J`: connect to the bastion with strict
 * host key checking, then open a direct-tcpip tunnel to the real server.
 * The server's own SSH session runs end to end over that tunnel, so the
 * bastion never sees its keys or traffic in the clear.
 */

/** The jump host refused by known_hosts (unknown or changed key). */
export class JumpHostKeyError extends Error {
  override name = 'JumpHostKeyError';
  constructor(
    message: string,
    readonly refusal: HostKeyRefusal,
  ) {
    super(message);
  }
}

/** A host's jump settings as a Host, so the usual auth builder can serve it. */
export function jumpAsHost(host: Host): Host {
  if (!host.jump) throw new Error(`${host.id} has no jump host`);
  return {
    ...host,
    id: `${host.id}-jump`,
    address: host.jump.address,
    port: host.jump.port,
    user: host.jump.user,
    auth: host.jump.auth,
    jump: undefined,
  };
}

export interface JumpTunnel {
  /** Pass as `sock` to the server connection. */
  sock: Duplex;
  /** The bastion connection; end it when the server connection closes. */
  client: Client;
}

export function openThroughJump(options: {
  jump: Pick<Host, 'address' | 'port' | 'user'>;
  auth: SshAuthOptions;
  knownHosts: readonly KnownHostEntry[];
  destination: { address: string; port: number };
  readyTimeoutMs?: number;
  createClient?: () => Client;
}): Promise<JumpTunnel> {
  const { jump, destination } = options;
  const lookupName = knownHostsName(jump.address, jump.port);
  const label = `jump host ${jump.user}@${jump.address}${jump.port === 22 ? '' : `:${jump.port}`}`;

  return new Promise((resolve, reject) => {
    const client = (options.createClient ?? (() => new ssh2.Client()))();
    let settled = false;
    let refusal: JumpHostKeyError | null = null;
    let lastError: (Error & { code?: string; level?: string }) | null = null;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(error);
    };

    client.on('error', (error) => (lastError = error));
    client.on('close', () => {
      if (refusal) return fail(refusal);
      fail(
        new Error(
          `${label}: ${
            lastError
              ? describeConnectionError(lastError, { ...jump } as Host)
              : 'connection closed'
          }`,
        ),
      );
    });
    client.on('ready', () => {
      client.forwardOut('127.0.0.1', 0, destination.address, destination.port, (error, stream) => {
        if (error) {
          return fail(
            new Error(
              `${label} could not reach ${destination.address}:${destination.port} (${error.message}).`,
            ),
          );
        }
        settled = true;
        resolve({ sock: stream, client });
      });
    });

    const preferred = preferredHostKeyAlgorithms(options.knownHosts, lookupName);
    client.connect({
      host: jump.address,
      port: jump.port,
      username: jump.user,
      ...options.auth,
      readyTimeout: options.readyTimeoutMs ?? 10_000,
      keepaliveInterval: 5000,
      keepaliveCountMax: 3,
      hostVerifier: (blob: Buffer) => {
        const presented = presentedKeyFromBlob(blob);
        const { verdict } = verifyHostKey(options.knownHosts, lookupName, presented);
        if (verdict === 'trusted') return true;
        const fingerprint = fingerprintSha256(blob);
        refusal = new JumpHostKeyError(
          verdict === 'unknown'
            ? `The ${label} is not trusted yet (${presented.keyType} ${fingerprint}).`
            : `The ${label} presented a CHANGED or revoked key (${fingerprint}). Refusing to connect.`,
          { reason: verdict === 'unknown' ? 'unknown' : 'changed', fingerprint },
        );
        return false;
      },
      ...(preferred ? { algorithms: { serverHostKey: preferred as never } } : {}),
    });
  });
}
