import type { Diagnosis, DoctorHint, DoctorReport, Host } from '@app/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { loadResourcesFile, type ResourceConfig } from '../config/resources-file';
import { patchResourceInFile, ResourceValidationError } from '../config/resources-writer';
import { applyPatch, diagnoseResource, PATCHABLE_KEYS } from '../doctor/doctor';
import { environmentDiagnoses, type EnvironmentFacts } from '../doctor/environment';
import { diagnoseHost } from '../doctor/ssh';
import type { ConnectionTestResult } from '../ssh/test-connection';
import type { AuditLog } from '../storage/audit-log';
import { testResource, type ResourceRouteDependencies } from './resource-routes';

export interface DoctorRouteDependencies {
  audit: AuditLog;
  demoMode: boolean;
  resourcesFile: string;
  context: ResourceRouteDependencies['context'];
  hosts(): readonly Host[];
  testHost(host: Host): Promise<ConnectionTestResult>;
  environment(): Promise<EnvironmentFacts>;
  /** Live problems: offline or degraded hosts and resources with their quick hint. */
  troubles(): {
    id: string;
    name: string;
    kind: string;
    status: string;
    hint: DoctorHint | null;
    reason: string | null;
  }[];
  /** resource id (or entry id) -> its resources.yaml entry id. */
  entryIdOf(resourceId: string): string | null;
  reload(): Promise<void>;
}

const ApplySchema = z.strictObject({ patch: z.record(z.string(), z.unknown()) });

/**
 * The Doctor over HTTP. Diagnosing only reads (one lookup, one TCP connect,
 * a few real connection attempts with candidate settings). Applying a fix
 * proves it once more against the real target, then writes only the
 * allow-listed keys to resources.yaml, and is audited.
 */
export function registerDoctorRoutes(app: FastifyInstance, deps: DoctorRouteDependencies): void {
  const test = async (config: ResourceConfig) => {
    const result = await testResource(config, {}, deps.context);
    return { ok: result.ok, error: result.error ?? result.found.find((f) => !f.ok)?.error ?? null };
  };
  const entry = async (id: string): Promise<ResourceConfig | null> => {
    const entryId = deps.entryIdOf(id) ?? id;
    const loaded = await loadResourcesFile(deps.resourcesFile);
    return loaded.ok ? (loaded.config.resources.find((r) => r.id === entryId) ?? null) : null;
  };

  /** Everything at once: the machine, then every target in trouble (no network). */
  app.get('/api/doctor', async () => {
    const environment: Diagnosis[] = environmentDiagnoses(await deps.environment());
    return { environment, troubles: deps.troubles(), demo: deps.demoMode };
  });

  app.post<{ Params: { id: string } }>('/api/doctor/resource/:id', async (request, reply) => {
    if (deps.demoMode)
      return reply.code(409).send({ error: 'Demo data: there is nothing real to diagnose.' });
    const config = await entry(request.params.id);
    if (!config)
      return reply.code(404).send({ error: `no resources.yaml entry for "${request.params.id}"` });
    const report: DoctorReport = await diagnoseResource(config, { test });
    return report;
  });

  app.post<{ Params: { id: string } }>('/api/doctor/resource/:id/apply', async (request, reply) => {
    if (deps.demoMode) return reply.code(409).send({ error: 'Demo data: nothing to change.' });
    const body = ApplySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'patch expected' });
    const config = await entry(request.params.id);
    if (!config)
      return reply.code(404).send({ error: `no resources.yaml entry for "${request.params.id}"` });
    const refused = Object.keys(body.data.patch).filter((key) => !PATCHABLE_KEYS.has(key));
    if (refused.length > 0)
      return reply.code(422).send({ error: `not changeable by the Doctor: ${refused.join(', ')}` });
    // Prove it again right now: the target may have changed since the diagnosis.
    const proof = await test(applyPatch(config, body.data.patch));
    if (!proof.ok) {
      return reply
        .code(409)
        .send({ error: `The change did not connect, so nothing was saved: ${proof.error}` });
    }
    try {
      await patchResourceInFile(deps.resourcesFile, config.id, body.data.patch, PATCHABLE_KEYS);
    } catch (error) {
      if (error instanceof ResourceValidationError)
        return reply.code(422).send({ problems: error.problems });
      throw error;
    }
    deps.audit.append(
      'resource_edited',
      config.id,
      `Doctor fix applied: ${JSON.stringify(body.data.patch)}`,
    );
    await deps.reload();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/doctor/host/:id', async (request, reply) => {
    if (deps.demoMode)
      return reply.code(409).send({ error: 'Demo data: there is nothing real to diagnose.' });
    const host = deps.hosts().find((h) => h.id === request.params.id);
    if (!host) return reply.code(404).send({ error: `unknown server "${request.params.id}"` });
    return diagnoseHost(host, { test: () => deps.testHost(host) });
  });
}
