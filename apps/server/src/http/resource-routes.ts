import type { ResourceMetric } from '@app/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ResourceConfig } from '../config/resources-file';
import {
  addResourceToFile,
  editResourceInFile,
  parseResourceDraft,
  removeResourceFromFile,
  ResourcePatchSchema,
  ResourceValidationError,
} from '../config/resources-writer';
import { createConnector } from '../connectors';
import {
  errorMessage,
  redactSecrets,
  withTimeout,
  type ConnectorContext,
} from '../connectors/connector';
import type { AuditLog } from '../storage/audit-log';

/** Names used only inside one test request to hand a typed secret to the connector. */
const ONE_TIME_PASSWORD = '__ONE_TIME_PASSWORD__';
const ONE_TIME_KEY_ID = '__ONE_TIME_ACCESS_KEY_ID__';
const ONE_TIME_SECRET = '__ONE_TIME_SECRET_ACCESS_KEY__';
const TEST_TIMEOUT_MS = 25_000;

export interface ResourceRouteDependencies {
  audit: AuditLog;
  demoMode: boolean;
  resourcesFile: string;
  context: Omit<ConnectorContext, 'env'> & { env: NodeJS.ProcessEnv };
  /** Ids already used by servers (resources share the city layout with them). */
  hostIds(): Set<string>;
  /** Called after every write so the city reloads at once. */
  reload(): Promise<void>;
}

const OneTimeSecretsSchema = z.strictObject({
  /** Typed once to test; never written anywhere, never returned. */
  password: z.string().max(1024).optional(),
  accessKeyId: z.string().max(256).optional(),
  secretAccessKey: z.string().max(1024).optional(),
});

const TestBodySchema = z.object({ resource: z.unknown() }).extend(OneTimeSecretsSchema.shape);

export interface ResourceTestResult {
  ok: boolean;
  /** One line per resource the entry stands for (a database, or each instance / bucket found). */
  found: {
    name: string;
    engine: string;
    ok: boolean;
    error: string | null;
    metrics: ResourceMetric[];
  }[];
  error: string | null;
}

/**
 * "Connect a database or bucket": test a draft with one real poll, add it to
 * resources.yaml, edit its label or remove it. Writes need the usual session
 * token, cookie and Origin; secrets typed for a test stay in request memory.
 */
export function registerResourceRoutes(
  app: FastifyInstance,
  deps: ResourceRouteDependencies,
): void {
  const refuseInDemo = (reply: { code(status: number): { send(body: unknown): unknown } }) =>
    reply.code(409).send({ error: 'Demo data: resources cannot be added or changed.' });

  app.post('/api/resources/test', async (request, reply) => {
    if (deps.demoMode) return refuseInDemo(reply);
    const body = TestBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'resource expected' });
    let config: ResourceConfig;
    try {
      config = parseResourceDraft(body.data.resource);
    } catch (error) {
      if (error instanceof ResourceValidationError)
        return reply.code(422).send({ problems: error.problems });
      throw error;
    }
    return testResource(config, body.data, deps.context);
  });

  app.post('/api/resources', async (request, reply) => {
    if (deps.demoMode) return refuseInDemo(reply);
    try {
      const saved = await addResourceToFile(deps.resourcesFile, request.body, deps.hostIds());
      deps.audit.append('resource_added', saved.id, describeTarget(saved));
      await deps.reload();
      return { ok: true, id: saved.id };
    } catch (error) {
      if (error instanceof ResourceValidationError)
        return reply.code(422).send({ problems: error.problems });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/resources/:id', async (request, reply) => {
    if (deps.demoMode) return refuseInDemo(reply);
    const patch = ResourcePatchSchema.safeParse(request.body);
    if (!patch.success) {
      return reply
        .code(422)
        .send({ problems: patch.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    try {
      await editResourceInFile(deps.resourcesFile, request.params.id, patch.data);
    } catch (error) {
      if (error instanceof ResourceValidationError)
        return reply.code(422).send({ problems: error.problems });
      throw error;
    }
    deps.audit.append('resource_edited', request.params.id, JSON.stringify(patch.data));
    await deps.reload();
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/resources/:id', async (request, reply) => {
    if (deps.demoMode) return refuseInDemo(reply);
    try {
      await removeResourceFromFile(deps.resourcesFile, request.params.id);
    } catch (error) {
      if (error instanceof ResourceValidationError)
        return reply.code(422).send({ problems: error.problems });
      throw error;
    }
    deps.audit.append('resource_removed', request.params.id);
    await deps.reload();
    return { ok: true };
  });
}

/** One real poll with the draft. A typed secret replaces the reference for this call only. */
export async function testResource(
  draft: ResourceConfig,
  secrets: z.infer<typeof OneTimeSecretsSchema>,
  context: ResourceRouteDependencies['context'],
): Promise<ResourceTestResult> {
  const env: NodeJS.ProcessEnv = { ...context.env };
  let config: ResourceConfig = draft;
  if (secrets.password && 'passwordEnv' in draft) {
    env[ONE_TIME_PASSWORD] = secrets.password;
    config = {
      ...draft,
      passwordEnv: ONE_TIME_PASSWORD,
      passwordFile: undefined,
    } as ResourceConfig;
  }
  if (draft.kind === 's3' && secrets.accessKeyId && secrets.secretAccessKey) {
    env[ONE_TIME_KEY_ID] = secrets.accessKeyId;
    env[ONE_TIME_SECRET] = secrets.secretAccessKey;
    config = {
      ...draft,
      accessKeyIdEnv: ONE_TIME_KEY_ID,
      secretAccessKeyEnv: ONE_TIME_SECRET,
      profile: undefined,
    };
  }
  const typed = [secrets.password, secrets.accessKeyId, secrets.secretAccessKey];
  const connector = createConnector(config, { ...context, env });
  try {
    const outcomes = await withTimeout(connector.poll(), TEST_TIMEOUT_MS, 'connection test');
    const resources = connector.resources();
    const found = outcomes.map((outcome) => {
      const resource = resources.find((r) => r.id === outcome.resourceId);
      return {
        name: resource?.name ?? outcome.resourceId,
        engine: resource?.engine ?? draft.kind,
        ok: outcome.ok,
        error: outcome.ok ? null : redactSecrets(outcome.error, typed),
        metrics: outcome.ok ? outcome.metrics.filter((m) => m.value !== null || m.text) : [],
      };
    });
    const ok = found.length > 0 && found.every((entry) => entry.ok);
    return {
      ok,
      found,
      error:
        found.length === 0
          ? 'Connected, but found nothing to watch (no instances or buckets visible to these credentials).'
          : null,
    };
  } catch (error) {
    return { ok: false, found: [], error: redactSecrets(errorMessage(error), typed) };
  } finally {
    await connector.close().catch(() => undefined);
  }
}

function describeTarget(config: ResourceConfig): string {
  switch (config.kind) {
    case 'sqlite':
      return `sqlite ${config.path}`;
    case 'mongodb':
      return 'mongodb';
    case 'rds':
      return `rds ${config.region}`;
    case 's3':
      return `s3 ${config.provider}${config.endpoint ? ` ${config.endpoint}` : ''}`;
    case 'http':
      return `http ${config.url}`;
    case 'loadbalancer':
      return `loadbalancer ${config.provider} ${config.region}`;
    default:
      return `${config.kind} ${config.host}:${config.port}`;
  }
}
