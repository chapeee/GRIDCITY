import { Redis } from 'ioredis';
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

/** Parses `INFO` output into key/value pairs. Pure; tested. */
export function parseRedisInfo(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf(':');
    if (index > 0) values.set(line.slice(0, index), line.slice(index + 1).trim());
  }
  return values;
}

/**
 * Redis (and Valkey) via `ioredis`. Commands used: INFO, SLOWLOG GET 1.
 * A minimal ACL is enough: `+info +slowlog|get +ping`.
 */
export function createRedisConnector(
  config: ResourceConfigOf<'redis'>,
  context: ConnectorContext,
): Connector {
  const resource = singleResource(config, 'Redis', `${config.host}:${config.port}`);
  const counters = new CounterTracker();
  let client: Redis | null = null;
  let password: string | undefined;

  const connect = async (): Promise<Redis> => {
    if (client) return client;
    password = await readPassword(config, context);
    const next = new Redis({
      host: config.host,
      port: config.port,
      username: config.user,
      password,
      tls: config.tls ? {} : undefined,
      lazyConnect: true,
      connectTimeout: 5000,
      commandTimeout: 5000,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
      retryStrategy: () => null, // the fleet reconnects on its own schedule
      // No CLIENT SETNAME: the minimal ACL (+info +slowlog|get +ping) does not allow it.
    });
    next.on('error', () => undefined);
    await next.connect();
    client = next;
    counters.reset();
    return next;
  };

  const poll = async (): Promise<PollOutcome[]> => {
    try {
      const redis = await connect();
      const at = context.now();
      const info = parseRedisInfo(await redis.info());
      const lastSlowId = await optional(async () => {
        const entries = (await redis.call('SLOWLOG', 'GET', '1')) as unknown[][];
        return entries.length > 0 ? num(entries[0]?.[0]) : 0;
      });

      const ops = counters.rate('commands', num(info.get('total_commands_processed')), at);
      const hits = counters.delta('hits', num(info.get('keyspace_hits')), at);
      const misses = counters.delta('misses', num(info.get('keyspace_misses')), at);
      const newSlow = counters.delta('slowlog', lastSlowId, at);
      counters.commit();
      const cacheHit = hitPercent(hits, misses);

      const clients = num(info.get('connected_clients')) ?? 0;
      const maxClients = num(info.get('maxclients'));
      const usedMemory = num(info.get('used_memory'));
      const maxMemory = num(info.get('maxmemory'));
      const role = info.get('role') ?? null;
      const warnings: string[] = [];
      let lag: number | null = null;
      if (role === 'slave') {
        if (info.get('master_link_status') !== 'up') warnings.push('replica link down');
        else lag = num(info.get('master_last_io_seconds_ago'));
      }

      return [
        {
          resourceId: resource.id,
          ok: true,
          sample: healthSample(
            {
              opsPerSec: ops,
              connections: { used: clients, max: maxClients && maxClients > 0 ? maxClients : null },
              storage:
                usedMemory === null
                  ? null
                  : {
                      usedBytes: usedMemory,
                      totalBytes: maxMemory && maxMemory > 0 ? maxMemory : null,
                    },
            },
            {
              replicationLagSeconds: lag,
              slowQueries: newSlow,
              cacheHitPercent: cacheHit,
              warnings,
            },
          ),
          metrics: [
            textMetric('role', 'Role', role === 'slave' ? 'replica' : role),
            textMetric(
              'version',
              'Version',
              info.get('redis_version') ?? info.get('valkey_version') ?? null,
            ),
            metric('ops', 'Commands', 'perSec', ops),
            metric('connections', 'Clients', 'count', clients),
            metric('maxConnections', 'maxclients', 'count', maxClients),
            metric('memory', 'Memory used', 'bytes', usedMemory),
            metric(
              'maxMemory',
              'maxmemory',
              'bytes',
              maxMemory && maxMemory > 0 ? maxMemory : null,
            ),
            metric('cacheHit', 'Hit ratio', 'percent', cacheHit),
            metric('slow', 'New slow log entries', 'count', newSlow),
            metric('lag', 'Since last master I/O', 'seconds', lag),
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
    current?.disconnect();
  };

  return { config, resources: () => [resource], poll, close };
}
