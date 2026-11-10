import { generateKeyPairSync } from 'node:crypto';

/**
 * Builds PuTTY .ppk key files (v2 or v3, unencrypted) from keys generated
 * with Node's crypto module, laid out as PuTTYgen writes them. Tests use the
 * returned `publicLine` (built independently of the converter) to check that
 * an imported key really is the same key.
 */

export type PpkKeyType = 'rsa' | 'ed25519' | 'ecdsa';

export interface PpkFixture {
  ppk: string;
  /** "ssh-ed25519 AAAA…" built straight from the generated key. */
  publicLine: string;
}

const u32 = (value: number) => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
};
const str = (value: Buffer | string) => {
  const bytes = typeof value === 'string' ? Buffer.from(value) : value;
  return Buffer.concat([u32(bytes.length), bytes]);
};
/** SSH mpint from unsigned big-endian bytes. */
const mpint = (unsigned: Buffer) => {
  let bytes = unsigned;
  while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1);
  if (bytes[0]! & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
  return str(bytes);
};
const b64url = (value: string | undefined) => Buffer.from(value ?? '', 'base64url');
const lines = (data: Buffer) => data.toString('base64').match(/.{1,64}/g) ?? [];

export function makePpk(
  type: PpkKeyType,
  options: { version?: 2 | 3; comment?: string } = {},
): PpkFixture {
  const version = options.version ?? 3;
  const comment = options.comment ?? `${type}-test-key`;
  let algorithm: string;
  let publicBlob: Buffer;
  let privateBlob: Buffer;

  if (type === 'rsa') {
    const jwk = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
      format: 'jwk',
    });
    algorithm = 'ssh-rsa';
    publicBlob = Buffer.concat([str(algorithm), mpint(b64url(jwk.e)), mpint(b64url(jwk.n))]);
    privateBlob = Buffer.concat([
      mpint(b64url(jwk.d)),
      mpint(b64url(jwk.p)),
      mpint(b64url(jwk.q)),
      mpint(b64url(jwk.qi)),
    ]);
  } else if (type === 'ed25519') {
    const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
    algorithm = 'ssh-ed25519';
    publicBlob = Buffer.concat([str(algorithm), str(b64url(jwk.x))]);
    privateBlob = str(b64url(jwk.d)); // 32-byte seed, little-endian as PuTTY stores it
  } else {
    const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
      format: 'jwk',
    });
    algorithm = 'ecdsa-sha2-nistp256';
    const point = Buffer.concat([Buffer.from([4]), b64url(jwk.x), b64url(jwk.y)]);
    publicBlob = Buffer.concat([str(algorithm), str('nistp256'), str(point)]);
    privateBlob = mpint(b64url(jwk.d));
  }

  const publicLines = lines(publicBlob);
  const privateLines = lines(privateBlob);
  const ppk = [
    `PuTTY-User-Key-File-${version}: ${algorithm}`,
    'Encryption: none',
    `Comment: ${comment}`,
    `Public-Lines: ${publicLines.length}`,
    ...publicLines,
    `Private-Lines: ${privateLines.length}`,
    ...privateLines,
    // The converter proves the key with a signature instead of checking the MAC.
    `Private-MAC: ${'0'.repeat(version === 3 ? 64 : 40)}`,
    '',
  ].join('\r\n'); // PuTTYgen writes Windows line endings

  return { ppk, publicLine: `${algorithm} ${publicBlob.toString('base64')}` };
}
