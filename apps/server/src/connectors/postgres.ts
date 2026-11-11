import pg from 'pg';
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
  tlsOptions,
  type Connector,
  type ConnectorContext,
  type PollOutcome,
} from './connector';

/**
 * PostgreSQL via `pg`. The session is read-only
 * (`default_transaction_read_only=on`) with a statement timeout. Best with a
 * user granted `pg_monitor`; without it, other sessions' queries are hidden
 * and the slow-query count only covers the monitoring user's own sessions.
 */
export function createPostgresConnector(
  config: ResourceConfigOf<'postgres'>,
  context: ConnectorContext,
): Connector {
  const resource = singleResource(config, 'PostgreSQL', `${config.host}:${config.port}`);
  const counters = new CounterTracker();
  let client: pg.Client | null = null;
  let password: string | undefined;

  const connect = async (): Promise<pg.Client> => {
    if (client) return client;
    password = await readPassword(config, context);
    const next = new pg.Client({
      host: config.host,
      port: config.port,
      user: config.user,
      database: config.database,
      password,
      ssl: tlsOptions(config) ?? false,
      application_name: context.appName,
      connectionTimeoutMillis: 5000,
      query_timeout: 8000,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000',
    });
    next.on('error', () => {
      // A dropped connection is reported by the next poll; just forget it.
      if (client === next) client = null;
    });
    try {
      await next.connect();
    } catch (error) {
      await next.end().catch(() => undefined);
      throw error;
    }
    client = next;
    counters.reset();
    return next;
  };

  const poll = async (): Promise<PollOutcome[]> => {
    try {
      const db = await connect();
      const at = context.now();
      const { rows } = await db.query(
        `SELECT
           (SELECT sum(xact_commit + xact_rollback) FROM pg_stat_database) AS xacts,
           (SELECT sum(blks_hit) FROM pg_stat_database) AS hits,
           (SELECT sum(blks_read) FROM pg_stat_database) AS reads,
           (SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend') AS connections,
           current_setting('max_connections')::int AS max_connections,
           (SELECT count(*) FROM pg_stat_activity
              WHERE backend_type = 'client backend' AND state = 'active' AND pid <> pg_backend_pid()
                AND now() - query_start > make_interval(secs => $1::float8 / 1000)) AS slow,
           pg_database_size(current_database()) AS size,
           pg_is_in_recovery() AS replica,
           current_setting('server_version') AS version`,
        [config.slowQueryMs],
      );
      const row = rows[0] as Record<string, unknown>;
      const replica = row.replica === true;
      const lag = replica
        ? await optional(async () => {
            const result = await db.query(
              `SELECT CASE WHEN pg_last_wal_receive_lsn() = pg_last_wal_replay_lsn() THEN 0
                      ELSE extract(epoch FROM now() - pg_last_xact_replay_timestamp()) END AS lag`,
            );
            return num((result.rows[0] as Record<string, unknown>).lag);
          })
        : null;

      const ops = counters.rate('xacts', num(row.xacts), at);
      const cacheHit = hitPercent(
        counters.delta('hits', num(row.hits), at),
        counters.delta('reads', num(row.reads), at),
      );
      counters.commit();
      const connections = num(row.connections) ?? 0;
      const maxConnections = num(row.max_connections);
      const slow = num(row.slow);
      const size = num(row.size);

      return [
        {
          resourceId: resource.id,
          ok: true,
          sample: healthSample(
            {
              opsPerSec: ops,
              connections: { used: connections, max: maxConnections },
              storage: size === null ? null : { usedBytes: size, totalBytes: null },
            },
            { replicationLagSeconds: lag, slowQueries: slow, cacheHitPercent: cacheHit },
          ),
          metrics: [
            textMetric('role', 'Role', replica ? 'replica' : 'primary'),
            textMetric('version', 'Version', String(row.version ?? '')),
            metric('ops', 'Transactions', 'perSec', ops),
            metric('connections', 'Connections', 'count', connections),
            metric('maxConnections', 'Max connections', 'count', maxConnections),
            metric('slow', `Slow queries (> ${config.slowQueryMs} ms)`, 'count', slow),
            metric('cacheHit', 'Cache hit', 'percent', cacheHit),
            metric('lag', 'Replica lag', 'seconds', lag),
            metric('size', 'Database size', 'bytes', size),
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
    await current?.end().catch(() => undefined);
  };

  return { config, resources: () => [resource], poll, close };
}
