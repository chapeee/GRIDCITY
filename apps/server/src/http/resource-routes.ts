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
  updateSecretRefsInFile,
} from '../config/resources-writer';
import { createConnector } from '../connectors';
import {
  errorMessage,
  redactSecrets,
  withTimeout,
  type ConnectorContext,
} from '../connectors/connector';
import type { AuditLog } from '../storage/audit-log';
import { overlaySecrets, type SecretStore } from '../storage/secret-vault';

/** Vault ids used only inside one test request to hand a typed secret to the connector. */
const ONE_TIME_PREFIX = '__test__.';
const TEST_TIMEOUT_MS = 25_000;

export interface ResourceRouteDependencies {
  audit: AuditLog;
  demoMode: boolean;
  resourcesFile: string;
  context: Omit<ConnectorContext, 'env'> & { env: NodeJS.ProcessEnv };
  /** The encrypted vault: credentials typed in the dialog are saved here. */
  secrets: SecretStore;
  /** Ids already used by servers (resources share the city layout with them). */
  hostIds(): Set<string>;
  /** Called after every write so the city reloads at once. */
  reload(): Promise<void>;
}

const OneTimeSecretsSchema = z.strictObject({
  /** Typed in the dialog. Test: used once. Add or Edit: saved encrypted. Never returned. */
  password: z.string().max(1024).optional(),
  accessKeyId: z.string().max(256).optional(),
  secretAccessKey: z.string().max(1024).optional(),
});

const TestBodySchema = z.object({ resource: z.unknown() }).extend(OneTimeSecretsSchema.shape);
const AddBodySchema = z.strictObject({
  resource: z.record(z.string(), z.unknown()),
  secrets: OneTimeSecretsSchema.optional(),
});

/** The vault references a config carries, for writing into resources.yaml. */
function refsOf(config: ResourceConfig): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const key of ['passwordSecret', 'accessKeyIdSecret', 'secretAccessKeySecret']) {
    const value = (config as Record<string, unknown>)[key];
    if (typeof value === 'string') refs[key] = value;
  }
  return refs;
}

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

  /** `{ resource, secrets }`, or a bare draft (older clients, scripts). */
  const splitBody = (body: unknown) => {
    const parsed = AddBodySchema.safeParse(body);
    return parsed.success
      ? { draft: parsed.data.resource, secrets: parsed.data.secrets ?? {} }
      : { draft: body, secrets: {} };
  };

  app.post('/api/resources', async (request, reply) => {
    if (deps.demoMode) return refuseInDemo(reply);
    const { draft, secrets } = splitBody(request.body);
    const stored: string[] = [];
    try {
      const config = parseResourceDraft(draft);
      // Credentials go to the encrypted vault; the file gets only their ids.
      const withRefs = withSecretRefs(config, secrets, (field, value) => {
        const id = secretId(config.id, field);
        deps.secrets.set(id, value);
        stored.push(id);
        return id;
      });
      const entry = { ...(draft as Record<string, unknown>), ...refsOf(withRefs) };
      for (const key of [
        'passwordEnv',
        'passwordFile',
        'accessKeyIdEnv',
        'secretAccessKeyEnv',
        'profile',
      ]) {
        if (!(key in withRefs)) delete entry[key];
      }
      const saved = await addResourceToFile(deps.resourcesFile, entry, deps.hostIds());
      deps.audit.append(
        'resource_added',
        saved.id,
        `${describeTarget(saved)}${stored.length > 0 ? ' (credentials saved encrypted)' : ''}`,
      );
      await deps.reload();
      return { ok: true, id: saved.id };
    } catch (error) {
      for (const id of stored) deps.secrets.delete(id); // nothing half-saved
      if (error instanceof ResourceValidationError)
        return reply.code(422).send({ problems: error.problems });
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/resources/:id', async (request, reply) => {
    if (deps.demoMode) return refuseInDemo(reply);
    const { secrets: rawSecrets, ...rest } = (request.body ?? {}) as Record<string, unknown>;
    const secrets = OneTimeSecretsSchema.safeParse(rawSecrets ?? {});
    const patch = ResourcePatchSchema.safeParse(rest);
    if (!patch.success || !secrets.success) {
      const issues = [...(patch.error?.issues ?? []), ...(secrets.error?.issues ?? [])];
      return reply
        .code(422)
        .send({ problems: issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
    }
    const id = request.params.id;
    try {
      if (Object.keys(patch.data).length > 0) {
        await editResourceInFile(deps.resourcesFile, id, patch.data);
      }
      const changed = await updateSecretRefsInFile(deps.resourcesFile, id, (config) =>
        withSecretRefs(config, secrets.data, (field, value) => {
          const vaultId = secretId(id, field);
          deps.secrets.set(vaultId, value);
          return vaultId;
        }),
      );
      deps.audit.append(
        'resource_edited',
        id,
        `${JSON.stringify(patch.data)}${changed ? ' (credentials replaced)' : ''}`,
      );
    } catch (error) {
      if (error instanceof ResourceValidationError)
        return reply.code(422).send({ problems: error.problems });
      throw error;
    }
    await deps.reload();
    return { ok: true };
  });

  /** Which credentials an entry has saved in the app (never the values). */
  app.get<{ Params: { id: string } }>('/api/resources/:id/credentials', async (request) => {
    const id = request.params.id;
    return {
      password: deps.secrets.has(secretId(id, 'password')),
      accessKey: deps.secrets.has(secretId(id, 'accessKeyId')),
    };
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
    deps.secrets.deletePrefix(`${request.params.id}.`); // its saved credentials go too
    deps.audit.append('resource_removed', request.params.id);
    await deps.reload();
    return { ok: true };
  });
}

/** Kinds that log in with a password. */
const PASSWORD_KINDS = new Set<ResourceConfig['kind']>([
  'postgres',
  'mysql',
  'mongodb',
  'redis',
  'mssql',
]);
/** Kinds that take an AWS-style access key pair. */
const KEY_KINDS = new Set<ResourceConfig['kind']>(['s3', 'rds', 'loadbalancer']);

export type SecretField = 'password' | 'accessKeyId' | 'secretAccessKey';

/**
 * Points a config at typed credentials. `store` saves one value and returns
 * the vault id to write in the config. A typed password replaces any
 * environment variable or file reference; a typed key pair replaces env
 * names and the profile. Fields the user left empty keep what was there.
 */
export function withSecretRefs(
  config: ResourceConfig,
  secrets: { password?: string; accessKeyId?: string; secretAccessKey?: string },
  store: (field: SecretField, value: string) => string,
): ResourceConfig {
  const next = { ...config } as Record<string, unknown>;
  if (secrets.password && PASSWORD_KINDS.has(config.kind)) {
    next.passwordSecret = store('password', secrets.password);
    delete next.passwordEnv;
    delete next.passwordFile;
  }
  if (secrets.accessKeyId && secrets.secretAccessKey && KEY_KINDS.has(config.kind)) {
    next.accessKeyIdSecret = store('accessKeyId', secrets.accessKeyId);
    next.secretAccessKeySecret = store('secretAccessKey', secrets.secretAccessKey);
    delete next.accessKeyIdEnv;
    delete next.secretAccessKeyEnv;
    delete next.profile;
  }
  return next as ResourceConfig;
}

/** Vault id of a credential saved for a resources.yaml entry. */
export const secretId = (entryId: string, field: SecretField) => `${entryId}.${field}`;

/** One real poll with the draft. A typed secret replaces the reference for this call only. */
export async function testResource(
  draft: ResourceConfig,
  secrets: z.infer<typeof OneTimeSecretsSchema>,
  context: ResourceRouteDependencies['context'],
): Promise<ResourceTestResult> {
  // Typed values go to the connector as one-time vault entries; nothing is stored.
  const oneTime: Record<string, string> = {};
  const config = withSecretRefs(draft, secrets, (field, value) => {
    const id = `${ONE_TIME_PREFIX}${field}`;
    oneTime[id] = value;
    return id;
  });
  const typed = [secrets.password, secrets.accessKeyId, secrets.secretAccessKey];
  const connector = createConnector(config, {
    ...context,
    secrets: overlaySecrets(oneTime, context.secrets),
  });
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
