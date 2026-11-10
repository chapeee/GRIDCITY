import { HostSchema, type Host } from '@app/shared';
import type { FastifyInstance } from 'fastify';
import { DraftError, draftToHostInput, HostDraftSchema } from '../config/host-draft';
import { HostValidationError } from '../config/hosts-writer';
import type { ImportReport } from '../config/ssh-config-importer';
import { connectionAdvice } from '../ssh/connection-advice';
import type { ConnectionTestResult } from '../ssh/test-connection';
import type { AuditLog } from '../storage/audit-log';

export interface ApiDependencies {
  importSshConfig(): Promise<ImportReport>;
  /** Appends a host to hosts.yaml (the fleet reloads live). */
  addHost(host: Host): Promise<Host>;
  /** One-off SSH connection test with the fleet's exact checks. */
  testConnection(host: Host): Promise<ConnectionTestResult>;
  /** Used when a target has no "user@". */
  defaultUser: string;
  /** Platform of this server, for the commands in the advice. */
  platform?: NodeJS.Platform;
  /** True when the server shows demo data (added hosts appear after switching to real). */
  demoMode: boolean;
  audit: AuditLog;
}

/** JSON API. Every route is behind the session token; POSTs also need our Origin. */
export function registerApiRoutes(app: FastifyInstance, deps: ApiDependencies): void {
  /** Draft (as typed in the dialog) -> validated host, or a 422 with readable problems. */
  const resolveDraft = (body: unknown): { host: Host } | { problems: string[] } => {
    const draft = HostDraftSchema.safeParse(body);
    if (!draft.success) return { problems: draft.error.issues.map((issue) => issue.message) };
    try {
      const host = HostSchema.safeParse(draftToHostInput(draft.data, deps.defaultUser));
      if (!host.success) {
        return {
          problems: host.error.issues.map((i) => `${i.path.join('.') || 'host'}: ${i.message}`),
        };
      }
      return { host: host.data };
    } catch (error) {
      if (error instanceof DraftError) return { problems: [error.message] };
      throw error;
    }
  };

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

  app.post('/api/hosts/test', async (request, reply) => {
    const resolved = resolveDraft(request.body);
    if ('problems' in resolved) {
      return reply
        .code(422)
        .send({ error: resolved.problems.join('\n'), problems: resolved.problems });
    }
    const result = await deps.testConnection(resolved.host);
    return {
      host: resolved.host,
      result,
      advice: connectionAdvice(result, resolved.host, deps.platform ?? process.platform),
    };
  });

  app.post('/api/hosts', async (request, reply) => {
    const resolved = resolveDraft(request.body);
    if ('problems' in resolved) {
      return reply
        .code(422)
        .send({ error: resolved.problems.join('\n'), problems: resolved.problems });
    }
    try {
      const host = await deps.addHost(resolved.host);
      deps.audit.append('host_added', host.id, `${host.user}@${host.address}:${host.port}`);
      return reply.code(201).send({ host, demoMode: deps.demoMode });
    } catch (error) {
      if (error instanceof HostValidationError) {
        return reply.code(422).send({ error: error.message, problems: error.problems });
      }
      throw error;
    }
  });

  app.get<{ Querystring: { limit?: string } }>('/api/audit', async (request) => ({
    entries: deps.audit.recent(Number(request.query.limit ?? 200) || 200),
  }));
}
