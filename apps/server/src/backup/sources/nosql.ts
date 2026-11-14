import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { BSON } from 'bson';
import Redis from 'ioredis';
import { MongoClient, type Document } from 'mongodb';
import type { ResourceConfig, ResourceConfigOf } from '../../config/resources-file';
import { expandHome } from '../../config/app-paths';
import { tlsOptions } from '../../connectors/connector';
import { openSqlite } from '../../storage/sqlite';
import { DEFAULT_IMAGES, shellQuote, wrapForMode } from '../runner';
import { describeMode } from './databases';
import { fromProcess, intoProcess, type SourceAdapter, type SourceContext } from './types';

const asKind = <K extends ResourceConfig['kind']>(resource: ResourceConfig | undefined, kind: K) =>
  resource?.kind === kind ? (resource as ResourceConfigOf<K>) : undefined;

/**
 * Reads a stream of concatenated BSON documents (each starts with its own
 * little-endian int32 length), the format of GRIDCITY's driver backups.
 */
export async function* readBsonRecords(input: Readable): AsyncGenerator<Document> {
  let buffer: Buffer = Buffer.alloc(0);
  for await (const chunk of input as AsyncIterable<Buffer>) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readInt32LE(0);
      if (size < 5 || size > 64 * 1024 * 1024) throw new Error('damaged backup: bad record length');
      if (buffer.length < size) break;
      yield BSON.deserialize(buffer.subarray(0, size), { promoteBuffers: true });
      buffer = buffer.subarray(size);
    }
  }
  if (buffer.length > 0) throw new Error('damaged backup: the last record is cut off');
}

/** A readable that the producer writes BSON records into, honouring back-pressure. */
function recordWriter() {
  const stream = new PassThrough({ highWaterMark: 1024 * 1024 });
  const write = async (doc: Document) => {
    if (!stream.write(BSON.serialize(doc))) {
      await new Promise<void>((resolve) => stream.once('drain', resolve));
    }
  };
  return { stream, write };
}

// ── MongoDB ───────────────────────────────────────────────────────────────

const SYSTEM_DBS = new Set(['admin', 'local', 'config']);

function mongoClient(context: SourceContext, config: ResourceConfigOf<'mongodb'>): MongoClient {
  // The user may be in the URL ("mongodb://root@host"); the driver needs it next to the password.
  const urlUser = /^mongodb(?:\+srv)?:\/\/([^:@/]+)@/.exec(config.url)?.[1];
  const username = config.user ?? (urlUser ? decodeURIComponent(urlUser) : undefined);
  return new MongoClient(config.url, {
    ...(username || context.password ? { auth: { username, password: context.password } } : {}),
    ...(config.authSource ? { authSource: config.authSource } : {}),
    ...(config.tls !== undefined ? { tls: config.tls } : {}),
    ...(config.tlsVerify === false ? { tlsAllowInvalidCertificates: true } : {}),
    ...(config.tlsCa ? { ca: config.tlsCa } : {}),
    serverSelectionTimeoutMS: 10_000,
    appName: context.connectorContext.appName,
  });
}

function databaseFromUrl(url: string): string | undefined {
  const match = /^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/.exec(url);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/** The URL as the tool sees it: no password; inside the DB container it is 127.0.0.1. */
function toolUrl(context: SourceContext, config: ResourceConfigOf<'mongodb'>): string {
  let url = config.url;
  if (context.source.tool.mode === 'docker-exec') {
    url = url.replace(/^(mongodb:\/\/(?:[^@/]*@)?)[^/?]+/, `$1127.0.0.1:27017`);
  } else if (
    context.source.tool.mode === 'docker-image' &&
    context.runner.isLocal &&
    process.platform !== 'linux'
  ) {
    url = url.replace(/(@|\/\/)(localhost|127\.0\.0\.1)(?=[:/?]|$)/g, '$1host.docker.internal');
  }
  if (config.user && !/\/\/[^/]*@/.test(url)) {
    url = url.replace(/^(mongodb(?:\+srv)?:\/\/)/, `$1${encodeURIComponent(config.user)}@`);
  }
  if (config.authSource && !/[?&]authSource=/.test(url)) {
    url += `${url.includes('?') ? '&' : '?'}authSource=${encodeURIComponent(config.authSource)}`;
  }
  return url;
}

/** mongodump/mongorestore read the password from a 0600 config file written by the shell (printf is a builtin). */
function mongoToolScript(command: string): string {
  return [
    'set -e',
    'umask 077',
    'cfg="/tmp/.gridcity-mongo-$$.yaml"',
    `trap 'rm -f "$cfg"' EXIT`,
    'cfgarg=""',
    // YAML single-quoted scalar: a quote inside is doubled. The password only travels through a pipe.
    `if [ -n "\${MONGO_PASSWORD:-}" ]; then printf "password: '%s'\\n" "$(printf %s "$MONGO_PASSWORD" | sed "s/'/''/g")" > "$cfg"; cfgarg="--config=$cfg"; fi`,
    command,
  ].join('\n');
}

export const mongoAdapter: SourceAdapter = {
  kind: 'mongodb',
  validate: (source, resource) => [
    ...(resource ? [] : ['choose the MongoDB connection to back up']),
    ...(resource && resource.kind !== 'mongodb' ? ['the chosen connection is not MongoDB'] : []),
    ...(source.tool.mode === 'docker-exec' && !source.tool.container
      ? ['docker exec needs the container name']
      : []),
    ...(source.tool.mode === 'native' &&
    source.tool.runner === 'local' &&
    process.platform === 'win32'
      ? ['on this machine use "GRIDCITY itself" or Docker mode']
      : []),
  ],
  targetLabel: (source, resource) => {
    const config = asKind(resource, 'mongodb');
    const db = source.database || (config ? databaseFromUrl(config.url) : undefined);
    return `${db ?? 'all databases'} on ${resource?.name ?? resource?.id ?? 'MongoDB'}`;
  },
  async backup(context) {
    const config = asKind(context.resource, 'mongodb')!;
    const only = context.source.database || databaseFromUrl(config.url);
    if (context.source.tool.mode !== 'driver') {
      const env: Record<string, string> = context.password
        ? { MONGO_PASSWORD: context.password }
        : {};
      const command = `mongodump --quiet $cfgarg --uri ${shellQuote(toolUrl(context, config))} --archive${only ? ` --db=${shellQuote(only)}` : ''}`;
      const argv = wrapForMode(
        ['sh', '-c', mongoToolScript(command)],
        Object.keys(env),
        context.source.tool,
        context.runner,
        DEFAULT_IMAGES.mongodb!,
      );
      context.log('info', `Running mongodump --archive via ${describeMode(context)}`);
      const { stream, done } = fromProcess(
        await context.runner.spawn(argv, env),
        'mongodump',
        context.signal,
      );
      return {
        stream,
        done,
        contentFormat: 'mongodump archive',
        extension: '.archive',
        tool: 'mongodump',
        details: { database: only ?? null },
      };
    }

    const client = mongoClient(context, config);
    await client.connect();
    const { stream, write } = recordWriter();
    const done = (async () => {
      try {
        const names = only
          ? [only]
          : (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases
              .map((d) => d.name)
              .filter((n) => !SYSTEM_DBS.has(n));
        await write({ t: 'h', format: 'gridcity-mongo', v: 1, databases: names });
        let documents = 0;
        for (const dbName of names) {
          const db = client.db(dbName);
          const collections = await db.listCollections({}, { nameOnly: false }).toArray();
          for (const info of collections) {
            if (context.signal.aborted) throw new Error('cancelled');
            if (info.type === 'view') {
              await write({ t: 'v', db: dbName, name: info.name, options: info.options ?? {} });
              continue;
            }
            if (info.name.startsWith('system.')) continue;
            const indexes = await db.collection(info.name).indexes();
            await write({
              t: 'c',
              db: dbName,
              name: info.name,
              options: info.options ?? {},
              indexes,
            });
            for await (const doc of db.collection(info.name).find({}, { batchSize: 1000 })) {
              await write({ t: 'd', db: dbName, c: info.name, d: doc });
              documents++;
            }
          }
          context.log('info', `Database "${dbName}": ${collections.length} collections`);
        }
        await write({ t: 'e', documents });
        context.log('info', `${documents.toLocaleString()} documents written`);
        stream.end();
      } catch (error) {
        stream.destroy(error as Error);
        throw error;
      } finally {
        await client.close().catch(() => undefined);
      }
    })();
    done.catch(() => undefined);
    return {
      stream,
      done,
      contentFormat: 'gridcity-mongo v1 (BSON records)',
      extension: '.bson',
      tool: 'mongodb driver',
      details: { database: only ?? null },
    };
  },
  async restore(context, input) {
    const config = asKind(context.resource, 'mongodb')!;
    const original = context.manifest.source.details.database as string | null;
    const target = context.source.database || original || undefined;
    if (context.manifest.source.tool === 'mongodump') {
      const env: Record<string, string> = context.password
        ? { MONGO_PASSWORD: context.password }
        : {};
      const rename =
        original && target && original !== target
          ? ` --nsFrom=${shellQuote(`${original}.*`)} --nsTo=${shellQuote(`${target}.*`)}`
          : '';
      const command = `mongorestore --quiet $cfgarg --uri ${shellQuote(toolUrl(context, config))} --archive --drop${rename}`;
      const argv = wrapForMode(
        ['sh', '-c', mongoToolScript(command)],
        Object.keys(env),
        context.source.tool,
        context.runner,
        DEFAULT_IMAGES.mongodb!,
      );
      context.log('info', `Running mongorestore --drop via ${describeMode(context)}`);
      await intoProcess(
        await context.runner.spawn(argv, env),
        input,
        'mongorestore',
        context.signal,
      );
      return;
    }
    const client = mongoClient(context, config);
    await client.connect();
    try {
      const mapDb = (db: string) => (original && target && db === original ? target : db);
      let batch: Document[] = [];
      let batchKey = '';
      let documents = 0;
      const flush = async () => {
        if (batch.length === 0) return;
        const [db, c] = JSON.parse(batchKey) as [string, string];
        await client.db(db).collection(c).insertMany(batch, { ordered: false });
        documents += batch.length;
        batch = [];
      };
      for await (const record of readBsonRecords(input)) {
        if (context.signal.aborted) throw new Error('cancelled');
        if (record.t === 'c') {
          await flush();
          const db = client.db(mapDb(record.db as string));
          const name = record.name as string;
          await db
            .collection(name)
            .drop()
            .catch(() => undefined);
          const { ...options } = (record.options ?? {}) as Document;
          await db.createCollection(name, options);
          const indexes = ((record.indexes ?? []) as Document[]).filter((i) => i.name !== '_id_');
          if (indexes.length > 0) {
            await db.collection(name).createIndexes(
              indexes.map((index) => {
                const spec: Document = { ...index };
                delete spec.v;
                delete spec.ns;
                return spec;
              }) as never,
            );
          }
        } else if (record.t === 'v') {
          const db = client.db(mapDb(record.db as string));
          await db
            .collection(record.name as string)
            .drop()
            .catch(() => undefined);
          await db.createCollection(record.name as string, record.options as Document);
        } else if (record.t === 'd') {
          const key = JSON.stringify([mapDb(record.db as string), record.c]);
          if (key !== batchKey) {
            await flush();
            batchKey = key;
          }
          batch.push(record.d as Document);
          if (batch.length >= 1000) await flush();
        }
      }
      await flush();
      context.log('info', `${documents.toLocaleString()} documents restored`);
    } finally {
      await client.close().catch(() => undefined);
    }
  },
  async check(context) {
    const config = asKind(context.resource, 'mongodb')!;
    const target =
      context.source.database ||
      (context.manifest.source.details.database as string | null) ||
      undefined;
    const client = mongoClient(context, config);
    await client.connect();
    try {
      if (target) {
        const collections = await client.db(target).listCollections().toArray();
        return `${collections.length} collections in "${target}"`;
      }
      const dbs = await client.db('admin').admin().listDatabases({ nameOnly: true });
      return `${dbs.databases.length} databases`;
    } finally {
      await client.close().catch(() => undefined);
    }
  },
};

// ── Redis / Valkey ────────────────────────────────────────────────────────

function redisClient(context: SourceContext, config: ResourceConfigOf<'redis'>, db = 0): Redis {
  return new Redis({
    host: context.source.host || config.host,
    port: context.source.port ?? config.port,
    username: config.user,
    password: context.password,
    tls: tlsOptions(config),
    db,
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    connectTimeout: 10_000,
    enableOfflineQueue: true,
  });
}

/** Database numbers that hold keys ("db0:keys=12,expires=0"). */
export function keyspaceDbs(info: string): { db: number; keys: number }[] {
  const out: { db: number; keys: number }[] = [];
  for (const line of info.split(/\r?\n/)) {
    const m = /^db(\d+):keys=(\d+)/.exec(line);
    if (m) out.push({ db: Number(m[1]), keys: Number(m[2]) });
  }
  return out;
}

export const redisAdapter: SourceAdapter = {
  kind: 'redis',
  validate: (_source, resource) => [
    ...(resource ? [] : ['choose the Redis / Valkey connection to back up']),
    ...(resource && resource.kind !== 'redis' ? ['the chosen connection is not Redis'] : []),
  ],
  targetLabel: (_source, resource) =>
    `every database on ${resource?.name ?? resource?.id ?? 'Redis'}`,
  async backup(context) {
    const config = asKind(context.resource, 'redis')!;
    const client = redisClient(context, config);
    await client.connect();
    const { stream, write } = recordWriter();
    const done = (async () => {
      try {
        const info = await client.info('keyspace');
        const dbs = keyspaceDbs(info);
        const total = dbs.reduce((sum, d) => sum + d.keys, 0);
        context.log(
          'info',
          `${total.toLocaleString()} keys in ${dbs.length} database(s); using DUMP (Redis's own serialization)`,
        );
        await write({ t: 'h', format: 'gridcity-redis', v: 1, databases: dbs });
        let written = 0;
        for (const { db } of dbs) {
          await client.select(db);
          let cursor = '0';
          do {
            if (context.signal.aborted) throw new Error('cancelled');
            const [next, keys] = await client.scanBuffer(cursor, 'COUNT', 1000);
            cursor = next.toString();
            if (keys.length === 0) continue;
            const pipe = client.pipeline();
            for (const key of keys) {
              pipe.dumpBuffer(key);
              pipe.pttl(key);
            }
            const results = (await pipe.exec()) ?? [];
            for (let i = 0; i < keys.length; i++) {
              const [dumpError, value] = results[i * 2] ?? [];
              const [, ttl] = results[i * 2 + 1] ?? [];
              if (dumpError) throw dumpError;
              if (value === null || value === undefined) continue; // expired meanwhile
              await write({ t: 'k', db, k: keys[i], ttl: Number(ttl), v: value as Buffer });
              written++;
            }
          } while (cursor !== '0');
        }
        await write({ t: 'e', keys: written });
        context.log('info', `${written.toLocaleString()} keys written`);
        stream.end();
      } catch (error) {
        stream.destroy(error as Error);
        throw error;
      } finally {
        client.disconnect();
      }
    })();
    done.catch(() => undefined);
    return {
      stream,
      done,
      contentFormat: 'gridcity-redis v1 (DUMP payloads)',
      extension: '.bson',
      tool: 'DUMP',
      details: { host: config.host, port: config.port },
    };
  },
  async restore(context, input) {
    const config = asKind(context.resource, 'redis')!;
    const client = redisClient(context, config);
    await client.connect();
    try {
      let current = -1;
      let pipe = client.pipeline();
      let pending = 0;
      let restored = 0;
      const flush = async () => {
        if (pending === 0) return;
        const results = (await pipe.exec()) ?? [];
        const failed = results.find(([error]) => error);
        if (failed?.[0]) throw failed[0];
        restored += pending;
        pending = 0;
        pipe = client.pipeline();
      };
      for await (const record of readBsonRecords(input)) {
        if (record.t !== 'k') continue;
        if (context.signal.aborted) throw new Error('cancelled');
        const db = record.db as number;
        if (db !== current) {
          await flush();
          await client.select(db);
          current = db;
        }
        const ttl = record.ttl as number;
        pipe.restore(record.k as Buffer, ttl > 0 ? ttl : 0, record.v as Buffer, 'REPLACE');
        pending++;
        if (pending >= 500) await flush();
      }
      await flush();
      context.log(
        'info',
        `${restored.toLocaleString()} keys restored (existing keys with the same name replaced)`,
      );
    } finally {
      client.disconnect();
    }
  },
  async check(context) {
    const config = asKind(context.resource, 'redis')!;
    const client = redisClient(context, config);
    await client.connect();
    try {
      const dbs = keyspaceDbs(await client.info('keyspace'));
      return `${dbs.reduce((s, d) => s + d.keys, 0).toLocaleString()} keys`;
    } finally {
      client.disconnect();
    }
  },
};

// ── SQLite ────────────────────────────────────────────────────────────────

function sqlitePath(context: SourceContext): string {
  const path = context.source.path || asKind(context.resource, 'sqlite')?.path;
  if (!path) throw new Error('no SQLite file path');
  return context.runner.isLocal ? expandHome(path, context.connectorContext.homeDir) : path;
}

export const sqliteAdapter: SourceAdapter = {
  kind: 'sqlite',
  validate: (source, resource) => [
    ...(source.path || resource?.kind === 'sqlite'
      ? []
      : ['choose a SQLite connection or enter the file path']),
    ...(source.tool.mode === 'driver' && source.tool.runner !== 'local'
      ? ['a file on a server is copied with the sqlite3 tool there: choose "installed"']
      : []),
  ],
  targetLabel: (source, resource) =>
    `${source.path || (resource as ResourceConfigOf<'sqlite'>)?.path || 'SQLite file'}${source.tool.runner !== 'local' ? ` on ${source.tool.runner}` : ''}`,
  async backup(context) {
    const path = sqlitePath(context);
    if (context.source.tool.mode === 'driver' && context.runner.isLocal) {
      if (!existsSync(path)) throw new Error(`${path} does not exist`);
      // VACUUM INTO: a consistent snapshot while the app keeps writing.
      const dir = await mkdtemp(join(tmpdir(), 'gridcity-sqlite-'));
      const snapshot = join(dir, 'snapshot.db');
      const db = openSqlite(path, { readonly: true, fileMustExist: true, timeout: 10_000 });
      try {
        db.prepare('VACUUM INTO ?').run(snapshot);
      } finally {
        db.close();
      }
      const size = (await stat(snapshot)).size;
      context.setTotal(size, false);
      context.log(
        'info',
        `Consistent snapshot taken with VACUUM INTO (${size.toLocaleString()} bytes)`,
      );
      const stream = createReadStream(snapshot);
      const done = new Promise<void>((resolve, reject) => {
        stream.on('close', resolve);
        stream.on('error', reject);
      }).finally(() => rm(dir, { recursive: true, force: true }));
      return {
        stream,
        done,
        contentFormat: 'SQLite database file',
        extension: '.sqlite',
        tool: 'VACUUM INTO',
        details: { path },
      };
    }
    const script = [
      'set -e',
      'tmp="${TMPDIR:-/tmp}/gridcity-sqlite-$$.db"',
      'trap \'rm -f "$tmp"\' EXIT',
      `sqlite3 ${shellQuote(path)} ".backup '$tmp'"`,
      'cat "$tmp"',
    ].join('\n');
    const argv = wrapForMode(['sh', '-c', script], [], context.source.tool, context.runner, '');
    context.log('info', `Running sqlite3 .backup on ${context.runner.label}`);
    const { stream, done } = fromProcess(
      await context.runner.spawn(argv),
      'sqlite3 .backup',
      context.signal,
    );
    return {
      stream,
      done,
      contentFormat: 'SQLite database file',
      extension: '.sqlite',
      tool: 'sqlite3 .backup',
      details: { path },
    };
  },
  async restore(context, input) {
    const path = sqlitePath(context);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (context.runner.isLocal) {
      const partial = `${path}.gridcity-partial`;
      await pipeline(input, createWriteStream(partial));
      // Never delete the current file: it is kept next to the restored one.
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        if (existsSync(path + suffix)) {
          await rename(path + suffix, `${path}.pre-restore-${stamp}${suffix}`);
          context.log(
            'info',
            `Kept the previous ${suffix || 'database'} file as ${path}.pre-restore-${stamp}${suffix}`,
          );
        }
      }
      await rename(partial, path);
      return;
    }
    const q = shellQuote(path);
    const script = [
      'set -e',
      `mkdir -p ${shellQuote(dirname(path))}`,
      `cat > ${q}.gridcity-partial`,
      `for s in '' -wal -shm -journal; do if [ -e ${q}"$s" ]; then mv ${q}"$s" ${q}.pre-restore-${stamp}"$s"; fi; done`,
      `mv ${q}.gridcity-partial ${q}`,
    ].join('\n');
    const argv = wrapForMode(['sh', '-c', script], [], context.source.tool, context.runner, '');
    await intoProcess(
      await context.runner.spawn(argv),
      input,
      'writing the SQLite file',
      context.signal,
    );
    context.log('info', `Kept the previous file as ${path}.pre-restore-${stamp}`);
  },
  async check(context) {
    if (!context.runner.isLocal) return 'file written';
    const db = openSqlite(sqlitePath(context), { readonly: true, fileMustExist: true });
    try {
      const ok = db.pragma('integrity_check', { simple: true });
      const tables = db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table'")
        .get() as { n: number };
      return `integrity_check: ${String(ok)} · ${tables.n} tables`;
    } finally {
      db.close();
    }
  },
};
