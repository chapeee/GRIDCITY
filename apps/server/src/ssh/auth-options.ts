import type { HostAuth } from '@app/shared';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
// ssh2 is CommonJS; plain Node ESM only exposes its default export.
import ssh2 from 'ssh2';
import { expandHome } from '../config/app-paths';

/** Windows ships OpenSSH's agent as a named pipe instead of SSH_AUTH_SOCK. */
export const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

/** The ssh-agent to use: SSH_AUTH_SOCK, or the Windows OpenSSH pipe. */
export function defaultAgentSocket(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string | undefined {
  return env.SSH_AUTH_SOCK ?? (platform === 'win32' ? WINDOWS_OPENSSH_AGENT_PIPE : undefined);
}

/** Authentication options passed to ssh2. Held in memory only for the connect call. */
export interface SshAuthOptions {
  agent?: string;
  privateKey?: Buffer;
}

export interface AuthContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
  /**
   * The SSH folder the app manages (SSH_DIR, ~/.ssh by default). Key paths
   * written as "~/.ssh/<name>" resolve here, so hosts.yaml stays valid when
   * the folder lives elsewhere (Docker keeps it on the data volume).
   */
  sshDir?: string;
  readKeyFile?: (path: string) => Promise<Buffer>;
}

/**
 * Where a configured key file really is. "~/.ssh/name" means the managed SSH
 * folder. An absolute path that no longer exists falls back to a file of the
 * same name in that folder (configs written before the folder moved).
 */
export function resolveKeyPath(
  configured: string,
  context: Pick<AuthContext, 'homeDir' | 'sshDir'>,
): string {
  const normalized = configured.replace(/\\/g, '/');
  if (context.sshDir && normalized.startsWith('~/.ssh/')) {
    return join(context.sshDir, normalized.slice('~/.ssh/'.length));
  }
  const expanded = expandHome(configured, context.homeDir);
  if (context.sshDir && !existsSync(expanded)) {
    const moved = join(context.sshDir, basename(normalized));
    if (existsSync(moved)) return moved;
  }
  return expanded;
}

/** A setup problem the user must fix; the message is shown in the HUD. */
export class AuthSetupError extends Error {
  override name = 'AuthSetupError';
}

/**
 * Builds ssh2 auth options. Private keys are read from disk at connect time
 * and never copied, logged or stored; error messages never include key data.
 */
export async function buildAuthOptions(
  auth: HostAuth,
  context: AuthContext,
): Promise<SshAuthOptions> {
  if (auth.method === 'agent') {
    const agent =
      context.env.SSH_AUTH_SOCK ??
      (context.platform === 'win32' ? WINDOWS_OPENSSH_AGENT_PIPE : undefined);
    if (!agent) {
      throw new AuthSetupError(
        'No ssh-agent found (SSH_AUTH_SOCK is not set). Start ssh-agent and add your key, or use keyFile auth.',
      );
    }
    return { agent };
  }

  const keyPath = resolveKeyPath(auth.path, context);
  let privateKey: Buffer;
  try {
    privateKey = await (context.readKeyFile ?? readFile)(keyPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'read error';
    throw new AuthSetupError(`Cannot read key file ${keyPath} (${code}).`);
  }

  const parsed = ssh2.utils.parseKey(privateKey);
  if (parsed instanceof Error) {
    const encrypted = /passphrase|encrypted/i.test(parsed.message);
    throw new AuthSetupError(
      encrypted
        ? `Key file ${keyPath} is passphrase-protected. Passphrases are never stored: add the key to ssh-agent (ssh-add) and use agent auth.`
        : `Key file ${keyPath} is not a supported private key.`,
    );
  }
  return { privateKey };
}
