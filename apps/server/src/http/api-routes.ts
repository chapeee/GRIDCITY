import type { FastifyInstance } from 'fastify';
import type { ImportReport } from '../config/ssh-config-importer';
import type { AuditLog } from '../storage/audit-log';

export interface ApiDependencies {
  importSshConfig(): Promise<ImportReport>;
  audit: AuditLog;
}

/** JSON API. Every route is behind the session token; POSTs also need our Origin. */
export function registerApiRoutes(app: FastifyInstance, deps: ApiDependencies): void {
  app.post('/api/hosts/import-ssh-config', async (_request, reply) => {
    try {
      const report = await deps.importSshConfig();
      if (report.added.length > 0) {
        deps.audit.append('hosts_imported', null, `${report.added.length} from ssh config`);
      }
      return report;
    } catch (error) {
      return reply.code(422).send({ error: (error as Error).message });
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/audit', async (request) => ({
    entries: deps.audit.recent(Number(request.query.limit ?? 200) || 200),
  }));
}
