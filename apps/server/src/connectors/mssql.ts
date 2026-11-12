import mssql from 'mssql';
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
 * Microsoft SQL Server via `mssql` (tedious). Connects with
 * `ApplicationIntent=ReadOnly` and reads DMVs only. Needs
 * `GRANT VIEW SERVER STATE` (SQL Server 2022: `VIEW SERVER PERFORMANCE STATE`).
 */
export function createMssqlConnector(
  config: ResourceConfigOf<'mssql'>,
  context: ConnectorContext,
): Connector {
  const resource = singleResource(config, 'SQL Server', `${config.host}:${config.port}`);
  const counters = new CounterTracker();
  let pool: mssql.ConnectionPool | null = null;
  let password: string | undefined;

  const connect = async (): Promise<mssql.ConnectionPool> => {
    if (pool?.connected) return pool;
    await close();
    password = await readPassword(config, context);
    const next = new mssql.ConnectionPool({
      server: config.host,
      port: config.port,
      user: config.user,
      password,
      database: config.database,
      connectionTimeout: 5000,
      requestTimeout: 5000,
      pool: { max: 1, min: 0, idleTimeoutMillis: 60_000 },
      options: {
        encrypt: config.encrypt,
        trustServerCertificate: config.trustServerCertificate,
        readOnlyIntent: true,
        appName: context.appName,
      },
    });
    next.on('error', () => undefined);
    await next.connect();
    pool = next;
    counters.reset();
    return next;
  };

  const poll = async (): Promise<PollOutcome[]> => {
    try {
      const db = await connect();
      const at = context.now();
      const counterRows = (
        await db.request().query(`
          SELECT RTRIM(counter_name) AS name, cntr_value AS value
          FROM sys.dm_os_performance_counters
          WHERE (object_name LIKE '%SQL Statistics%' AND counter_name = 'Batch Requests/sec')
             OR (object_name LIKE '%General Statistics%' AND counter_name = 'User Connections')
             OR (object_name LIKE '%Buffer Manager%' AND counter_name IN ('Buffer cache hit ratio', 'Buffer cache hit ratio base'))`)
      ).recordset as { name: string; value: unknown }[];
      const perf = new Map(counterRows.map((row) => [row.name, num(row.value)]));
      const info = (
        await db.request().query(
          `SELECT @@MAX_CONNECTIONS AS maxConnections, CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS version,
                  CAST(SERVERPROPERTY('Edition') AS nvarchar(128)) AS edition`,
        )
      ).recordset[0] as Record<string, unknown>;
      const slow = await optional(async () => {
        const result = await db
          .request()
          .input('slowMs', mssql.Int, config.slowQueryMs)
          .query(
            // User sessions only: modern SQL Server runs its own background tasks (log
            // writer, broker, XE timers) above session 50, and they "run" forever.
            // WAITFOR sleeps on purpose.
            `SELECT COUNT(*) AS slow FROM sys.dm_exec_requests r
               JOIN sys.dm_exec_sessions s ON s.session_id = r.session_id
             WHERE r.session_id <> @@SPID AND s.is_user_process = 1
               AND r.command <> 'WAITFOR' AND r.total_elapsed_time >= @slowMs`,
          );
        return num((result.recordset[0] as Record<string, unknown>).slow);
      });
      const size = await optional(async () => {
        const result = await db
          .request()
          .query('SELECT SUM(CAST(size AS bigint)) * 8192 AS size FROM sys.master_files');
        return num((result.recordset[0] as Record<string, unknown>).size);
      });
      const lag = await optional(async () => {
        const result = await db
          .request()
          .query(
            `SELECT MAX(secondary_lag_seconds) AS lag FROM sys.dm_hadr_database_replica_states WHERE is_local = 1 AND is_primary_replica = 0`,
          );
        return num((result.recordset[0] as Record<string, unknown> | undefined)?.lag);
      });

      const ops = counters.rate('batches', perf.get('Batch Requests/sec') ?? null, at);
      counters.commit();
      // The ratio counter is cumulative since start; SQL Server exposes it as value / base.
      const ratio = perf.get('Buffer cache hit ratio');
      const base = perf.get('Buffer cache hit ratio base');
      const cacheHit = ratio != null && base ? hitPercent(ratio, base - ratio, 1) : null;
      const connections = perf.get('User Connections') ?? 0;
      const maxConnections = num(info.maxConnections);

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
            textMetric(
              'version',
              'Version',
              `${String(info.edition ?? '')} ${String(info.version ?? '')}`.trim(),
            ),
            metric('ops', 'Batch requests', 'perSec', ops),
            metric('connections', 'User connections', 'count', connections),
            metric('maxConnections', 'Max connections', 'count', maxConnections),
            metric('slow', `Running > ${config.slowQueryMs} ms`, 'count', slow),
            metric('cacheHit', 'Buffer cache hit', 'percent', cacheHit),
            metric('lag', 'AG secondary lag', 'seconds', lag),
            metric('size', 'Files size', 'bytes', size),
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
    const current = pool;
    pool = null;
    await current?.close().catch(() => undefined);
  };

  return { config, resources: () => [resource], poll, close };
}
