import mysql from 'mysql2/promise';
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

const STATUS_VARIABLES = [
  'Questions',
  'Threads_connected',
  'Slow_queries',
  'Innodb_buffer_pool_read_requests',
  'Innodb_buffer_pool_reads',
  'Uptime',
];

/**
 * MySQL and MariaDB via `mysql2`. Only `SHOW` statements and
 * information_schema reads. Grants for full data:
 * `PROCESS` (other sessions' running queries) and `REPLICATION CLIENT` (lag).
 */
export function createMysqlConnector(
  config: ResourceConfigOf<'mysql'>,
  context: ConnectorContext,
): Connector {
  let engine = 'MySQL';
  const target = `${config.host}:${config.port}`;
  const counters = new CounterTracker();
  let connection: mysql.Connection | null = null;
  let password: string | undefined;

  const resource = () => singleResource(config, engine, target);

  const connect = async (): Promise<mysql.Connection> => {
    if (connection) return connection;
    password = await readPassword(config, context);
    const next = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password,
      database: config.database,
      ssl: config.tls ? { rejectUnauthorized: true } : undefined,
      connectTimeout: 5000,
      supportBigNumbers: true,
    });
    next.on('error', () => {
      if (connection === next) connection = null;
    });
    connection = next;
    counters.reset();
    return next;
  };

  const query = async (db: mysql.Connection, sql: string, values: unknown[] = []) => {
    const [rows] = await db.query({ sql, values, timeout: 5000 });
    return rows as Record<string, unknown>[];
  };

  const poll = async (): Promise<PollOutcome[]> => {
    try {
      const db = await connect();
      const at = context.now();
      const status = new Map<string, unknown>(
        (
          await query(
            db,
            `SHOW GLOBAL STATUS WHERE Variable_name IN (${STATUS_VARIABLES.map(() => '?').join(',')})`,
            STATUS_VARIABLES,
          )
        ).map((row) => [String(row.Variable_name), row.Value]),
      );
      const [variables] = await query(
        db,
        'SELECT @@max_connections AS maxConnections, @@version AS version, @@read_only AS readOnly',
      );
      const version = String(variables?.version ?? '');
      engine = /mariadb/i.test(version) ? 'MariaDB' : 'MySQL';

      const slowRunning = await optional(async () => {
        const [row] = await query(
          db,
          `SELECT COUNT(*) AS slow FROM information_schema.processlist
             WHERE command = 'Query' AND id <> CONNECTION_ID() AND time * 1000 >= ?`,
          [config.slowQueryMs],
        );
        return num(row?.slow);
      });
      // null: not allowed to see it; { row: null }: not a replica.
      const replicaStatus = await optional(async () => {
        try {
          return { row: (await query(db, 'SHOW REPLICA STATUS'))[0] ?? null };
        } catch {
          return { row: (await query(db, 'SHOW SLAVE STATUS'))[0] ?? null };
        }
      });
      const replica = replicaStatus?.row ?? null;
      const size = await optional(async () => {
        const [row] = await query(
          db,
          'SELECT SUM(data_length + index_length) AS size FROM information_schema.tables',
        );
        return num(row?.size);
      });

      const isReplica = replica !== null;
      const lag = isReplica
        ? num(replica.Seconds_Behind_Source ?? replica.Seconds_Behind_Master)
        : null;
      const warnings: string[] = [];
      if (isReplica) {
        const io = String(replica.Replica_IO_Running ?? replica.Slave_IO_Running ?? '');
        const sql = String(replica.Replica_SQL_Running ?? replica.Slave_SQL_Running ?? '');
        if (io !== 'Yes' || sql !== 'Yes') warnings.push('replication stopped');
      }

      const ops = counters.rate('questions', num(status.get('Questions')), at);
      const newSlow = counters.delta('slowQueries', num(status.get('Slow_queries')), at);
      const requests = counters.delta(
        'bpRequests',
        num(status.get('Innodb_buffer_pool_read_requests')),
        at,
      );
      const diskReads = counters.delta('bpReads', num(status.get('Innodb_buffer_pool_reads')), at);
      counters.commit();
      const cacheHit =
        requests === null || diskReads === null
          ? null
          : hitPercent(requests - diskReads, diskReads);
      const connections = num(status.get('Threads_connected')) ?? 0;
      const maxConnections = num(variables?.maxConnections);

      return [
        {
          resourceId: config.id,
          ok: true,
          sample: healthSample(
            {
              opsPerSec: ops,
              connections: { used: connections, max: maxConnections },
              storage: size === null ? null : { usedBytes: size, totalBytes: null },
            },
            {
              replicationLagSeconds: lag,
              slowQueries: slowRunning,
              cacheHitPercent: cacheHit,
              warnings,
            },
          ),
          metrics: [
            textMetric(
              'role',
              'Role',
              replicaStatus === null ? null : isReplica ? 'replica' : 'primary',
            ),
            textMetric('version', 'Version', version),
            metric('ops', 'Queries', 'perSec', ops),
            metric('connections', 'Connections', 'count', connections),
            metric('maxConnections', 'Max connections', 'count', maxConnections),
            metric('slow', `Running > ${config.slowQueryMs} ms`, 'count', slowRunning),
            metric('slowLog', 'Slow log entries (poll)', 'count', newSlow),
            metric('cacheHit', 'Buffer pool hit', 'percent', cacheHit),
            metric('lag', 'Replica lag', 'seconds', lag),
            metric('size', 'Data + index size', 'bytes', size),
          ],
        },
      ];
    } catch (error) {
      await close();
      return [
        { resourceId: config.id, ok: false, error: redactSecrets(errorMessage(error), [password]) },
      ];
    }
  };

  const close = async () => {
    const current = connection;
    connection = null;
    await current?.end().catch(() => current.destroy());
  };

  return { config, resources: () => [resource()], poll, close };
}
