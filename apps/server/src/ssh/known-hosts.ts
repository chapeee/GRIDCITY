import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { matchesHostPatterns } from '../config/ssh-config';

/**
 * Read-only known_hosts verification. We never write to known_hosts and
 * never accept an unknown or changed key: the user resolves it with their
 * normal SSH tools (e.g. `ssh-keyscan`, `ssh-keygen -R`).
 *
 * Supported: plain and comma-separated host patterns, wildcards and
 * negation, `[host]:port`, hashed entries (`|1|salt|hash`), `@revoked`.
 * `@cert-authority` lines are skipped (host certificates are not supported).
 */

export interface KnownHostEntry {
  marker: 'revoked' | 'cert-authority' | null;
  /** Plain patterns, or null for a hashed entry. */
  patterns: string[] | null;
  hashed: { salt: Buffer; hash: Buffer } | null;
  keyType: string;
  /** Base64 of the public key blob. */
  keyBase64: string;
}

export interface PresentedKey {
  keyType: string;
  keyBase64: string;
}

export type HostKeyVerdict =
  | { verdict: 'trusted' }
  /** No entry for this host at all. */
  | { verdict: 'unknown' }
  /** Entries exist for this host, but none match the presented key. */
  | { verdict: 'changed' }
  /** The presented key is explicitly revoked. */
  | { verdict: 'revoked' };

export function parseKnownHosts(text: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const fields = line.split(/\s+/);

    let marker: KnownHostEntry['marker'] = null;
    if (fields[0] === '@revoked' || fields[0] === '@cert-authority') {
      marker = fields[0] === '@revoked' ? 'revoked' : 'cert-authority';
      fields.shift();
    }
    const [hostField, keyType, keyBase64] = fields;
    if (!hostField || !keyType || !keyBase64) continue;

    if (hostField.startsWith('|1|')) {
      const [, , salt, hash] = hostField.split('|');
      if (!salt || !hash) continue;
      entries.push({
        marker,
        patterns: null,
        hashed: { salt: Buffer.from(salt, 'base64'), hash: Buffer.from(hash, 'base64') },
        keyType,
        keyBase64,
      });
    } else {
      entries.push({ marker, patterns: hostField.split(','), hashed: null, keyType, keyBase64 });
    }
  }
  return entries;
}

/** Name used for lookups: `host` on port 22, `[host]:port` otherwise (OpenSSH convention). */
export function knownHostsName(address: string, port: number): string {
  return port === 22 ? address : `[${address}]:${port}`;
}

export function entryMatchesHost(entry: KnownHostEntry, lookupName: string): boolean {
  if (entry.hashed) {
    const digest = createHmac('sha1', entry.hashed.salt).update(lookupName).digest();
    return digest.length === entry.hashed.hash.length && timingSafeEqual(digest, entry.hashed.hash);
  }
  return entry.patterns !== null && matchesHostPatterns(lookupName, entry.patterns);
}

export function verifyHostKey(
  entries: readonly KnownHostEntry[],
  lookupName: string,
  presented: PresentedKey,
): HostKeyVerdict {
  const forHost = entries.filter((entry) => entryMatchesHost(entry, lookupName));
  const sameKey = (entry: KnownHostEntry) =>
    entry.keyType === presented.keyType && entry.keyBase64 === presented.keyBase64;

  if (forHost.some((entry) => entry.marker === 'revoked' && sameKey(entry)))
    return { verdict: 'revoked' };
  const trusted = forHost.filter((entry) => entry.marker === null);
  if (trusted.some(sameKey)) return { verdict: 'trusted' };
  return trusted.length > 0 ? { verdict: 'changed' } : { verdict: 'unknown' };
}

/** known_hosts key type -> ssh2 host key algorithm names. */
const ALGORITHMS_BY_KEY_TYPE: Record<string, string[]> = {
  'ssh-ed25519': ['ssh-ed25519'],
  'ecdsa-sha2-nistp256': ['ecdsa-sha2-nistp256'],
  'ecdsa-sha2-nistp384': ['ecdsa-sha2-nistp384'],
  'ecdsa-sha2-nistp521': ['ecdsa-sha2-nistp521'],
  'ssh-rsa': ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa'],
};

/** Every host key algorithm we accept, strongest first. */
const ALL_HOST_KEY_ALGORITHMS = [
  'ssh-ed25519',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'rsa-sha2-512',
  'rsa-sha2-256',
  'ssh-rsa',
];

/**
 * Host key algorithms to offer: the types already trusted for this host
 * first (as OpenSSH does), then the rest. Preferring known types means a
 * server that also has an ed25519 key is not mistaken for a changed key when
 * only its RSA key is trusted. Keeping the others as a fallback means a server
 * that lost the trusted type still completes the handshake, so the key check
 * can refuse it with a clear "host key changed" instead of a cryptic
 * negotiation error. Returns null when nothing is known (library defaults).
 */
export function preferredHostKeyAlgorithms(
  entries: readonly KnownHostEntry[],
  lookupName: string,
): string[] | null {
  const algorithms = entries
    .filter((entry) => entry.marker === null && entryMatchesHost(entry, lookupName))
    .flatMap((entry) => ALGORITHMS_BY_KEY_TYPE[entry.keyType] ?? []);
  if (algorithms.length === 0) return null;
  return [...new Set([...algorithms, ...ALL_HOST_KEY_ALGORITHMS])];
}

/** Reads the key type from an SSH public key blob (length-prefixed string). */
export function presentedKeyFromBlob(blob: Buffer): PresentedKey {
  const typeLength = blob.length >= 4 ? blob.readUInt32BE(0) : 0;
  const keyType = blob.subarray(4, 4 + typeLength).toString('ascii');
  return { keyType, keyBase64: blob.toString('base64') };
}

/** OpenSSH-style fingerprint, e.g. "SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8". */
export function fingerprintSha256(blob: Buffer): string {
  return `SHA256:${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}
