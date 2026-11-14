import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  type DecipherGCM,
} from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import * as zlib from 'node:zlib';
import type { Compression } from '@app/shared';

/**
 * Backup file format (documented in docs/BACKUPS.md):
 *
 *   [compressed payload]                       when not encrypted
 *   "GCBK" 0x01 log2N r p salt(16) iv(12)      37-byte header, when encrypted
 *   AES-256-GCM ciphertext of the compressed payload
 *   GCM tag (16)
 *
 * The key is scrypt(passphrase, salt, 32, N, r, p). Decryption checks the tag
 * at the end; restores decrypt into a staging file first, so nothing reaches
 * a database or folder before the whole file is proven intact.
 */
export const MAGIC = Buffer.from('GCBK');
export const HEADER_BYTES = 4 + 1 + 3 + 16 + 12;
const TAG_BYTES = 16;
export const KDF = { log2N: 15, r: 8, p: 1 } as const;

export function deriveKey(
  passphrase: string,
  salt: Buffer,
  params: { log2N: number; r: number; p: number } = KDF,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      passphrase,
      salt,
      32,
      { N: 2 ** params.log2N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

export async function createEncryptStream(
  passphrase: string,
): Promise<{ stream: Transform; salt: Buffer }> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const header = Buffer.concat([MAGIC, Buffer.from([1, KDF.log2N, KDF.r, KDF.p]), salt, iv]);
  let headerSent = false;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      if (!headerSent) {
        this.push(header);
        headerSent = true;
      }
      this.push(cipher.update(chunk));
      done();
    },
    flush(done: TransformCallback) {
      if (!headerSent) this.push(header);
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      done();
    },
  });
  return { stream, salt };
}

export class DecryptError extends Error {}

/** Decrypts the format above; fails at the end when the passphrase or the file is wrong. */
export function createDecryptStream(passphrase: string): Transform {
  let header = Buffer.alloc(0);
  let decipher: DecipherGCM | null = null;
  let pending: Promise<void> | null = null;
  let tail = Buffer.alloc(0);

  const feed = (stream: Transform, data: Buffer) => {
    // Hold back the last 16 bytes: they may be the tag.
    const all = Buffer.concat([tail, data]);
    if (all.length <= TAG_BYTES) {
      tail = all;
      return;
    }
    tail = all.subarray(all.length - TAG_BYTES);
    stream.push(decipher!.update(all.subarray(0, all.length - TAG_BYTES)));
  };

  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      if (decipher) {
        feed(this, chunk);
        return done();
      }
      header = Buffer.concat([header, chunk]);
      if (header.length < HEADER_BYTES) return done();
      if (!header.subarray(0, 4).equals(MAGIC) || header[4] !== 1) {
        return done(new DecryptError('not an encrypted GRIDCITY backup (bad header)'));
      }
      const params = { log2N: header[5]!, r: header[6]!, p: header[7]! };
      const salt = header.subarray(8, 24);
      const iv = header.subarray(24, 36);
      const rest = header.subarray(HEADER_BYTES);
      pending = deriveKey(passphrase, salt, params).then((key) => {
        decipher = createDecipheriv('aes-256-gcm', key, iv) as DecipherGCM;
      });
      pending.then(
        () => {
          feed(this, rest);
          done();
        },
        (error: Error) => done(error),
      );
    },
    flush(done: TransformCallback) {
      if (!decipher) return done(new DecryptError('the file ended before the encryption header'));
      if (tail.length !== TAG_BYTES) return done(new DecryptError('the file is truncated'));
      try {
        decipher.setAuthTag(tail);
        this.push(decipher.final());
        done();
      } catch {
        done(
          new DecryptError(
            'decryption failed: wrong passphrase, or the file was changed or damaged',
          ),
        );
      }
    },
  });
}

export function zstdAvailable(): boolean {
  return typeof (zlib as { createZstdCompress?: unknown }).createZstdCompress === 'function';
}

export function createCompressStream(compression: Compression): Transform | null {
  if (compression === 'none') return null;
  if (compression === 'zstd') {
    if (!zstdAvailable()) throw new Error('zstd needs Node.js 22.15 or newer; choose gzip');
    return (zlib as unknown as { createZstdCompress(): Transform }).createZstdCompress();
  }
  return zlib.createGzip({ level: 6 });
}

export function createDecompressStream(compression: Compression): Transform | null {
  if (compression === 'none') return null;
  if (compression === 'zstd') {
    if (!zstdAvailable()) throw new Error('this backup is zstd: Node.js 22.15 or newer is needed');
    return (zlib as unknown as { createZstdDecompress(): Transform }).createZstdDecompress();
  }
  return zlib.createGunzip();
}

export const compressionExtension = (compression: Compression) =>
  compression === 'gzip' ? '.gz' : compression === 'zstd' ? '.zst' : '';

/** Counts bytes and computes SHA-256 of what passes through. */
export class MeterStream extends Transform {
  bytes = 0;
  private readonly hash = createHash('sha256');
  constructor(private readonly onBytes?: (total: number) => void) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback) {
    this.bytes += chunk.length;
    this.hash.update(chunk);
    this.onBytes?.(this.bytes);
    done(null, chunk);
  }
  digest(): string {
    return this.hash.digest('hex');
  }
}

/** Exponential moving average of a rate, sampled at most once per 500 ms. */
export class RateTracker {
  private lastAt = 0;
  private lastBytes = 0;
  rate: number | null = null;
  constructor(private readonly now: () => number = Date.now) {}
  update(bytes: number): number | null {
    const t = this.now();
    if (this.lastAt === 0) {
      this.lastAt = t;
      this.lastBytes = bytes;
      return this.rate;
    }
    const dt = t - this.lastAt;
    if (dt < 500) return this.rate;
    const instant = ((bytes - this.lastBytes) * 1000) / dt;
    this.rate = this.rate === null ? instant : this.rate * 0.7 + instant * 0.3;
    this.lastAt = t;
    this.lastBytes = bytes;
    return this.rate;
  }
}
