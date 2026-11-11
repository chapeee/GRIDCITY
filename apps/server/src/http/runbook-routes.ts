import { runbookMatches, type Host, type Runbook, type RunResult } from '@app/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runOnHosts, type CommandRunnerOptions } from '../fleet/command-runner';
import type { AuditLog } from '../storage/audit-log';

export interface RunbookRouteDependencies {
  audit: AuditLog;
  demoMode: boolean;
  hosts(): readonly Host[];
  runbooks(): readonly Runbook[];
  runner: CommandRunnerOptions;
}

/** Either a saved runbook or a command typed for this run. */
const RunBodySchema = z
  .strictObject({
    runbookId: z.string().min(1).optional(),
    command: z.string().trim().min(1).max(10_000).optional(),
    hostIds: z.array(z.string().min(1)).min(1).max(500),
    timeoutSeconds: z.number().int().min(1).max(600).optional(),
  })
  .refine((body) => Boolean(body.runbookId) !== Boolean(body.command), {
    message: 'send either runbookId or command',
  });

export interface RunResponse {
  command: string;
  runbookId: string | null;
  startedAt: number;
  results: RunResult[];
}

/**
 * Runbooks and fleet-wide commands: the user picks the servers and confirms
 * in the app; the server runs the command on each of them over the existing
 * SSH connection, a few at a time, and records the run in the audit log
 * (command, servers, exit codes; never the output).
 */
export function registerRunbookRoutes(app: FastifyInstance, deps: RunbookRouteDependencies): void {
  app.get('/api/runbooks', async () => ({ runbooks: deps.runbooks() }));

  app.post('/api/runbooks/run', async (request, reply) => {
    if (deps.demoMode) {
      return reply
        .code(409)
        .send({ error: 'Demo data: there are no real servers to run commands on.' });
    }
    const body = RunBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(422).send({ error: body.error.issues.map((i) => i.message).join('\n') });
    }
    const runbook = body.data.runbookId
      ? deps.runbooks().find((entry) => entry.id === body.data.runbookId)
      : undefined;
    if (body.data.runbookId && !runbook) {
      return reply.code(404).send({ error: `No runbook "${body.data.runbookId}".` });
    }
    const wanted = new Set(body.data.hostIds);
    const hosts = deps.hosts().filter((host) => wanted.has(host.id));
    const unknown = body.data.hostIds.filter((id) => !hosts.some((host) => host.id === id));
    if (unknown.length > 0) {
      return reply.code(404).send({ error: `Unknown servers: ${unknown.join(', ')}.` });
    }
    if (runbook) {
      const outside = hosts.filter((host) => !runbookMatches(runbook, host));
      if (outside.length > 0) {
        return reply.code(422).send({
          error: `"${runbook.name}" does not apply to ${outside.map((h) => h.name).join(', ')}.`,
        });
      }
    }

    const command = runbook ? runbook.command : body.data.command!;
    const timeoutSeconds = body.data.timeoutSeconds ?? runbook?.timeoutSeconds ?? 60;
    const startedAt = Date.now();
    const results = await runOnHosts(hosts, command, timeoutSeconds * 1000, deps.runner);
    const summary = results
      .map((result) => `${result.hostId}=${result.error ? 'error' : (result.exitCode ?? '?')}`)
      .join(' ');
    deps.audit.append(
      runbook ? 'runbook_run' : 'fleet_command_run',
      hosts.length === 1 ? hosts[0]!.id : null,
      `${runbook ? `${runbook.id}: ` : ''}${command.slice(0, 300)} → ${summary}`,
    );
    const response: RunResponse = {
      command,
      runbookId: runbook?.id ?? null,
      startedAt,
      results,
    };
    return response;
  });
}
