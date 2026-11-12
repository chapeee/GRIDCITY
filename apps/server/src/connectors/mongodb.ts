import { MongoClient, type Document } from 'mongodb';
import type { ResourceConfigOf } from '../config/resources-file';
import {
  CounterTracker,
  errorMessage,
  healthSample,
  hitPercent,
  metric,
  num,
  optional,
  readPassword,
  redactSecrets,
  singleResource,
  textMetric,
  type Connector,
  type ConnectorContext,
  type PollOutcome,
} from './connector';

/**
 * MongoDB via the official `mongodb` driver. Only admin read commands:
 * serverStatus, listDatabases, currentOp, replSetGetStatus. Role:
 * `clusterMonitor` (read-only) gives all of them.
 */
export function createMongoConnector(
  config: ResourceConfigOf<'mongodb'>,
  context: ConnectorContext,
): Connector {
  const target = displayTarget(config.url);
  const resource = singleResource(config, 'MongoDB', target);
  const counters = new CounterTracker();
  let client: MongoClient | null = null;
  let password: string | undefined;

  const connect = async (): Promise<MongoClient> => {
    if (client) return client;
    password = await readPassword(config, context);
    const next = new MongoClient(config.url, {
      ...(config.user || password
        ? {
            auth: {
              username:
                config.user ?? new URL(config.url.replace(/^mongodb\+srv/, 'mongodb')).username,
              password,
            },
          }
        : {}),
      ...(config.authSource ? { authSource: config.authSource } : {}),
      ...(config.tls !== undefined ? { tls: config.tls } : {}),
      ...(config.tlsVerify === false ? { tlsAllowInvalidCertificates: true } : {}),
      ...(config.tlsCa ? { ca: config.tlsCa } : {}),
      appName: context.appName,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 8000,
      maxPoolSize: 1,
      readPreference: 'nearest',
      directConnection: !config.url.startsWith('mongodb+srv') && !/replicaSet=/.test(config.url),
    });
    await next.connect();
    client = next;
    counters.reset();
    return next;
  };

  const poll = async (): Promise<PollOutcome[]> => {
    try {
      const admin = (await connect()).db('admin');
      const at = context.now();
      const status: Document = await admin.command({
        serverStatus: 1,
        repl: 1,
        metrics: 0,
        locks: 0,
      });
      const totalSize = await optional(async () =>
        num((await admin.command({ listDatabases: 1, nameOnly: false })).totalSize),
      );
      const slow = await optional(async () => {
        const ops = await admin.command({
          currentOp: 1,
          active: true,
          microsecs_running: { $gte: config.slowQueryMs * 1000 },
          op: { $in: ['query', 'update', 'insert', 'remove', 'getmore', 'command'] },
          // Ops that wait on purpose are not slow: drivers' awaitable heartbeats (this
          // app's own included, ~10 s each) and tailable cursors (change streams, oplog).
          $nor: [
            { 'command.hello': { $exists: true } },
            { 'command.isMaster': { $exists: true } },
            { 'command.ismaster': { $exists: true } },
            { 'cursor.tailable': true },
            { 'cursor.awaitData': true },
          ],
        });
        return Array.isArray(ops.inprog) ? ops.inprog.length : null;
      });
      const repl = status.repl as Document | undefined;
      const isSecondary = repl?.secondary === true;
      const lag = isSecondary ? await optional(() => replicaLag(admin)) : null;

      const opcounters = status.opcounters as Record<string, unknown> | undefined;
      const totalOps = opcounters
        ? Object.values(opcounters).reduce<number>((sum, value) => sum + (num(value) ?? 0), 0)
        : null;
      const ops = counters.rate('ops', totalOps, at);
      const cache = (status.wiredTiger as Document | undefined)?.cache as
        Record<string, unknown> | undefined;
      const requested = counters.delta(
        'cacheRequested',
        num(cache?.['pages requested from the cache']),
        at,
      );
      const readIn = counters.delta('cacheReadIn', num(cache?.['pages read into cache']), at);
      counters.commit();
      const cacheHit =
        requested === null || readIn === null ? null : hitPercent(requested - readIn, readIn);

      const connections = status.connections as Record<string, unknown> | undefined;
      const current = num(connections?.current) ?? 0;
      const available = num(connections?.available);

      return [
        {
          resourceId: resource.id,
          ok: true,
          sample: healthSample(
            {
              opsPerSec: ops,
              connections: { used: current, max: available === null ? null : current + available },
              storage: totalSize === null ? null : { usedBytes: totalSize, totalBytes: null },
            },
            { replicationLagSeconds: lag, slowQueries: slow, cacheHitPercent: cacheHit },
          ),
          metrics: [
            textMetric(
              'role',
              'Role',
              repl
                ? repl.ismaster || repl.isWritablePrimary
                  ? 'primary'
                  : isSecondary
                    ? 'secondary'
                    : 'other'
                : 'standalone',
            ),
            textMetric('version', 'Version', String(status.version ?? '')),
            metric('ops', 'Operations', 'perSec', ops),
            metric('connections', 'Connections', 'count', current),
            metric(
              'maxConnections',
              'Max connections',
              'count',
              available === null ? null : current + available,
            ),
            metric('slow', `Running > ${config.slowQueryMs} ms`, 'count', slow),
            metric('cacheHit', 'WiredTiger cache hit', 'percent', cacheHit),
            metric(
              'cacheBytes',
              'Cache in use',
              'bytes',
              num(cache?.['bytes currently in the cache']),
            ),
            metric('lag', 'Replica lag', 'seconds', lag),
            metric('size', 'Total size', 'bytes', totalSize),
          ],
        },
      ];
    } catch (error) {
      await close();
      return [
        {
          resourceId: resource.id,
          ok: false,
          error: redactSecrets(errorMessage(error), [password]),
        },
      ];
    }
  };

  const close = async () => {
    const current = client;
    client = null;
    await current?.close().catch(() => undefined);
  };

  return { config, resources: () => [resource], poll, close };
}

async function replicaLag(admin: ReturnType<MongoClient['db']>): Promise<number | null> {
  const status = await admin.command({ replSetGetStatus: 1 });
  const members = (status.members ?? []) as Document[];
  const primary = members.find((member) => member.stateStr === 'PRIMARY');
  const self = members.find((member) => member.self === true);
  if (!primary?.optimeDate || !self?.optimeDate) return null;
  return Math.max(
    0,
    (new Date(primary.optimeDate).getTime() - new Date(self.optimeDate).getTime()) / 1000,
  );
}

/** The URL without credentials or options, for display. */
function displayTarget(url: string): string {
  try {
    const parsed = new URL(url.replace(/^mongodb\+srv:/, 'https:').replace(/^mongodb:/, 'https:'));
    return parsed.host || url;
  } catch {
    return url.replace(/\/\/[^@/]*@/, '//');
  }
}
