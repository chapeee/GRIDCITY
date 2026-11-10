import type { ResourceConfig } from '../config/resources-file';
import type { Connector, ConnectorContext } from './connector';
import { createMongoConnector } from './mongodb';
import { createMssqlConnector } from './mssql';
import { createMysqlConnector } from './mysql';
import { createPostgresConnector } from './postgres';
import { createRdsConnector } from './rds';
import { createRedisConnector } from './redis';
import { createS3Connector } from './s3';
import { createSqliteConnector } from './sqlite';

export type { Connector, ConnectorContext, PollOutcome } from './connector';

/** The one place that knows every kind. A new kind = a new file + one line here. */
export function createConnector(config: ResourceConfig, context: ConnectorContext): Connector {
  switch (config.kind) {
    case 'postgres':
      return createPostgresConnector(config, context);
    case 'mysql':
      return createMysqlConnector(config, context);
    case 'mongodb':
      return createMongoConnector(config, context);
    case 'redis':
      return createRedisConnector(config, context);
    case 'mssql':
      return createMssqlConnector(config, context);
    case 'sqlite':
      return createSqliteConnector(config, context);
    case 'rds':
      return createRdsConnector(config, context);
    case 's3':
      return createS3Connector(config, context);
  }
}
