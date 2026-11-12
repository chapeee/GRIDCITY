import type { Readable } from 'node:stream';
import type { ExploreInfo, ManageMode, SqlRowChange, SqlRowsRequest } from '@app/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { patchResourceInFile } from '../config/resources-writer';
import { errorMessage, redactSecrets } from '../connectors/connector';
import { ExploreHub, modeOf, type Explorer } from '../explore/hub';
import type { MongoExplorer } from '../explore/mongo';
import type { RedisEdit, RedisExplorer } from '../explore/redis';
import type { S3Explorer } from '../explore/s3';
import { ExploreError, type SqlExplorer } from '../explore/sql';
import type { AuditLog } from '../storage/audit-log';

export interface ExploreRouteDependencies {
  hub: ExploreHub;
  audit: AuditLog;
  resourcesFile: string;
  demoMode: boolean;
}

const MODE_KEYS = new Set(['manage']);
/** Large uploads stream straight to the storage; this is only a sanity cap. */
const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;

/**
 * The Manage view's API: `/api/explore/:id/…`, behind the session guard like
 * every route. Reads are open; every change is refused in read mode (by the
 * explorers, and by the databases themselves) and written to the audit log.
 */
export function registerExploreRoutes(app: FastifyInstance, deps: ExploreRouteDependencies): void {
  const { hub, audit } = deps;

  void app.register(async (scope) => {
    // Uploads arrive as the raw file; the stream goes to the storage without buffering.
    scope.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
      done(null, payload),
    );

    scope.setErrorHandler((error, _request, reply) => {
      if (error instanceof ExploreError) {
        const confirm = error.message.startsWith('CONFIRM:');
        return reply.code(error.status).send({
          error: confirm ? error.message.slice('CONFIRM:'.length) : error.message,
          ...(confirm ? { confirm: true } : {}),
        });
      }
      const status = (error as { statusCode?: number }).statusCode;
      if (status && status < 500) return reply.code(status).send({ error: errorMessage(error) });
      return reply.code(502).send({ error: redactSecrets(errorMessage(error)) });
    });

    const sql = async (id: string) => expect(await hub.get(id), 'sql') as SqlExplorer;
    const mongo = async (id: string) => expect(await hub.get(id), 'mongodb') as MongoExplorer;
    const redis = async (id: string) => expect(await hub.get(id), 'redis') as RedisExplorer;
    const s3 = async (id: string) => expect(await hub.get(id), 's3') as S3Explorer;
    const changed = (id: string, detail: string) =>
      audit.append('resource_changed', id, detail.slice(0, 300));

    type P = { Params: { id: string } };

    scope.get<P>('/api/explore/:id', async (request) => {
      if (deps.demoMode) throw new ExploreError('Manage is not available in demo mode', 404);
      const { config, explorer, mode } = await hub.get(request.params.id);
      const server = await serverVersion(explorer).catch(() => null);
      const info: ExploreInfo = {
        id: config.id,
        name: config.name ?? config.id,
        kind: config.kind as ExploreInfo['kind'],
        mode,
        server,
        target: targetOf(config as unknown as Record<string, unknown>),
      };
      return info;
    });

    scope.put<P & { Body: { mode: ManageMode } }>('/api/explore/:id/mode', async (request) => {
      const mode = z.enum(['read', 'write']).parse(request.body?.mode);
      const config = await hub.entry(request.params.id);
      if (modeOf(config) === mode) return { ok: true, mode };
      await patchResourceInFile(
        deps.resourcesFile,
        config.id,
        { manage: mode === 'write' ? 'write' : undefined },
        MODE_KEYS,
      );
      audit.append(
        'resource_edited',
        config.id,
        `Manage changes ${mode === 'write' ? 'on' : 'off'}`,
      );
      return { ok: true, mode };
    });

    // ------------------------------------------------------------------ SQL
    scope.get<P>('/api/explore/:id/sql/databases', async (request) => {
      const explorer = await sql(request.params.id);
      return { databases: await explorer.databases(), current: explorer.defaultDatabase() };
    });
    scope.get<P & { Querystring: { db: string } }>(
      '/api/explore/:id/sql/tables',
      async (request) => ({
        tables: await (await sql(request.params.id)).tables(request.query.db ?? ''),
      }),
    );
    scope.get<P & { Querystring: { db: string; schema: string; table: string } }>(
      '/api/explore/:id/sql/table',
      async (request) =>
        (await sql(request.params.id)).table(
          request.query.db ?? '',
          request.query.schema,
          request.query.table,
        ),
    );
    scope.post<P & { Body: SqlRowsRequest & { db: string } }>(
      '/api/explore/:id/sql/rows',
      async (request) => {
        const body = request.body;
        return (await sql(request.params.id)).rows(body.db ?? '', body);
      },
    );
    scope.post<P & { Body: { db: string; sql: string } }>(
      '/api/explore/:id/sql/query',
      async (request) => {
        const text = z.string().min(1).max(1_000_000).parse(request.body?.sql);
        const result = await (await sql(request.params.id)).query(request.body.db ?? '', text);
        if (result.mode === 'write' && result.results.some((r) => r.command !== 'SELECT')) {
          changed(request.params.id, `SQL: ${oneLine(text)}`);
        }
        return result;
      },
    );
    scope.post<
      P & { Body: { db: string; action: 'update' | 'insert' | 'delete'; change: SqlRowChange } }
    >('/api/explore/:id/sql/row', async (request) => {
      const { db, action, change } = request.body;
      const explorer = await sql(request.params.id);
      const where = `${change.schema}.${change.table}`;
      const affected =
        action === 'update'
          ? await explorer.updateRow(db ?? '', change)
          : action === 'insert'
            ? await explorer.insertRow(db ?? '', change)
            : action === 'delete'
              ? await explorer.deleteRow(db ?? '', change)
              : badAction();
      changed(request.params.id, `${action} row in ${where} (key ${keyText(change.key)})`);
      return { ok: true, affected };
    });

    // ------------------------------------------------------------------ MongoDB
    scope.get<P>('/api/explore/:id/mongo/databases', async (request) => {
      const explorer = await mongo(request.params.id);
      return { databases: await explorer.databases(), current: explorer.defaultDatabase() };
    });
    scope.get<P & { Querystring: { db: string } }>(
      '/api/explore/:id/mongo/collections',
      async (request) => ({
        collections: await (await mongo(request.params.id)).collections(request.query.db),
      }),
    );
    scope.post<P & { Body: Parameters<MongoExplorer['find']>[0] }>(
      '/api/explore/:id/mongo/find',
      async (request) => (await mongo(request.params.id)).find(request.body),
    );
    scope.post<P & { Body: { db: string; collection: string; pipeline: string } }>(
      '/api/explore/:id/mongo/aggregate',
      async (request) => {
        const { db, collection, pipeline } = request.body;
        const result = await (await mongo(request.params.id)).aggregate(db, collection, pipeline);
        if (/\$(out|merge)\b/.test(pipeline))
          changed(request.params.id, `aggregate with $out/$merge on ${db}.${collection}`);
        return result;
      },
    );
    scope.get<P & { Querystring: { db: string; collection: string } }>(
      '/api/explore/:id/mongo/indexes',
      async (request) => ({
        indexes: await (
          await mongo(request.params.id)
        ).indexes(request.query.db, request.query.collection),
      }),
    );
    scope.get<P>('/api/explore/:id/mongo/operations', async (request) => ({
      operations: await (await mongo(request.params.id)).currentOps(),
    }));
    scope.post<
      P & {
        Body: {
          db: string;
          collection: string;
          action: 'insert' | 'replace' | 'delete';
          id?: string;
          document?: string;
        };
      }
    >('/api/explore/:id/mongo/document', async (request) => {
      const { db, collection, action, id, document } = request.body;
      const explorer = await mongo(request.params.id);
      const where = `${db}.${collection}`;
      if (action === 'insert') {
        const insertedId = await explorer.insert(db, collection, document ?? '');
        changed(request.params.id, `insert document into ${where} (_id ${insertedId})`);
        return { ok: true, id: insertedId };
      }
      if (action === 'replace') await explorer.replace(db, collection, id ?? '', document ?? '');
      else if (action === 'delete') await explorer.remove(db, collection, id ?? '');
      else badAction();
      changed(request.params.id, `${action} document in ${where} (_id ${id ?? ''})`);
      return { ok: true };
    });
    scope.post<
      P & {
        Body: {
          db: string;
          collection: string;
          action: 'createIndex' | 'dropIndex' | 'createCollection' | 'dropCollection';
          keys?: string;
          name?: string;
          unique?: boolean;
          sparse?: boolean;
          ttlSeconds?: number | null;
        };
      }
    >('/api/explore/:id/mongo/admin', async (request) => {
      const { db, collection, action, keys, name, unique, sparse, ttlSeconds } = request.body;
      const explorer = await mongo(request.params.id);
      let result: string | undefined;
      if (action === 'createIndex')
        result = await explorer.createIndex(db, collection, keys ?? '', {
          unique,
          sparse,
          ttlSeconds,
          name,
        });
      else if (action === 'dropIndex') await explorer.dropIndex(db, collection, name ?? '');
      else if (action === 'createCollection') await explorer.createCollection(db, collection);
      else if (action === 'dropCollection') await explorer.dropCollection(db, collection);
      else badAction();
      changed(
        request.params.id,
        `${action} ${db}.${collection}${name || result ? ` (${name ?? result})` : ''}`,
      );
      return { ok: true, name: result };
    });

    // ------------------------------------------------------------------ Redis
    scope.get<P & { Querystring: { db?: string } }>(
      '/api/explore/:id/redis/overview',
      async (request) => (await redis(request.params.id)).overview(dbIndex(request.query.db)),
    );
    scope.post<P & { Body: { db?: number; pattern?: string; cursor?: string; type?: string } }>(
      '/api/explore/:id/redis/scan',
      async (request) => {
        const { db, pattern, cursor, type } = request.body ?? {};
        return (await redis(request.params.id)).scan(
          dbIndex(db),
          pattern ?? '*',
          cursor ?? '0',
          type || undefined,
        );
      },
    );
    scope.get<P & { Querystring: { db?: string; key: string; offset?: string } }>(
      '/api/explore/:id/redis/key',
      async (request) =>
        (await redis(request.params.id)).key(
          dbIndex(request.query.db),
          request.query.key,
          Number(request.query.offset ?? 0),
        ),
    );
    scope.post<P & { Body: { db?: number; args: string[]; confirm?: boolean } }>(
      '/api/explore/:id/redis/command',
      async (request) => {
        const args = z
          .array(z.string().max(512 * 1024))
          .min(1)
          .max(10_000)
          .parse(request.body?.args);
        const result = await (
          await redis(request.params.id)
        ).command(dbIndex(request.body.db), args, request.body.confirm === true);
        if (result.write)
          changed(
            request.params.id,
            `redis: ${args.slice(0, 2).join(' ')}${args.length > 2 ? ' …' : ''}`,
          );
        return result;
      },
    );
    scope.post<P & { Body: { db?: number; edit: RedisEdit } }>(
      '/api/explore/:id/redis/edit',
      async (request) => {
        const edit = request.body?.edit;
        if (!edit || typeof edit !== 'object') badAction();
        await (await redis(request.params.id)).edit(dbIndex(request.body.db), edit);
        const target = 'keys' in edit ? edit.keys.slice(0, 5).join(', ') : edit.key;
        changed(request.params.id, `redis ${edit.op} ${target}`);
        return { ok: true };
      },
    );
    scope.post<P & { Body: { db?: number; seconds?: number } }>(
      '/api/explore/:id/redis/monitor',
      async (request) =>
        (await redis(request.params.id)).monitor(
          dbIndex(request.body?.db),
          Number(request.body?.seconds ?? 5),
        ),
    );

    // ------------------------------------------------------------------ Object storage
    scope.get<P>('/api/explore/:id/s3/buckets', async (request) => ({
      buckets: await (await s3(request.params.id)).buckets(),
    }));
    scope.get<P & { Querystring: { bucket: string; prefix?: string; token?: string } }>(
      '/api/explore/:id/s3/list',
      async (request) =>
        (await s3(request.params.id)).list(
          request.query.bucket,
          request.query.prefix ?? '',
          request.query.token,
        ),
    );
    scope.get<P & { Querystring: { bucket: string; key: string } }>(
      '/api/explore/:id/s3/object',
      async (request) =>
        (await s3(request.params.id)).object(request.query.bucket, request.query.key),
    );
    scope.get<P & { Querystring: { bucket: string; key: string; inline?: string } }>(
      '/api/explore/:id/s3/download',
      async (request, reply) => {
        const { bucket, key, inline } = request.query;
        const file = await (await s3(request.params.id)).download(bucket, key);
        const name = key.split('/').pop() || 'download';
        reply.header(
          'content-type',
          inline ? safeInlineType(file.contentType) : 'application/octet-stream',
        );
        reply.header(
          'content-disposition',
          `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
        );
        reply.header('x-content-type-options', 'nosniff');
        // Previews are shown in a sandbox: never let a stored HTML file run as this app.
        reply.header(
          'content-security-policy',
          "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'",
        );
        if (file.size !== null) reply.header('content-length', String(file.size));
        return reply.send(file.body);
      },
    );
    scope.put<P & { Querystring: { bucket: string; key: string } }>(
      '/api/explore/:id/s3/upload',
      { bodyLimit: MAX_UPLOAD_BYTES },
      async (request) => {
        const { bucket, key } = request.query;
        const size = Number(request.headers['content-length']);
        if (!Number.isFinite(size) || size < 0)
          throw new ExploreError('the upload needs a Content-Length');
        if (size > MAX_UPLOAD_BYTES)
          throw new ExploreError('files over 5 GiB need a multipart tool', 413);
        const contentType = (request.headers['x-file-type'] as string | undefined) || null;
        await (
          await s3(request.params.id)
        ).upload(bucket, key, request.body as Readable, size, contentType);
        changed(request.params.id, `upload ${bucket}/${key} (${size} bytes)`);
        return { ok: true };
      },
    );
    scope.post<
      P & {
        Body: {
          bucket: string;
          action: 'delete' | 'folder' | 'copy' | 'move' | 'tags' | 'createBucket' | 'deleteBucket';
          keys?: string[];
          prefix?: string;
          from?: string;
          to?: string;
          key?: string;
          tags?: Record<string, string>;
        };
      }
    >('/api/explore/:id/s3/action', async (request) => {
      const body = request.body;
      const explorer = await s3(request.params.id);
      let detail = '';
      let count: number | undefined;
      switch (body.action) {
        case 'delete':
          count = await explorer.remove(body.bucket, body.keys ?? [], body.prefix);
          detail = `delete ${count} object(s) in ${body.bucket}${body.prefix ? ` under ${body.prefix}` : `: ${(body.keys ?? []).slice(0, 3).join(', ')}`}`;
          break;
        case 'folder':
          await explorer.createFolder(body.bucket, body.prefix ?? '');
          detail = `create folder ${body.bucket}/${body.prefix ?? ''}`;
          break;
        case 'copy':
        case 'move':
          await explorer.copy(body.bucket, body.from ?? '', body.to ?? '', body.action === 'move');
          detail = `${body.action} ${body.bucket}/${body.from ?? ''} -> ${body.to ?? ''}`;
          break;
        case 'tags':
          await explorer.setTags(body.bucket, body.key ?? '', body.tags ?? {});
          detail = `tags on ${body.bucket}/${body.key ?? ''}`;
          break;
        case 'createBucket':
          await explorer.createBucket(body.bucket);
          detail = `create bucket ${body.bucket}`;
          break;
        case 'deleteBucket':
          await explorer.deleteBucket(body.bucket);
          detail = `delete bucket ${body.bucket}`;
          break;
        default:
          badAction();
      }
      changed(request.params.id, detail);
      return { ok: true, count };
    });
    scope.get<P & { Querystring: { bucket: string } }>(
      '/api/explore/:id/s3/settings',
      async (request) => (await s3(request.params.id)).settings(request.query.bucket),
    );
    scope.put<
      P & {
        Body: {
          bucket: string;
          setting: 'policy' | 'cors' | 'versioning';
          value: string | boolean | null;
        };
      }
    >('/api/explore/:id/s3/settings', async (request) => {
      const { bucket, setting, value } = request.body;
      const explorer = await s3(request.params.id);
      if (setting === 'policy')
        await explorer.setPolicy(bucket, typeof value === 'string' ? value : null);
      else if (setting === 'cors')
        await explorer.setCors(bucket, typeof value === 'string' ? value : null);
      else if (setting === 'versioning') await explorer.setVersioning(bucket, value === true);
      else badAction();
      changed(request.params.id, `${setting} on bucket ${bucket}`);
      return { ok: true };
    });
    scope.get<P & { Querystring: { bucket: string } }>(
      '/api/explore/:id/s3/usage',
      async (request) => (await s3(request.params.id)).usage(request.query.bucket),
    );
  });
}

function expect(session: { explorer: Explorer }, kind: Explorer['kind']) {
  if (session.explorer.kind !== kind)
    throw new ExploreError(`this resource is not ${kind === 'sql' ? 'a SQL database' : kind}`, 400);
  return session.explorer.explorer;
}

async function serverVersion(explorer: Explorer): Promise<string | null> {
  switch (explorer.kind) {
    case 'sql':
    case 'mongodb':
    case 'redis':
      return explorer.explorer.serverVersion();
    case 's3':
      return null;
  }
}

function targetOf(config: Record<string, unknown>): string {
  if (typeof config.path === 'string') return config.path;
  if (typeof config.url === 'string') return config.url.replace(/\/\/[^@/]*@/, '//');
  if (typeof config.endpoint === 'string') return config.endpoint;
  if (typeof config.host === 'string') return `${config.host}:${String(config.port ?? '')}`;
  if (typeof config.region === 'string') return `AWS ${config.region}`;
  return '';
}

function dbIndex(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isInteger(n) && n >= 0 && n < 10_000 ? n : 0;
}

/** Inline previews only for types a browser shows without running code. */
function safeInlineType(type: string | null): string {
  const value = (type ?? '').toLowerCase();
  if (
    /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/|audio\/|application\/pdf|text\/plain|application\/json)/.test(
      value,
    )
  )
    return value;
  if (value.startsWith('text/')) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 200);
const keyText = (key: Record<string, unknown>) => oneLine(JSON.stringify(key));

function badAction(): never {
  throw new ExploreError('unknown action');
}

export type { FastifyReply };
