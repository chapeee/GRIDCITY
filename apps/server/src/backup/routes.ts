import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join, posix } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  BACKUP_SOURCE_LABELS,
  DestinationInputSchema,
  JobInputSchema,
  RestoreInputSchema,
  SOURCE_CAPABILITIES,
  SourceSchema,
  type BackupDashboard,
  type BackupEvent,
  type DestinationView,
  type JobView,
} from '@app/shared';
import { expandHome } from '../config/app-paths';
import type { ResourceConfig } from '../config/resources-file';
import { errorMessage, type ConnectorContext } from '../connectors/connector';
import { clientConfig } from '../connectors/s3';
import { describeCron } from './cron';
import {
  browseLocal,
  browseS3,
  browseSftp,
  testDestination,
  type DestinationDeps,
} from './destinations';
import { discover } from './discovery';
import { BackupEngine, BackupError, passphraseId, sourcePasswordId } from './engine';
import { runToEnd, type Runner } from './runner';
import { SOURCE_ADAPTERS } from './sources';
import type { BackupStore } from './store';
import { zstdAvailable } from './streams';
import type { SecretStore } from '../storage/secret-vault';

export interface BackupRouteDeps {
  engine: BackupEngine | null;
  store: BackupStore | null;
  vault: SecretStore;
  demoMode: boolean;
  context: ConnectorContext;
  destinationDeps: DestinationDeps;
  resources(): Promise<ReadonlyMap<string, ResourceConfig>>;
  hosts(): { id: string; name: string; connected: boolean }[];
  /** Suggested folder for local backups (inside the data folder). */
  defaultLocalDir: string;
  subscribe(listener: (event: BackupEvent) => void): () => void;
}

const BrowseSchema = z.strictObject({
  kind: z.enum(['local', 's3', 'sftp']),
  path: z.string().max(1000).default(''),
  resourceId: z.string().max(200).optional(),
  hostId: z.string().max(200).optional(),
  /** mkdir: the new folder's name. */
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^/\\\0:*?"<>|]+$/, 'not a folder name')
    .optional(),
});

export function registerBackupRoutes(app: FastifyInstance, deps: BackupRouteDeps): void {
  const unavailable = (reply: FastifyReply) =>
    reply.code(409).send({
      error: 'Demo data: backups need real servers and databases (start without --demo).',
    });

  const handle = async <T>(
    reply: FastifyReply,
    work: () => Promise<T> | T,
  ): Promise<T | FastifyReply> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof BackupError)
        return reply.code(error.status).send({ error: error.message });
      return reply.code(500).send({ error: errorMessage(error) });
    }
  };

  const ready = () =>
    deps.engine && deps.store ? { engine: deps.engine, store: deps.store } : null;

  const jobView = async (
    engine: BackupEngine,
    store: BackupStore,
    id: string,
  ): Promise<JobView> => {
    const job = store.job(id)!;
    const hasPassphrase = deps.vault.has(passphraseId(id));
    const hasSourcePassword = deps.vault.has(sourcePasswordId(id));
    return {
      ...job.config,
      id: job.id,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      hasPassphrase,
      hasSourcePassword,
      lastRun: store.runs({ jobId: id, limit: 1 })[0] ?? null,
      nextRunAt: job.nextRunAt,
      problems: await engine.jobProblems(job.config, hasPassphrase, hasSourcePassword),
    };
  };

  // ── read ──
  app.get('/api/backup/options', async () => {
    const resources = [...(await deps.resources()).values()].map((r) => ({
      id: r.id,
      name: r.name ?? r.id,
      kind: r.kind,
      buckets: r.kind === 's3' ? (r.buckets ?? null) : null,
      database: 'database' in r ? (r.database ?? null) : null,
    }));
    return {
      demo: deps.demoMode,
      hosts: deps.hosts(),
      resources,
      capabilities: SOURCE_CAPABILITIES,
      labels: BACKUP_SOURCE_LABELS,
      zstd: zstdAvailable(),
      defaultLocalDir: deps.defaultLocalDir,
      platform: process.platform,
    };
  });

  app.get('/api/backup/overview', async (_req, reply) => {
    const r = ready();
    if (!r) {
      const empty: BackupDashboard = {
        health: 'empty',
        healthReasons: [],
        jobs: 0,
        activeOperations: [],
        last7Days: { success: 0, failed: 0, partial: 0 },
        last30Days: { success: 0, failed: 0, partial: 0 },
        daily: [],
        storage: [],
        upcoming: [],
        recent: [],
        unread: 0,
      };
      return deps.demoMode ? empty : unavailable(reply);
    }
    const { engine, store } = r;
    const now = Date.now();
    const jobs = store.jobs();
    const runs30 = store.runs({ since: now - 30 * 86_400_000, limit: 100_000 });
    const count = (list: typeof runs30) => ({
      success: list.filter((x) => x.status === 'success').length,
      failed: list.filter((x) => x.status === 'failed' || x.status === 'interrupted').length,
      partial: list.filter((x) => x.status === 'partial').length,
    });
    const daily: BackupDashboard['daily'] = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(now - i * 86_400_000);
      const key = day.toISOString().slice(0, 10);
      const ofDay = runs30.filter((x) => new Date(x.startedAt).toISOString().slice(0, 10) === key);
      daily.push({
        date: key,
        success: ofDay.filter((x) => x.status === 'success').length,
        failed: ofDay.filter(
          (x) => x.status === 'failed' || x.status === 'partial' || x.status === 'interrupted',
        ).length,
      });
    }
    const reasons: string[] = [];
    let failing = 0;
    let warning = 0;
    for (const job of jobs) {
      const last = store
        .runs({ jobId: job.id, limit: 5 })
        .find((x) => x.status !== 'running' && x.status !== 'cancelled');
      if (!last) {
        warning++;
        reasons.push(`${job.name}: never backed up yet`);
      } else if (last.status === 'failed' || last.status === 'interrupted') {
        failing++;
        reasons.push(`${job.name}: last backup failed (${last.error ?? 'unknown error'})`);
      } else if (last.status === 'partial') {
        warning++;
        reasons.push(`${job.name}: last backup did not reach every destination`);
      } else if (
        job.nextRunAt &&
        job.config.schedule &&
        now - last.startedAt > 3 * (job.nextRunAt - last.startedAt) &&
        job.nextRunAt > last.startedAt
      ) {
        warning++;
        reasons.push(`${job.name}: no recent backup`);
      }
      const problems = await engine.jobProblems(
        job.config,
        deps.vault.has(passphraseId(job.id)),
        deps.vault.has(sourcePasswordId(job.id)),
      );
      if (problems.length > 0) {
        warning++;
        reasons.push(`${job.name}: ${problems[0]}`);
      }
    }
    const storage = store.storageByDestination();
    const dashboard: BackupDashboard = {
      health:
        jobs.length === 0 ? 'empty' : failing > 0 ? 'failing' : warning > 0 ? 'warning' : 'healthy',
      healthReasons: reasons,
      jobs: jobs.length,
      activeOperations: engine.operations(),
      last7Days: count(runs30.filter((x) => x.startedAt >= now - 7 * 86_400_000)),
      last30Days: count(runs30),
      daily,
      storage: store.destinations().map((d) => ({
        destinationId: d.id,
        name: d.input.name,
        kind: d.input.kind,
        bytes: storage.get(d.id)?.bytes ?? 0,
        count: storage.get(d.id)?.count ?? 0,
      })),
      upcoming: jobs
        .filter((j) => j.nextRunAt !== null)
        .map((j) => ({ jobId: j.id, jobName: j.name, at: j.nextRunAt! }))
        .sort((a, b) => a.at - b.at)
        .slice(0, 8),
      recent: store.runs({ limit: 10 }),
      unread: store.unread(),
    };
    return dashboard;
  });

  app.get('/api/backup/destinations', async (_req, reply) => {
    const r = ready();
    if (!r) return deps.demoMode ? [] : unavailable(reply);
    const storage = r.store.storageByDestination();
    const jobs = r.store.jobs();
    return r.store.destinations().map((d): DestinationView => ({
      ...d.input,
      id: d.id,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      usedBy: jobs.filter((j) => j.config.destinationIds.includes(d.id)).map((j) => j.name),
      storedBytes: storage.get(d.id)?.bytes ?? 0,
      backupCount: storage.get(d.id)?.count ?? 0,
    }));
  });

  app.get('/api/backup/jobs', async (_req, reply) => {
    const r = ready();
    if (!r) return deps.demoMode ? [] : unavailable(reply);
    return Promise.all(r.store.jobs().map((j) => jobView(r.engine, r.store, j.id))).then((jobs) =>
      jobs.map((j) => ({ ...j, scheduleText: j.schedule ? describeCron(j.schedule) : null })),
    );
  });

  app.get<{ Querystring: { jobId?: string; status?: string; limit?: string; offset?: string } }>(
    '/api/backup/runs',
    async (request, reply) => {
      const r = ready();
      if (!r) return deps.demoMode ? [] : unavailable(reply);
      const q = request.query;
      return r.store.runs({
        jobId: q.jobId || undefined,
        status: q.status || undefined,
        limit: Math.min(500, Number(q.limit) || 50),
        offset: Number(q.offset) || 0,
      });
    },
  );

  app.get<{ Params: { id: string } }>('/api/backup/runs/:id', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const run = r.store.run(request.params.id);
    if (!run) return reply.code(404).send({ error: 'backup not found' });
    return { run, manifest: r.store.manifest(run.id), logs: r.store.logs(run.id) };
  });

  app.get<{ Params: { id: string } }>('/api/backup/logs/:id', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    return r.store.logs(request.params.id);
  });

  app.get('/api/backup/restores', async (_req, reply) => {
    const r = ready();
    if (!r) return deps.demoMode ? [] : unavailable(reply);
    return r.store.restores();
  });

  app.get('/api/backup/notifications', async (_req, reply) => {
    const r = ready();
    if (!r) return deps.demoMode ? [] : unavailable(reply);
    return r.store.notifications();
  });

  app.get('/api/backup/discover', async (_req, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    return handle(reply, () =>
      discover({
        resources: deps.resources,
        runners: () => [
          r.engine.runnerFor('local'),
          ...deps
            .hosts()
            .filter((h) => h.connected)
            .map((h) => r.engine.runnerFor(h.id)),
        ],
        jobs: () => r.store.jobs(),
      }),
    );
  });

  /** Live progress, logs and notifications (Server-Sent Events). */
  app.get('/api/backup/events', (request, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    // Flushes the headers now, so the browser knows the stream is open.
    raw.write(': connected\n\n');
    const send = (event: BackupEvent) => raw.write(`data: ${JSON.stringify(event)}\n\n`);
    for (const operation of deps.engine?.operations() ?? []) send({ type: 'progress', operation });
    const unsubscribe = deps.subscribe(send);
    const ping = setInterval(() => raw.write(': ping\n\n'), 15_000);
    request.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ── write ──
  app.post('/api/backup/browse', async (request, reply) => {
    if (deps.demoMode) return unavailable(reply);
    const body = BrowseSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(400).send({ error: body.error.issues[0]?.message ?? 'bad request' });
    const { kind, path, resourceId, hostId } = body.data;
    return handle(reply, async () => {
      if (kind === 'local') return browseLocal(path, deps.context.homeDir);
      if (kind === 'sftp') {
        if (!hostId) throw new BackupError('choose a server');
        return browseSftp(hostId, path, deps.destinationDeps);
      }
      const config = resourceId ? await deps.destinationDeps.s3Config(resourceId) : undefined;
      if (!config) throw new BackupError('choose a storage account');
      const [bucket = '', ...rest] = path.split('/');
      return browseS3(config, bucket, rest.join('/'), deps.context);
    });
  });

  app.post('/api/backup/browse/mkdir', async (request, reply) => {
    if (deps.demoMode) return unavailable(reply);
    const body = BrowseSchema.safeParse(request.body);
    if (!body.success || !body.data.name)
      return reply
        .code(400)
        .send({ error: body.error?.issues[0]?.message ?? 'enter a folder name' });
    const { kind, path, resourceId, hostId, name } = body.data;
    return handle(reply, async () => {
      if (kind === 'local') {
        const base = expandHome(path, deps.context.homeDir);
        if (!isAbsolute(base)) throw new BackupError('open a folder first');
        const created = join(base, name);
        await mkdir(created, { recursive: true });
        return { path: created };
      }
      if (kind === 'sftp') {
        const connection = hostId ? deps.destinationDeps.connection(hostId) : undefined;
        if (!connection) throw new BackupError('the server is not connected');
        const sftp = await connection.sftp();
        const created = posix.join(path || '.', name);
        try {
          await new Promise<void>((ok, fail) => sftp.mkdir(created, (e) => (e ? fail(e) : ok())));
        } finally {
          sftp.end();
        }
        return { path: created };
      }
      const config = resourceId ? await deps.destinationDeps.s3Config(resourceId) : undefined;
      if (!config) throw new BackupError('choose a storage account');
      const [bucket = '', ...rest] = path.split('/');
      if (!bucket) throw new BackupError('open a bucket first');
      const prefix = [...rest.filter(Boolean), name].join('/') + '/';
      const client = new S3Client(clientConfig(config, deps.context));
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: prefix, Body: '' }));
      } finally {
        client.destroy();
      }
      return { path: `${bucket}/${prefix}` };
    });
  });

  app.post('/api/backup/destinations/test', async (request, reply) => {
    if (deps.demoMode) return unavailable(reply);
    const body = DestinationInputSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(422).send({
        error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    return testDestination(body.data, deps.destinationDeps);
  });

  app.post('/api/backup/destinations', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const body = DestinationInputSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(422).send({
        error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    return handle(reply, () => ({ id: r.engine.saveDestination(null, body.data) }));
  });

  app.put<{ Params: { id: string } }>('/api/backup/destinations/:id', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const body = DestinationInputSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(422).send({
        error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    return handle(reply, () => ({ id: r.engine.saveDestination(request.params.id, body.data) }));
  });

  app.delete<{ Params: { id: string } }>('/api/backup/destinations/:id', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    return handle(reply, () => {
      r.engine.removeDestination(request.params.id);
      return { ok: true };
    });
  });

  app.post('/api/backup/jobs', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const body = JobInputSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(422).send({
        error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    return handle(reply, async () =>
      jobView(r.engine, r.store, (await r.engine.saveJob(null, body.data)).id),
    );
  });

  app.put<{ Params: { id: string } }>('/api/backup/jobs/:id', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const body = JobInputSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(422).send({
        error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    return handle(reply, async () =>
      jobView(r.engine, r.store, (await r.engine.saveJob(request.params.id, body.data)).id),
    );
  });

  app.delete<{ Params: { id: string } }>('/api/backup/jobs/:id', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    return handle(reply, () => {
      r.engine.deleteJob(request.params.id);
      return { ok: true };
    });
  });

  app.post<{ Params: { id: string } }>('/api/backup/jobs/:id/run', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const body = z
      .object({ type: z.enum(['full', 'incremental', 'differential']).optional() })
      .safeParse(request.body ?? {});
    return handle(reply, async () => ({
      runId: await r.engine.runJob(
        request.params.id,
        'manual',
        body.success ? body.data.type : undefined,
      ),
    }));
  });

  /** Checks a source before saving: configuration, the server connection and the tool. */
  app.post('/api/backup/sources/test', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const body = z.object({ source: SourceSchema }).safeParse(request.body);
    if (!body.success)
      return reply.code(422).send({
        error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    const source = body.data.source;
    return handle(reply, async () => {
      const resource = source.resourceId
        ? (await deps.resources()).get(source.resourceId)
        : undefined;
      const problems = SOURCE_ADAPTERS[source.kind].validate(source, resource);
      if (problems.length > 0) return { ok: false, message: problems.join('; ') };
      let runner: Runner;
      try {
        runner = r.engine.runnerFor(source.tool.runner);
      } catch (error) {
        return { ok: false, message: errorMessage(error) };
      }
      const probe = toolProbe(source);
      if (!probe)
        return {
          ok: true,
          message: 'Ready: GRIDCITY reads it with its own driver and your saved login',
        };
      try {
        const result = await runToEnd(runner, probe, { timeoutMs: 120_000 });
        const first = (result.stdout || result.stderr).trim().split('\n')[0] ?? '';
        if (result.code !== 0 && probe[1] === 'image' && /No such image/i.test(result.stderr)) {
          return {
            ok: true,
            message: `Docker is ready on ${runner.label}; the image ${probe.at(-1)} is downloaded on the first backup`,
          };
        }
        return result.code === 0
          ? { ok: true, message: `Ready on ${runner.label}: ${first}` }
          : {
              ok: false,
              message: `${probe[0] === 'docker' ? 'Docker' : probe[0]} on ${runner.label}: ${first || `exit ${result.code}`}`,
            };
      } catch (error) {
        return { ok: false, message: errorMessage(error) };
      }
    });
  });

  app.delete<{ Params: { id: string } }>('/api/backup/runs/:id', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    return handle(reply, () => r.engine.deleteRun(request.params.id));
  });

  app.post<{ Params: { id: string } }>('/api/backup/runs/:id/verify', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const body = z
      .object({ destinationId: z.string().optional(), passphrase: z.string().max(1024).optional() })
      .safeParse(request.body ?? {});
    return handle(reply, async () => ({
      operationId: await r.engine.verify(
        request.params.id,
        body.success ? body.data.destinationId : undefined,
        body.success ? body.data.passphrase : undefined,
      ),
    }));
  });

  app.post('/api/backup/restore/plan', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const body = RestoreInputSchema.pick({ runId: true, target: true }).safeParse(request.body);
    if (!body.success)
      return reply.code(422).send({
        error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    return handle(reply, () => r.engine.restorePlan(body.data));
  });

  app.post('/api/backup/restore', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const body = RestoreInputSchema.safeParse(request.body);
    if (!body.success)
      return reply.code(422).send({
        error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
    return handle(reply, async () => ({ restoreId: await r.engine.restore(body.data) }));
  });

  app.post<{ Params: { id: string } }>(
    '/api/backup/operations/:id/cancel',
    async (request, reply) => {
      const r = ready();
      if (!r) return unavailable(reply);
      return { ok: r.engine.cancel(request.params.id) };
    },
  );

  app.post('/api/backup/notifications/read', async (request, reply) => {
    const r = ready();
    if (!r) return unavailable(reply);
    const body = z
      .object({ id: z.union([z.number().int(), z.literal('all')]) })
      .safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'id expected' });
    r.store.markRead(body.data.id);
    return { ok: true, unread: r.store.unread() };
  });
}

/** A harmless command proving the tool is there ("pg_dump --version"). */
function toolProbe(source: z.infer<typeof SourceSchema>): string[] | null {
  const { mode, image, container } = source.tool;
  const tools: Partial<Record<string, string>> = {
    postgres: 'pg_dump',
    mysql: 'mysqldump',
    mongodb: 'mongodump',
    firebird: 'gbak',
    sqlite: 'sqlite3',
  };
  if (mode === 'driver') return null;
  if (['docker-volume', 'docker-container'].includes(source.kind))
    return ['docker', 'version', '--format', 'Docker {{.Server.Version}}'];
  if (source.kind === 'files') return ['tar', '--version'];
  if (source.kind === 'custom') return null;
  const tool = tools[source.kind];
  if (mode === 'docker-exec') {
    if (source.kind === 'mssql')
      return ['docker', 'exec', container ?? '', 'sh', '-c', 'echo container reachable'];
    return [
      'docker',
      'exec',
      container ?? '',
      'sh',
      '-c',
      `command -v ${tool} >/dev/null && ${tool} --version 2>&1 | head -1 || ls /opt/firebird/bin/gbak`,
    ];
  }
  if (mode === 'docker-image') {
    const name = image || defaultImageOf(source.kind);
    return ['docker', 'image', 'inspect', '--format', `image ${name} is present`, name];
  }
  if (source.kind === 'mssql') return ['sh', '-c', 'echo ready'];
  return tool ? [tool, tool === 'gbak' ? '-z' : '--version'] : null;
}

function defaultImageOf(kind: string): string {
  return (
    (
      {
        postgres: 'postgres:17-alpine',
        mysql: 'mysql:8.4',
        mongodb: 'mongo:8.0',
        firebird: 'firebirdsql/firebird:5',
      } as Record<string, string>
    )[kind] ?? 'alpine:3.20'
  );
}
