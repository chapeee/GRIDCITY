import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';

const run = promisify(execFile);

export class KeyExistsError extends Error {
  override name = 'KeyExistsError';
}

export interface GeneratedKey {
  privatePath: string;
  publicPath: string;
}

/**
 * Creates a new key pair in the user's SSH directory, exactly where and how
 * `ssh-keygen` would. Never overwrites an existing file. The key has no
 * passphrase so it also works where no ssh-agent is available (Docker on
 * Windows); it only grants access to servers it is installed on.
 *
 * Uses the system `ssh-keygen` (ed25519). If OpenSSH is not installed, falls
 * back to an ECDSA key generated in-process.
 */
export async function generateKey(options: {
  sshDir: string;
  /** Base file name, e.g. "example_ed25519" (derived from PROJECT_NAME). */
  baseName: string;
  comment: string;
}): Promise<GeneratedKey> {
  await mkdir(options.sshDir, { recursive: true, mode: 0o700 });

  const privatePath = join(options.sshDir, options.baseName);
  const publicPath = `${privatePath}.pub`;
  if (existsSync(privatePath) || existsSync(publicPath)) {
    throw new KeyExistsError(`${privatePath} already exists; it is listed with your keys.`);
  }

  try {
    // execFile passes '' as a real empty argument: no passphrase, no shell quoting issues.
    await run(
      'ssh-keygen',
      ['-t', 'ed25519', '-N', '', '-C', options.comment, '-f', privatePath, '-q'],
      {
        timeout: 15_000,
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(`ssh-keygen failed: ${(error as Error).message}`, { cause: error });
    }
    // No OpenSSH client installed: generate in-process (ECDSA; ssh2's ed25519 output is unreliable).
    const pair = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256, comment: options.comment });
    await writeFile(privatePath, `${pair.private}\n`, { mode: 0o600, flag: 'wx' });
    await writeFile(publicPath, `${pair.public}\n`, { mode: 0o644, flag: 'wx' });
  }

  await chmod(privatePath, 0o600).catch(() => {}); // best effort on Windows
  const check = ssh2.utils.parseKey(await readFile(privatePath));
  if (check instanceof Error)
    throw new Error(`The new key could not be read back: ${check.message}`);
  return { privatePath, publicPath };
}
