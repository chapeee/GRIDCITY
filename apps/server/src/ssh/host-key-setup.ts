import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';
import ssh2 from 'ssh2';
import { describeConnectionError } from './host-connection';
import {
  fingerprintSha256,
  knownHostsName,
  presentedKeyFromBlob,
  verifyHostKey,
  type KnownHostEntry,
} from './known-hosts';

export interface ProbedHostKey {
  keyType: string;
  keyBase64: string;
  fingerprint: string;
}

export interface HostEndpoint {
  address: string;
  port: number;
  user: string;
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * Reads the key a server presents, then refuses the connection: no login is
 * attempted and nothing runs on the host. Used to show the fingerprint the
 * user is asked to confirm.
 */
/** Opens a fresh tunnel to the server (through a jump host), or null for direct. */
export type OpenSocket = () => Promise<Duplex>;

export async function probeHostKey(
  endpoint: HostEndpoint,
  openSocket?: OpenSocket,
): Promise<ProbedHostKey> {
  const sock = openSocket ? await openSocket() : undefined;
  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let captured: ProbedHostKey | null = null;
    let lastError: Error | null = null;
    client.on('error', (error) => (lastError = error));
    client.on('close', () => {
      if (captured) resolve(captured);
      else {
        const error = (lastError ?? new Error('connection closed')) as Error & { code?: string };
        reject(new Error(describeConnectionError(error, { ...endpoint } as never)));
      }
    });
    client.connect({
      host: endpoint.address,
      port: endpoint.port,
      username: endpoint.user,
      ...(sock ? { sock } : {}),
      readyTimeout: PROBE_TIMEOUT_MS,
      hostVerifier: (blob: Buffer) => {
        const presented = presentedKeyFromBlob(blob);
        captured = { ...presented, fingerprint: fingerprintSha256(blob) };
        return false; // stop here: we only wanted the key
      },
    });
  });
}

export class HostKeyMismatchError extends Error {
  override name = 'HostKeyMismatchError';
}

/**
 * Adds a server's key to known_hosts after the user confirmed its
 * fingerprint. Safety rules:
 * - the key is probed again and must still match the confirmed fingerprint;
 * - an already trusted key is left alone;
 * - a host already known with a DIFFERENT key is never overwritten here
 *   (that is the man-in-the-middle case; the user resolves it manually).
 */
export async function trustHostKey(options: {
  endpoint: HostEndpoint;
  confirmedFingerprint: string;
  knownHosts: readonly KnownHostEntry[];
  knownHostsFile: string;
  /** For a server behind a jump host. */
  openSocket?: OpenSocket;
}): Promise<'added' | 'already-trusted'> {
  const { endpoint } = options;
  const probed = await probeHostKey(endpoint, options.openSocket);
  if (probed.fingerprint !== options.confirmedFingerprint) {
    throw new HostKeyMismatchError(
      `The server now presents ${probed.fingerprint}, not the ${options.confirmedFingerprint} you confirmed. Nothing was trusted.`,
    );
  }

  const lookupName = knownHostsName(endpoint.address, endpoint.port);
  const { verdict } = verifyHostKey(options.knownHosts, lookupName, probed);
  if (verdict === 'trusted') return 'already-trusted';
  if (verdict !== 'unknown') {
    throw new HostKeyMismatchError(
      `known_hosts already has a different key for ${lookupName}. The app never replaces a known key; verify the change and remove the old entry with: ssh-keygen -R ${lookupName}`,
    );
  }

  await mkdir(dirname(options.knownHostsFile), { recursive: true, mode: 0o700 });
  const existing = existsSync(options.knownHostsFile)
    ? await readFile(options.knownHostsFile, 'utf8')
    : '';
  const separator = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  await appendFile(
    options.knownHostsFile,
    `${separator}${lookupName} ${probed.keyType} ${probed.keyBase64}\n`,
    { mode: 0o644 },
  );
  return 'added';
}

/**
 * Runs on the server with the public key on stdin: creates ~/.ssh with safe
 * permissions and appends the key only if it is not already there.
 */
const INSTALL_SCRIPT =
  'umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && ' +
  'key=$(cat) && { grep -qxF "$key" ~/.ssh/authorized_keys || printf "%s\\n" "$key" >> ~/.ssh/authorized_keys; }';

export class PasswordRejectedError extends Error {
  override name = 'PasswordRejectedError';
}

/**
 * Installs a public key on the server using the account password ONCE.
 * The password lives only in this call's memory: it is never stored, logged
 * or included in any message. The host key is verified against known_hosts
 * first, so the password is never sent to an untrusted server.
 */
export function installPublicKey(options: {
  endpoint: HostEndpoint;
  publicKey: string;
  password: string;
  knownHosts: readonly KnownHostEntry[];
}): Promise<void> {
  const { endpoint, password } = options;
  const lookupName = knownHostsName(endpoint.address, endpoint.port);

  return new Promise((resolve, reject) => {
    const client = new ssh2.Client();
    let settled = false;
    let hostKeyProblem: string | null = null;
    let lastError: (Error & { level?: string; code?: string }) | null = null;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      client.end();
      if (error) reject(error);
      else resolve();
    };

    client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, answer) =>
      answer(prompts.map(() => password)),
    );
    client.on('error', (error) => (lastError = error));
    client.on('close', () => {
      if (hostKeyProblem) return finish(new HostKeyMismatchError(hostKeyProblem));
      if (lastError?.level === 'client-authentication') {
        return finish(new PasswordRejectedError('The server rejected the password.'));
      }
      finish(
        new Error(
          lastError
            ? describeConnectionError(lastError, { ...endpoint } as never)
            : 'connection closed before the key was installed',
        ),
      );
    });

    client.on('ready', () => {
      client.exec(INSTALL_SCRIPT, (error, stream) => {
        if (error) return finish(new Error(`Could not run the install command: ${error.message}`));
        let stderr = '';
        stream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        // Stdout must be consumed, or the stream never ends and 'close' never fires.
        stream.resume();
        stream.on('close', (code: number | null) => {
          if (code === 0) finish();
          else
            finish(
              new Error(
                `Installing the key failed (exit ${code ?? '?'}): ${stderr.trim() || 'no details'}`,
              ),
            );
        });
        stream.end(`${options.publicKey.trim()}\n`);
      });
    });

    client.connect({
      host: endpoint.address,
      port: endpoint.port,
      username: endpoint.user,
      password,
      tryKeyboard: true,
      readyTimeout: PROBE_TIMEOUT_MS,
      hostVerifier: (blob: Buffer) => {
        const { verdict } = verifyHostKey(
          options.knownHosts,
          lookupName,
          presentedKeyFromBlob(blob),
        );
        if (verdict === 'trusted') return true;
        hostKeyProblem = `The host key for ${lookupName} is not trusted (${verdict}); the password was not sent.`;
        return false;
      },
    });
  });
}
