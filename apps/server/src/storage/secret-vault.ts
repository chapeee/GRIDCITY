import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppDatabase } from './database';

/**
 * Credentials typed in the app (database passwords, access keys, the alert
 * webhook), so nobody has to edit environment variables or files to connect
 * something. Each value is encrypted with AES-256-GCM before it touches the
 * database; the key is 32 random bytes in `vault.key` next to the database
 * (mode 600), or the base64 key in `SECRETS_KEY` when you want it elsewhere.
 *
 * Honest scope: this protects a copied database, a backup or a screen
 * share. Someone who can read your data folder with your user account can
 * read the key too, exactly like a browser's saved passwords without an OS
 * keychain. Values are never logged, audited, sent to the browser or to an AI.
 */
export interface SecretStore {
  get(id: string): string | undefined;
  has(id: string): boolean;
  set(id: string, value: string): void;
  delete(id: string): void;
  /** Removes every secret whose id starts with `prefix` (a removed resource). */
  deletePrefix(prefix: string): void;
  ids(): string[];
}

const KEY_BYTES = 32;
const IV_BYTES = 12;
export const MAX_SECRET_CHARS = 8_192;

/** Loads the vault key, creating it on first use. */
export function loadVaultKey(keyFile: string, envKey?: string): Buffer {
  if (envKey) {
    const key = Buffer.from(envKey, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new Error('SECRETS_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32).');
    }
    return key;
  }
  if (existsSync(keyFile)) {
    const key = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64');
    if (key.length !== KEY_BYTES) throw new Error(`${keyFile} is not a valid vault key.`);
    return key;
  }
  mkdirSync(dirname(keyFile), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(keyFile, `${key.toString('base64')}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    // Windows ignores POSIX modes; the file lives in the user's own profile.
  }
  return key;
}

export function encryptSecret(
  key: Buffer,
  plain: string,
): { iv: Buffer; data: Buffer; tag: Buffer } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return { iv, data, tag: cipher.getAuthTag() };
}

export function decryptSecret(
  key: Buffer,
  sealed: { iv: Buffer; data: Buffer; tag: Buffer },
): string {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.data), decipher.final()]).toString('utf8');
}

interface Row {
  id: string;
  iv: Buffer;
  data: Buffer;
  tag: Buffer;
}

/** The SQLite-backed vault (table `secrets`, migration 3). */
export class SecretVault implements SecretStore {
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly db: AppDatabase,
    private readonly key: Buffer,
    private readonly now: () => number = Date.now,
  ) {}

  get(id: string): string | undefined {
    const cached = this.cache.get(id);
    if (cached !== undefined) return cached;
    const row = this.db.prepare('SELECT id, iv, data, tag FROM secrets WHERE id = ?').get(id) as
      Row | undefined;
    if (!row) return undefined;
    try {
      const value = decryptSecret(this.key, row);
      this.cache.set(id, value);
      return value;
    } catch {
      // Wrong key (vault.key replaced) or a damaged row: treat as missing, never crash.
      return undefined;
    }
  }

  has(id: string): boolean {
    return this.get(id) !== undefined;
  }

  set(id: string, value: string): void {
    if (value.length > MAX_SECRET_CHARS) throw new Error('secret is too long');
    const sealed = encryptSecret(this.key, value);
    this.db
      .prepare(
        `INSERT INTO secrets (id, iv, data, tag, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET iv = excluded.iv, data = excluded.data,
           tag = excluded.tag, updated_at = excluded.updated_at`,
      )
      .run(id, sealed.iv, sealed.data, sealed.tag, this.now());
    this.cache.set(id, value);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
    this.cache.delete(id);
  }

  deletePrefix(prefix: string): void {
    for (const id of this.ids()) if (id.startsWith(prefix)) this.delete(id);
  }

  ids(): string[] {
    return (this.db.prepare('SELECT id FROM secrets ORDER BY id').all() as { id: string }[]).map(
      (row) => row.id,
    );
  }
}

/** Secrets for one request on top of the vault (a password typed just for a test). */
export function overlaySecrets(
  extra: Record<string, string>,
  base?: Pick<SecretStore, 'get'>,
): Pick<SecretStore, 'get'> {
  return { get: (id) => extra[id] ?? base?.get(id) };
}
