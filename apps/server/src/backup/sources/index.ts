import type { BackupSourceKind } from '@app/shared';
import { firebirdAdapter, mssqlAdapter, mysqlAdapter, postgresAdapter } from './databases';
import { customAdapter, dockerContainerAdapter, dockerVolumeAdapter, filesAdapter } from './files';
import { mongoAdapter, redisAdapter, sqliteAdapter } from './nosql';
import type { SourceAdapter } from './types';

/**
 * Every kind of backup source. Adding one = one adapter implementing
 * {@link SourceAdapter}, registered here, plus its capabilities in
 * packages/shared/src/backup.ts.
 */
export const SOURCE_ADAPTERS: Record<BackupSourceKind, SourceAdapter> = {
  postgres: postgresAdapter,
  mysql: mysqlAdapter,
  mongodb: mongoAdapter,
  redis: redisAdapter,
  sqlite: sqliteAdapter,
  mssql: mssqlAdapter,
  firebird: firebirdAdapter,
  'docker-volume': dockerVolumeAdapter,
  'docker-container': dockerContainerAdapter,
  files: filesAdapter,
  custom: customAdapter,
};

export type { SourceAdapter } from './types';
