import type { ThreatsView } from '@app/shared';
import type { FastifyInstance } from 'fastify';
import { BackupExpectationSchema, validateBackup, type backupStore } from '../insights/backups';
import type { IncidentEvent } from '../insights/incident';
import { LogSearchSchema, type LogSearch } from '../insights/log-search';
import type { FixOption, FixOutcome } from '../threats/fixes';
import type { ThreatHub } from '../threats/threat-hub';

export interface ThreatRouteDeps {
  /** Absent with demo data: there is nothing real to check. */
  hub: ThreatHub | null;
  backups?: ReturnType<typeof backupStore>;
  /** Latest containers and pods on a server (null before the first look). */
  containers?: (hostId: string) => unknown;
  /** Log search across servers. */
  searchLogs?: (search: LogSearch) => Promise<unknown>;
  /** Everything recorded around a moment (the incident timeline). */
  incident?: (since: number, until: number, targetId: string | null) => IncidentEvent[];
  /** One-click fixes for a finding (real mode). */
  fixes?: {
    optionsFor(findingId: string): FixOption[];
    apply(findingId: string, fixId: string): Promise<FixOutcome | null>;
  };
  audit?: {
    append(kind: 'settings_changed' | 'logs_searched', target: string | null, detail: string): void;
  };
}

const EMPTY: ThreatsView = { findings: [], coverage: [], upcoming: [], demo: true };

/** Attack and exposure findings. Writes need the usual token + Origin guards. */
export function registerThreatRoutes(app: FastifyInstance, deps: ThreatRouteDeps): void {
  app.get('/api/threats', async () => deps.hub?.view() ?? EMPTY);

  /** Findings active in a time range, for the time travel timeline. */
  app.get('/api/threats/timeline', async (request, reply) => {
    const query = request.query as { since?: string; until?: string };
    const since = Number(query.since);
    const until = Number(query.until ?? Date.now());
    if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) {
      return reply.code(400).send({ error: 'since and until (epoch ms) expected' });
    }
    return { findings: deps.hub?.between(since, until) ?? [] };
  });

  /** Searches the logs of every chosen server at once (read-only). */
  app.post('/api/logs/search', async (request, reply) => {
    if (!deps.searchLogs)
      return reply.code(409).send({ error: 'Demo data: there are no real logs to search.' });
    const parsed = LogSearchSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(422)
        .send({
          problems: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
        });
    }
    deps.audit?.append(
      'logs_searched',
      null,
      `"${parsed.data.query}" over ${parsed.data.since} on ${parsed.data.hostIds.length || 'all'} server(s)`,
    );
    return { results: await deps.searchLogs(parsed.data) };
  });

  /** What happened around a moment: ?at=<ms>&minutes=30&target=<id> */
  app.get('/api/incident', async (request, reply) => {
    const query = request.query as { at?: string; minutes?: string; target?: string };
    const at = Number(query.at ?? Date.now());
    const minutes = Math.min(Math.max(Number(query.minutes ?? 30) || 30, 5), 24 * 60);
    if (!Number.isFinite(at)) return reply.code(400).send({ error: 'at (epoch ms) expected' });
    const since = at - minutes * 60_000;
    const until = at + minutes * 60_000;
    return { since, until, events: deps.incident?.(since, until, query.target || null) ?? [] };
  });

  app.get<{ Params: { id: string } }>('/api/threats/:id/fixes', async (request) => ({
    fixes: deps.fixes?.optionsFor(request.params.id) ?? [],
  }));

  /** Applies a fix the user confirmed after seeing exactly what it runs. */
  app.post<{ Params: { id: string }; Body: { fixId?: unknown } }>(
    '/api/threats/:id/fix',
    async (request, reply) => {
      if (!deps.hub || !deps.fixes)
        return reply.code(409).send({ error: 'Demo data: nothing to fix.' });
      const fixId = typeof request.body?.fixId === 'string' ? request.body.fixId : '';
      const outcome = await deps.fixes.apply(request.params.id, fixId);
      if (!outcome)
        return reply.code(404).send({ error: 'That fix is not available for this finding.' });
      return { outcome, view: deps.hub.view() };
    },
  );

  app.post<{ Params: { id: string } }>('/api/threats/:id/acknowledge', async (request, reply) => {
    if (!deps.hub) return reply.code(409).send({ error: 'Demo data: nothing to mark.' });
    const finding = deps.hub.acknowledge(request.params.id);
    if (!finding) return reply.code(404).send({ error: 'No such finding.' });
    return deps.hub.view();
  });

  app.get<{ Params: { id: string } }>('/api/containers/:id', async (request) => ({
    snapshot: deps.containers?.(request.params.id) ?? null,
  }));

  app.get('/api/backups', async () => ({ backups: deps.backups?.load() ?? [] }));

  app.post('/api/backups', async (request, reply) => {
    if (!deps.hub || !deps.backups)
      return reply.code(409).send({ error: 'Demo data: nothing to check.' });
    const parsed = BackupExpectationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply
        .code(422)
        .send({ problems: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const problems = validateBackup(parsed.data);
    if (problems.length > 0) return reply.code(422).send({ problems });
    const saved = deps.backups.save(parsed.data, Date.now());
    deps.audit?.append('settings_changed', saved.targetId, `backup check saved: ${saved.name}`);
    await deps.hub.runProducer('backups');
    return { backup: saved, view: deps.hub.view() };
  });

  app.delete<{ Params: { id: string } }>('/api/backups/:id', async (request, reply) => {
    if (!deps.hub || !deps.backups)
      return reply.code(409).send({ error: 'Demo data: nothing to check.' });
    if (!deps.backups.remove(request.params.id, Date.now())) {
      return reply.code(404).send({ error: 'No such backup check.' });
    }
    deps.audit?.append('settings_changed', null, `backup check removed: ${request.params.id}`);
    await deps.hub.runProducer('backups');
    return deps.hub.view();
  });

  /** Runs every check now instead of waiting for the next round. */
  app.post('/api/threats/check', async (_request, reply) => {
    if (!deps.hub) return reply.code(409).send({ error: 'Demo data: nothing to check.' });
    await Promise.all([deps.hub.sweepAll(), deps.hub.checkExposure(), deps.hub.runProducer()]);
    return deps.hub.view();
  });
}
