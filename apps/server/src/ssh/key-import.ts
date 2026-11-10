import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import ssh2, { type ParsedKey } from 'ssh2';
import { fingerprintSha256 } from './known-hosts';

/**
 * Importing a private key the user already has: an AWS/GCP `.pem`, an
 * OpenSSH `id_*` file, or a PuTTY `.ppk`. PuTTY keys are converted to the
 * OpenSSH format so both this app and plain `ssh` can use them.
 *
 * Passphrase-protected keys are refused rather than decrypted: the app never
 * stores passphrases, and saving a decrypted copy would silently weaken the
 * user's key.
 */

/** Largest key file accepted; real keys are a few kilobytes. */
export const MAX_KEY_FILE_BYTES = 64 * 1024;

export class KeyImportError extends Error {
  override name = 'KeyImportError';
}

export class KeyNameTakenError extends Error {
  override name = 'KeyNameTakenError';
}

export type KeyTextKind = 'ppk' | 'private' | 'public' | 'unknown';

/** What kind of key text this looks like, from its first line. */
export function classifyKeyText(text: string): KeyTextKind {
  const head = text.trimStart().slice(0, 200);
  if (/^PuTTY-User-Key-File-\d+:/.test(head)) return 'ppk';
  if (/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(head)) return 'private';
  if (
    /^-----BEGIN (SSH2 |RSA )?PUBLIC KEY-----/.test(head) ||
    /^---- BEGIN SSH2 PUBLIC KEY ----/.test(head) ||
    /^(ssh-|ecdsa-sha2-|sk-)[a-z0-9@.-]+ AAAA/.test(head)
  ) {
    return 'public';
  }
  return 'unknown';
}

// ---- SSH wire format helpers ----------------------------------------------

class WireReader {
  private offset = 0;
  constructor(private readonly buffer: Buffer) {}

  /** One length-prefixed field (string or mpint), as raw bytes. */
  field(): Buffer {
    if (this.offset + 4 > this.buffer.length)
      throw new KeyImportError('The key file is truncated.');
    const length = this.buffer.readUInt32BE(this.offset);
    const start = this.offset + 4;
    if (start + length > this.buffer.length) throw new KeyImportError('The key file is truncated.');
    this.offset = start + length;
    return this.buffer.subarray(start, start + length);
  }
}

const u32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};
const field = (value: Buffer | string) => {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  return Buffer.concat([u32(bytes.length), bytes]);
};

// ---- PuTTY .ppk -> OpenSSH ------------------------------------------------

interface PpkFile {
  algorithm: string;
  encryption: string;
  comment: string;
  publicBlob: Buffer;
  privateBlob: Buffer;
}

function parsePpk(text: string): PpkFile {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const headers = new Map<string, string>();
  const blocks = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([A-Za-z0-9-]+): ?(.*)$/.exec(lines[index] ?? '');
    if (!match) continue;
    const [, key, value] = match as unknown as [string, string, string];
    if (key === 'Public-Lines' || key === 'Private-Lines') {
      const count = Number(value);
      blocks.set(key, lines.slice(index + 1, index + 1 + count).join(''));
      index += count;
    } else {
      headers.set(key, value);
    }
  }

  const headerKey = [...headers.keys()].find((key) => key.startsWith('PuTTY-User-Key-File-'));
  const version = headerKey ? Number(headerKey.slice('PuTTY-User-Key-File-'.length)) : NaN;
  if (version !== 2 && version !== 3) {
    throw new KeyImportError(
      'Unsupported PuTTY key version. Re-save it with PuTTYgen, or export it as OpenSSH.',
    );
  }
  const publicLines = blocks.get('Public-Lines');
  const privateLines = blocks.get('Private-Lines');
  if (!publicLines || !privateLines) throw new KeyImportError('The PuTTY key file is incomplete.');

  return {
    algorithm: headers.get(headerKey!) ?? '',
    encryption: headers.get('Encryption') ?? 'none',
    comment: headers.get('Comment') ?? '',
    publicBlob: Buffer.from(publicLines, 'base64'),
    privateBlob: Buffer.from(privateLines, 'base64'),
  };
}

/**
 * Converts an unencrypted PuTTY key (v2 or v3) to an OpenSSH private key.
 * Supports RSA, Ed25519 and ECDSA, which covers every key AWS, PuTTYgen and
 * cloud consoles hand out today.
 */
export function ppkToOpenSsh(text: string): string {
  const ppk = parsePpk(text);
  if (ppk.encryption !== 'none') {
    throw new KeyImportError(
      'This PuTTY key has a passphrase. The app never stores passphrases: remove it in PuTTYgen (clear the passphrase, save), then upload again.',
    );
  }

  const pub = new WireReader(ppk.publicBlob);
  const priv = new WireReader(ppk.privateBlob);
  const algorithm = pub.field().toString('utf8');
  if (algorithm !== ppk.algorithm) throw new KeyImportError('The PuTTY key file is inconsistent.');

  let keyFields: Buffer[];
  if (algorithm === 'ssh-rsa') {
    const e = pub.field();
    const n = pub.field();
    const [d, p, q, iqmp] = [priv.field(), priv.field(), priv.field(), priv.field()];
    keyFields = [field(algorithm), field(n), field(e), field(d), field(iqmp), field(p), field(q)];
  } else if (algorithm === 'ssh-ed25519') {
    const publicKey = pub.field();
    // PuTTY stores the 32-byte seed as a little-endian integer, which can drop
    // trailing zero bytes (or, rarely, carry one extra); normalize to 32.
    let seed = Buffer.from(priv.field());
    while (seed.length > 32 && seed[seed.length - 1] === 0) seed = seed.subarray(0, -1);
    if (seed.length < 32) seed = Buffer.concat([seed, Buffer.alloc(32 - seed.length)]);
    if (publicKey.length !== 32 || seed.length !== 32) {
      throw new KeyImportError('The PuTTY Ed25519 key is malformed.');
    }
    keyFields = [field(algorithm), field(publicKey), field(Buffer.concat([seed, publicKey]))];
  } else if (algorithm.startsWith('ecdsa-sha2-')) {
    const curve = pub.field();
    const point = pub.field();
    const d = priv.field();
    keyFields = [field(algorithm), field(curve), field(point), field(d)];
  } else {
    throw new KeyImportError(
      `PuTTY keys of type ${algorithm || 'unknown'} are not supported. Use RSA, Ed25519 or ECDSA.`,
    );
  }

  // openssh-key-v1, unencrypted: see PROTOCOL.key in the OpenSSH sources.
  const check = randomBytes(4);
  let privateSection = Buffer.concat([check, check, ...keyFields, field(ppk.comment)]);
  const padding = (8 - (privateSection.length % 8)) % 8;
  privateSection = Buffer.concat([
    privateSection,
    Buffer.from(Array.from({ length: padding }, (_, i) => i + 1)),
  ]);

  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'latin1'),
    field('none'),
    field('none'),
    field(''),
    u32(1),
    field(ppk.publicBlob),
    field(privateSection),
  ]);
  const base64 = body.toString('base64').replace(/.{1,70}/g, '$&\n');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64}-----END OPENSSH PRIVATE KEY-----\n`;
}

// ---- Reading and saving ---------------------------------------------------

export interface PreparedKey {
  /** Private key text to save (OpenSSH or PEM). */
  privateText: string;
  parsed: ParsedKey;
  fingerprint: string;
  /** OpenSSH public key line. */
  publicLine: string;
}

/**
 * Validates key text and returns what would be saved. Refuses public keys,
 * passphrase-protected keys and anything that does not produce a working
 * signature (a corrupt key would otherwise fail later, at connect time).
 */
export function prepareKey(text: string, fallbackComment: string): PreparedKey {
  if (Buffer.byteLength(text) > MAX_KEY_FILE_BYTES) {
    throw new KeyImportError('That file is too large to be an SSH key.');
  }
  const kind = classifyKeyText(text);
  if (kind === 'public') {
    throw new KeyImportError(
      'This is a public key. Upload the PRIVATE key file instead: the .pem or .ppk your provider let you download (the public half is worked out from it).',
    );
  }
  if (kind === 'unknown') {
    throw new KeyImportError(
      'This does not look like an SSH private key. Expected a .pem, .ppk or OpenSSH key file.',
    );
  }

  const privateText =
    kind === 'ppk' ? ppkToOpenSsh(text) : `${text.replace(/\r\n?/g, '\n').trim()}\n`;
  const result = ssh2.utils.parseKey(privateText);
  if (result instanceof Error) {
    throw new KeyImportError(
      /passphrase|encrypted/i.test(result.message)
        ? 'This key has a passphrase. The app never stores passphrases: remove it with `ssh-keygen -p -f <file>` (or load the key into ssh-agent instead), then upload again.'
        : `This key could not be read: ${result.message}`,
    );
  }
  const parsed = Array.isArray(result) ? result[0] : result;
  if (!parsed || parsed.isPrivateKey() !== true) {
    throw new KeyImportError('This file does not contain a private key.');
  }

  // Prove the key works: sign, then verify with its public half.
  const challenge = randomBytes(32);
  const signature = parsed.sign(challenge);
  if (signature instanceof Error || parsed.verify(challenge, signature) !== true) {
    throw new KeyImportError('This key is damaged: its private and public halves do not match.');
  }

  const blob = parsed.getPublicSSH();
  const comment = parsed.comment || fallbackComment;
  return {
    privateText,
    parsed,
    fingerprint: fingerprintSha256(blob),
    publicLine: `${parsed.type} ${blob.toString('base64')} ${comment}`.trim(),
  };
}

/** Files in an SSH folder that are never key files. */
const RESERVED_NAMES = new Set([
  'known_hosts',
  'known_hosts.old',
  'config',
  'authorized_keys',
  'authorized_keys2',
  'environment',
  'rc',
]);

/**
 * A safe file name from what the user uploaded: "my key.ppk" -> "my_key".
 * PuTTY keys lose their extension because the saved file is OpenSSH.
 */
export function keyFileName(uploadedName: string, kind: KeyTextKind): string {
  let name = basename(uploadedName.replace(/\\/g, '/')).trim();
  if (kind === 'ppk') name = name.replace(/\.ppk$/i, '');
  name = name
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, 64);
  if (!name || name.endsWith('.pub') || RESERVED_NAMES.has(name.toLowerCase())) {
    name = `imported_${name.replace(/\.pub$/, '') || 'key'}`;
  }
  return name;
}

export interface ImportResult {
  privatePath: string;
  fingerprint: string;
  /** False when the identical key was already there. */
  created: boolean;
}

/**
 * Saves an uploaded private key into the SSH folder (mode 600) with its
 * `.pub` beside it. Uploading the same key twice is harmless; a different key
 * under the same name is refused, never overwritten.
 */
export async function importPrivateKey(options: {
  sshDir: string;
  fileName: string;
  content: string;
}): Promise<ImportResult> {
  const kind = classifyKeyText(options.content);
  const name = keyFileName(options.fileName, kind);
  const prepared = prepareKey(options.content, name);
  const privatePath = join(options.sshDir, name);

  if (existsSync(privatePath)) {
    const existing = ssh2.utils.parseKey(await readFile(privatePath));
    const existingKey = Array.isArray(existing) ? existing[0] : existing;
    if (
      existingKey &&
      !(existingKey instanceof Error) &&
      fingerprintSha256(existingKey.getPublicSSH()) === prepared.fingerprint
    ) {
      return { privatePath, fingerprint: prepared.fingerprint, created: false };
    }
    throw new KeyNameTakenError(
      `Your SSH folder already has a different file named "${name}". Rename the file you are uploading and try again.`,
    );
  }

  await mkdir(options.sshDir, { recursive: true, mode: 0o700 });
  await writeFile(privatePath, prepared.privateText, { mode: 0o600, flag: 'wx' });
  await chmod(privatePath, 0o600).catch(() => {}); // best effort on Windows
  const publicPath = `${privatePath}.pub`;
  if (!existsSync(publicPath)) {
    await writeFile(publicPath, `${prepared.publicLine}\n`, { mode: 0o644, flag: 'wx' });
  }
  return { privatePath, fingerprint: prepared.fingerprint, created: true };
}
