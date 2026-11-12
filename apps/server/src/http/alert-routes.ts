import { ALERT_CHANNEL_TYPES, type AlertsView } from '@app/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ChannelInputError, type AlertCenter } from '../alerts/alert-center';
import type { AuditLog } from '../storage/audit-log';

export interface AlertRouteDeps {
  center: AlertCenter;
  audit: AuditLog;
  /** Demo data never notifies and settings cannot be saved. */
  demoMode: boolean;
}

const ChannelInputSchema = z.strictObject({
  type: z.enum(ALERT_CHANNEL_TYPES),
  name: z.string().max(80),
  enabled: z.boolean().default(true),
  events: z
    .strictObject({
      offline: z.boolean(),
      degraded: z.boolean(),
      recovered: z.boolean(),
      security: z.boolean().default(true),
    })
    .default({ offline: true, degraded: true, recovered: true, security: true }),
  settings: z.record(z.string(), z.string().max(4000)).default({}),
});

const TestSchema = z.union([
  z.strictObject({ id: z.string().min(1).max(64) }),
  z.strictObject({
    id: z.string().min(1).max(64).nullable().optional(),
    input: ChannelInputSchema,
  }),
]);

const SubscriptionSchema = z.strictObject({
  subscription: z.object({
    endpoint: z.url().refine((url) => url.startsWith('https://'), 'push endpoints are https'),
    expirationTime: z.number().nullable().optional(),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  }),
  label: z.string().max(80).default('Browser'),
});

/**
 * Alert channels and Web Push devices. Everything here is saved encrypted
 * and needs the usual token + Origin guards like every other write.
 */
export function registerAlertRoutes(app: FastifyInstance, deps: AlertRouteDeps): void {
  const { center, audit } = deps;

  const view = (): AlertsView => ({
    editable: !deps.demoMode,
    channels: deps.demoMode ? [] : center.channels(),
    push: deps.demoMode
      ? { publicKey: null, devices: [] }
      : { publicKey: center.publicKey(), devices: center.devices() },
  });

  const demoRefusal = (reply: FastifyReply) =>
    reply.code(409).send({ error: 'Demo data: alerts are not set up or sent.' });

  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof ChannelInputError)
      return reply.code(422).send({ problems: error.problems });
    return reply.code(502).send({ error: (error as Error).message });
  };

  const parse = <T>(schema: z.ZodType<T>, body: unknown, reply: FastifyReply): T | null => {
    const result = schema.safeParse(body);
    if (result.success) return result.data;
    void reply.code(422).send({
      problems: result.error.issues.map(
        (issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`,
      ),
    });
    return null;
  };

  app.get('/api/alerts', async () => view());

  app.post('/api/alerts/channels', async (request, reply) => {
    if (deps.demoMode) return demoRefusal(reply);
    const input = parse(ChannelInputSchema, request.body, reply);
    if (!input) return reply;
    try {
      const saved = center.saveChannel(null, input);
      audit.append('settings_changed', null, `alert channel added: ${saved.name} (${saved.type})`);
      return view();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>('/api/alerts/channels/:id', async (request, reply) => {
    if (deps.demoMode) return demoRefusal(reply);
    const input = parse(ChannelInputSchema, request.body, reply);
    if (!input) return reply;
    try {
      const saved = center.saveChannel(request.params.id, input);
      audit.append('settings_changed', null, `alert channel edited: ${saved.name} (${saved.type})`);
      return view();
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/alerts/channels/:id', async (request, reply) => {
    if (deps.demoMode) return demoRefusal(reply);
    const name = center.channels().find((channel) => channel.id === request.params.id)?.name;
    if (!center.removeChannel(request.params.id)) {
      return reply.code(404).send({ error: 'No such channel.' });
    }
    audit.append('settings_changed', null, `alert channel removed: ${name ?? request.params.id}`);
    return view();
  });

  /** A saved channel ({ id }) or the form as typed ({ input, id? }), so it can be tried before saving. */
  app.post('/api/alerts/test', async (request, reply) => {
    if (deps.demoMode) return demoRefusal(reply);
    const target = parse(TestSchema, request.body, reply);
    if (!target) return reply;
    try {
      await center.testChannel(target);
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post('/api/alerts/push', async (request, reply) => {
    if (deps.demoMode) return demoRefusal(reply);
    const body = parse(SubscriptionSchema, request.body, reply);
    if (!body) return reply;
    const device = center.subscribe(body.subscription, body.label);
    audit.append('settings_changed', null, `push notifications on: ${device.label}`);
    return { device, view: view() };
  });

  app.delete<{ Params: { id: string } }>('/api/alerts/push/:id', async (request, reply) => {
    if (deps.demoMode) return demoRefusal(reply);
    const label = center.devices().find((device) => device.id === request.params.id)?.label;
    if (!center.unsubscribe(request.params.id))
      return reply.code(404).send({ error: 'Not subscribed.' });
    audit.append('settings_changed', null, `push notifications off: ${label ?? request.params.id}`);
    return view();
  });

  app.post<{ Params: { id: string } }>('/api/alerts/push/:id/test', async (request, reply) => {
    if (deps.demoMode) return demoRefusal(reply);
    try {
      await center.testDevice(request.params.id);
      return { ok: true };
    } catch (error) {
      return fail(reply, error);
    }
  });
}
