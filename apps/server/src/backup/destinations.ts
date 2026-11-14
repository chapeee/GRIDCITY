import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, statfs, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse as parsePath, posix, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { SFTPWrapper } from 'ssh2';
import type { DestinationInput } from '@app/shared';
import type { ResourceConfigOf } from '../config/resources-file';
import { expandHome } from '../config/app-paths';
import type { ConnectorContext } from '../connectors/connector';
import { errorMessage } from '../connectors/connector';
import { clientConfig } from '../connectors/s3';
import { runToEnd, shellQuote, SshRunner, type SshExecutor } from './runner';

export interface BrowseEntry {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  modifiedAt?: number;
}

export interface BrowseResult {
  /** The folder listed (absolute path, or "bucket/prefix/"). */
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
  /** Free space where it can be measured (local disks). */
  freeBytes?: number | null;
}

export interface DestinationAdapter {
  /** Writes, reads back and removes a small file: proves the credentials and the folder work. */
  test(): Promise<string>;
  upload(
    localFile: string,
    key: string,
    onProgress: (bytes: number) => void,
    signal: AbortSignal,
  ): Promise<void>;
  download(key: string): Promise<Readable>;
  stat(key: string): Promise<{ size: number } | null>;
  remove(key: string): Promise<void>;
  /** SHA-256 computed where the file is (sftp: sha256sum on the server); null = download to check. */
  remoteSha256?(key: string): Promise<string | null>;
  /** Removes what an interrupted upload left (".partial" files, unfinished multipart uploads). */
  cleanupPartial(key: string): Promise<void>;
  writeText(key: string, text: string): Promise<void>;
  close(): Promise<void>;
}

export interface DestinationDeps {
  context: ConnectorContext;
  s3Config(resourceId: string): Promise<ResourceConfigOf<'s3'> | undefined>;
  connection(hostId: string): (SshExecutor & { sftp(): Promise<SFTPWrapper> }) | undefined;
  hostLabel(hostId: string): string;
}

/** Counts bytes written through it (local copies). */
function progressTap(onProgress: (bytes: number) => void): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _e, done) {
      total += chunk.length;
      onProgress(total);
      done(null, chunk);
    },
  });
}

const PROBE = '.gridcity-write-test';

// ── Local ─────────────────────────────────────────────────────────────────

export function localDestination(basePath: string, homeDir: string): DestinationAdapter {
  const base = resolve(expandHome(basePath, homeDir));
  const full = (key: string) => {
    const path = resolve(base, key);
    if (!path.startsWith(base)) throw new Error('path escapes the destination folder');
    return path;
  };
  return {
    async test() {
      await mkdir(base, { recursive: true });
      const probe = join(base, PROBE);
      await pipeline(async function* () {
        yield Buffer.from('ok');
      }, createWriteStream(probe));
      await unlink(probe);
      const free = await statfs(base)
        .then((s) => s.bavail * s.bsize)
        .catch(() => null);
      return `Writable${free !== null ? ` · ${formatBytes(free)} free` : ''}`;
    },
    async upload(localFile, key, onProgress, signal) {
      const target = full(key);
      await mkdir(dirname(target), { recursive: true });
      const partial = `${target}.partial`;
      await pipeline(
        createReadStream(localFile),
        progressTap(onProgress),
        createWriteStream(partial),
        { signal },
      );
      await rename(partial, target);
    },
    async download(key) {
      const path = full(key);
      if (!existsSync(path)) throw new Error(`${path} is missing`);
      return createReadStream(path);
    },
    async stat(key) {
      return stat(full(key)).then(
        (s) => ({ size: s.size }),
        () => null,
      );
    },
    async remove(key) {
      await rm(full(key), { force: true });
    },
    async cleanupPartial(key) {
      await rm(`${full(key)}.partial`, { force: true });
    },
    async writeText(key, text) {
      const target = full(key);
      await mkdir(dirname(target), { recursive: true });
      await pipeline(async function* () {
        yield Buffer.from(text);
      }, createWriteStream(target));
    },
    async close() {},
  };
}

export async function browseLocal(path: string, homeDir: string): Promise<BrowseResult> {
  if (!path && process.platform === 'win32') {
    // Drive letters that exist.
    const drives: BrowseEntry[] = [];
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      if (existsSync(`${letter}:\\`)) drives.push({ name: `${letter}:\\`, type: 'dir' });
    }
    return { path: '', parent: null, entries: drives };
  }
  const dir = resolve(expandHome(path || homeDir, homeDir));
  const entries = await readdir(dir, { withFileTypes: true });
  const parsed = parsePath(dir);
  const free = await statfs(dir)
    .then((s) => s.bavail * s.bsize)
    .catch(() => null);
  return {
    path: dir,
    parent: dir === parsed.root ? (process.platform === 'win32' ? '' : null) : dirname(dir),
    entries: entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('$'))
      .map((e) => ({ name: e.name, type: 'dir' as const }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    freeBytes: free,
  };
}

// ── S3 ────────────────────────────────────────────────────────────────────

const joinPrefix = (prefix: string, key: string) =>
  prefix ? `${prefix.replace(/\/+$/, '')}/${key}` : key;

export function s3Destination(
  config: ResourceConfigOf<'s3'>,
  bucket: string,
  prefix: string,
  context: ConnectorContext,
): DestinationAdapter {
  const client = new S3Client({ ...clientConfig(config, context), maxAttempts: 4 });
  const keyOf = (key: string) => joinPrefix(prefix, key);
  return {
    async test() {
      const Key = keyOf(PROBE);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key, Body: 'ok' }));
      await client.send(new HeadObjectCommand({ Bucket: bucket, Key }));
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key }));
      return `Bucket ${bucket} is writable`;
    },
    async upload(localFile, key, onProgress, signal) {
      const size = (await stat(localFile)).size;
      const upload = new Upload({
        client,
        params: {
          Bucket: bucket,
          Key: keyOf(key),
          Body: createReadStream(localFile),
          ContentLength: size,
        },
        queueSize: 4,
        partSize: Math.max(16 * 1024 * 1024, Math.ceil(size / 9000)),
        leavePartsOnError: false,
      });
      upload.on('httpUploadProgress', (p) => {
        if (typeof p.loaded === 'number') onProgress(p.loaded);
      });
      const onAbort = () => void upload.abort();
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        await upload.done();
      } finally {
        signal.removeEventListener('abort', onAbort);
      }
    },
    async download(key) {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: keyOf(key) }));
      return response.Body as Readable;
    },
    async stat(key) {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: keyOf(key) }));
        return { size: head.ContentLength ?? 0 };
      } catch (error) {
        const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode;
        if (status === 404 || (error as Error).name === 'NotFound') return null;
        throw error;
      }
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyOf(key) }));
    },
    async cleanupPartial(key) {
      const Key = keyOf(key);
      const uploads = await client.send(
        new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: Key }),
      );
      for (const u of uploads.Uploads ?? []) {
        if (u.Key === Key && u.UploadId) {
          await client.send(
            new AbortMultipartUploadCommand({ Bucket: bucket, Key, UploadId: u.UploadId }),
          );
        }
      }
    },
    async writeText(key, text) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: keyOf(key),
          Body: text,
          ContentType: 'application/json',
        }),
      );
    },
    async close() {
      client.destroy();
    },
  };
}

export async function browseS3(
  config: ResourceConfigOf<'s3'>,
  bucket: string,
  prefix: string,
  context: ConnectorContext,
): Promise<BrowseResult> {
  const client = new S3Client(clientConfig(config, context));
  try {
    if (!bucket) {
      const buckets = config.buckets
        ? config.buckets
        : ((await client.send(new ListBucketsCommand({}))).Buckets ?? [])
            .map((b) => b.Name ?? '')
            .filter(Boolean);
      return {
        path: '',
        parent: null,
        entries: buckets.sort().map((name) => ({ name, type: 'dir' as const })),
      };
    }
    const clean = prefix ? `${prefix.replace(/\/+$/, '')}/` : '';
    const listing = await client.send(
      new ListObjectsV2Command({ Bucket: bucket, Prefix: clean, Delimiter: '/', MaxKeys: 500 }),
    );
    const dirs = (listing.CommonPrefixes ?? []).map((p) => ({
      name: (p.Prefix ?? '').slice(clean.length).replace(/\/$/, ''),
      type: 'dir' as const,
    }));
    const files = (listing.Contents ?? [])
      .filter((o) => o.Key && o.Key !== clean)
      .slice(0, 100)
      .map((o) => ({
        name: (o.Key ?? '').slice(clean.length),
        type: 'file' as const,
        size: o.Size,
        modifiedAt: o.LastModified?.getTime(),
      }));
    const parentPrefix = clean ? clean.replace(/[^/]+\/$/, '') : null;
    return {
      path: `${bucket}/${clean}`,
      parent: parentPrefix === null ? '' : `${bucket}/${parentPrefix}`,
      entries: [...dirs, ...files],
    };
  } finally {
    client.destroy();
  }
}

// ── SFTP (over the server's existing SSH connection) ──────────────────────

const sftpCall = <T>(fn: (cb: (error: Error | null | undefined, value?: T) => void) => void) =>
  new Promise<T>((ok, fail) => fn((error, value) => (error ? fail(error) : ok(value as T))));

async function sftpMkdirp(sftp: SFTPWrapper, path: string): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  let current = path.startsWith('/') ? '' : '.';
  for (const part of parts) {
    current = `${current}/${part}`;
    const exists = await sftpCall<unknown>((cb) => sftp.stat(current, cb)).then(
      () => true,
      () => false,
    );
    if (!exists) await sftpCall<void>((cb) => sftp.mkdir(current, cb as never));
  }
}

export function sftpDestination(
  hostId: string,
  basePath: string,
  deps: DestinationDeps,
): DestinationAdapter {
  const base = basePath.replace(/\/+$/, '') || '/';
  const full = (key: string) => {
    const path = posix.normalize(posix.join(base, key));
    if (!path.startsWith(base)) throw new Error('path escapes the destination folder');
    return path;
  };
  let session: SFTPWrapper | null = null;
  const open = async () => {
    if (session) return session;
    const connection = deps.connection(hostId);
    if (!connection)
      throw new Error(`${deps.hostLabel(hostId)} is not connected over SSH right now`);
    session = await connection.sftp();
    session.on('close', () => (session = null));
    return session;
  };
  const runner = new SshRunner(hostId, deps.hostLabel(hostId), () => deps.connection(hostId));
  return {
    async test() {
      const sftp = await open();
      await sftpMkdirp(sftp, base);
      const probe = full(PROBE);
      await new Promise<void>((ok, fail) => {
        const stream = sftp.createWriteStream(probe);
        stream.on('close', () => ok());
        stream.on('error', fail);
        stream.end('ok');
      });
      await sftpCall<void>((cb) => sftp.unlink(probe, cb as never));
      const df = await runToEnd(runner, ['df', '-Pk', base], { timeoutMs: 15_000 }).catch(
        () => null,
      );
      const free =
        df?.code === 0 ? Number(df.stdout.trim().split('\n').pop()?.split(/\s+/)[3]) * 1024 : NaN;
      return `Writable on ${deps.hostLabel(hostId)}${Number.isFinite(free) ? ` · ${formatBytes(free)} free` : ''}`;
    },
    async upload(localFile, key, onProgress, signal) {
      const sftp = await open();
      const target = full(key);
      await sftpMkdirp(sftp, posix.dirname(target));
      const partial = `${target}.partial`;
      await new Promise<void>((ok, fail) => {
        const onAbort = () => {
          session?.end();
          fail(new Error('cancelled'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        sftp.fastPut(
          localFile,
          partial,
          { concurrency: 16, step: (transferred) => onProgress(transferred) },
          (error) => {
            signal.removeEventListener('abort', onAbort);
            if (error) fail(error);
            else ok();
          },
        );
      });
      await sftpCall<void>((cb) => sftp.unlink(target, cb as never)).catch(() => undefined);
      await sftpCall<void>((cb) => sftp.rename(partial, target, cb as never));
    },
    async download(key) {
      const sftp = await open();
      return sftp.createReadStream(full(key));
    },
    async stat(key) {
      const sftp = await open();
      return sftpCall<{ size: number }>((cb) => sftp.stat(full(key), cb as never)).then(
        (s) => ({ size: Number(s.size) }),
        () => null,
      );
    },
    async remove(key) {
      const sftp = await open();
      await sftpCall<void>((cb) => sftp.unlink(full(key), cb as never)).catch(
        (error: Error & { code?: number }) => {
          if (error.code !== 2) throw error; // 2 = no such file
        },
      );
    },
    async remoteSha256(key) {
      const result = await runToEnd(
        runner,
        [
          'sh',
          '-c',
          `sha256sum ${shellQuote(full(key))} 2>/dev/null || shasum -a 256 ${shellQuote(full(key))}`,
        ],
        {
          timeoutMs: 60 * 60_000,
        },
      ).catch(() => null);
      const hash = result?.code === 0 ? /^[0-9a-f]{64}/.exec(result.stdout.trim())?.[0] : undefined;
      return hash ?? null;
    },
    async cleanupPartial(key) {
      const sftp = await open();
      await sftpCall<void>((cb) => sftp.unlink(`${full(key)}.partial`, cb as never)).catch(
        () => undefined,
      );
    },
    async writeText(key, text) {
      const sftp = await open();
      const target = full(key);
      await sftpMkdirp(sftp, posix.dirname(target));
      await new Promise<void>((ok, fail) => {
        const stream = sftp.createWriteStream(target);
        stream.on('close', () => ok());
        stream.on('error', fail);
        stream.end(text);
      });
    },
    async close() {
      session?.end();
      session = null;
    },
  };
}

export async function browseSftp(
  hostId: string,
  path: string,
  deps: DestinationDeps,
): Promise<BrowseResult> {
  const connection = deps.connection(hostId);
  if (!connection) throw new Error(`${deps.hostLabel(hostId)} is not connected over SSH right now`);
  const sftp = await connection.sftp();
  try {
    const dir = path
      ? posix.normalize(path)
      : await sftpCall<string>((cb) => sftp.realpath('.', cb as never));
    const list = await sftpCall<
      { filename: string; attrs: { size: number; mtime: number; mode: number } }[]
    >((cb) => sftp.readdir(dir, cb as never));
    const entries = list
      .filter((e) => !e.filename.startsWith('.') || e.filename === '.gridcity')
      .map((e) => {
        const isDir = (e.attrs.mode & 0o170000) === 0o040000;
        return isDir
          ? { name: e.filename, type: 'dir' as const }
          : {
              name: e.filename,
              type: 'file' as const,
              size: Number(e.attrs.size),
              modifiedAt: e.attrs.mtime * 1000,
            };
      })
      .sort((a, b) =>
        a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1,
      )
      .slice(0, 500);
    return { path: dir, parent: dir === '/' ? null : posix.dirname(dir), entries };
  } finally {
    sftp.end();
  }
}

// ── factory ───────────────────────────────────────────────────────────────

export async function openDestination(
  input: DestinationInput,
  deps: DestinationDeps,
): Promise<DestinationAdapter> {
  switch (input.kind) {
    case 'local':
      if (!isAbsolute(expandHome(input.path, deps.context.homeDir))) {
        throw new Error('use an absolute folder path');
      }
      return localDestination(input.path, deps.context.homeDir);
    case 's3': {
      const config = await deps.s3Config(input.resourceId);
      if (!config)
        throw new Error(`the storage account "${input.resourceId}" is no longer connected`);
      return s3Destination(config, input.bucket, input.prefix, deps.context);
    }
    case 'sftp':
      return sftpDestination(input.hostId, input.path, deps);
  }
}

export async function testDestination(
  input: DestinationInput,
  deps: DestinationDeps,
): Promise<{ ok: boolean; message: string }> {
  let adapter: DestinationAdapter | null = null;
  try {
    adapter = await openDestination(input, deps);
    return { ok: true, message: await adapter.test() };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  } finally {
    await adapter?.close().catch(() => undefined);
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}
