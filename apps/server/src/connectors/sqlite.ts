import Database from 'better-sqlite3';
import { stat } from 'node:fs/promises';
import { expandHome } from '../config/app-paths';
import type { ResourceConfigOf } from '../config/resources-file';
import {
  errorMessage,
  healthSample,
  metric,
  num,
  singleResource,
  textMetric,
  type Connector,
  type ConnectorContext,
  type PollOutcome,
} from './connector';

/**
 * SQLite files via `better-sqlite3`, opened read-only (never created) for a
 * moment each poll so the app never holds a lock on your database. "Up"
 * means the file opens and reads as SQLite.
 */
export function createSqliteConnector(
  config: ResourceConfigOf<'sqlite'>,
  context: ConnectorContext,
): Connector {
  const path = expandHome(config.path, context.homeDir);
  const resource = singleResource(config, 'SQLite', config.path);

  const poll = async (): Promise<PollOutcome[]> => {
    let db: Database.Database | null = null;
    try {
      const file = await stat(path);
      const wal = await stat(`${path}-wal`).catch(() => null);
      db = new Database(path, { readonly: true, fileMustExist: true, timeout: 2000 });
      const pragma = (name: string) => num(db!.pragma(name, { simple: true }));
      const pageCount = pragma('page_count');
      const pageSize = pragma('page_size');
      const freePages = pragma('freelist_count');
      const journal = String(db.pragma('journal_mode', { simple: true }));
      const tables = num(
        (
          db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get() as {
            n: number;
          }
        ).n,
      );
      const fileBytes = file.size + (wal?.size ?? 0);

      return [
        {
          resourceId: resource.id,
          ok: true,
          sample: healthSample({ storage: { usedBytes: fileBytes, totalBytes: null } }),
          metrics: [
            textMetric('journal', 'Journal mode', journal),
            metric('size', 'File size', 'bytes', file.size),
            metric('wal', 'WAL size', 'bytes', wal ? wal.size : null),
            metric('pages', 'Pages', 'count', pageCount),
            metric(
              'free',
              'Free space',
              'bytes',
              freePages !== null && pageSize !== null ? freePages * pageSize : null,
            ),
            metric('tables', 'Tables', 'count', tables),
          ],
        },
      ];
    } catch (error) {
      return [{ resourceId: resource.id, ok: false, error: errorMessage(error) }];
    } finally {
      db?.close();
    }
  };

  return { config, resources: () => [resource], poll, close: async () => undefined };
}
