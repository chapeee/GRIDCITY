import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UpdateChecker } from '../updates/update-check';

export interface UpdateRoutesDeps {
  updates: UpdateChecker;
  /** Saves the Settings switch (and audits it). */
  setEnabled: (enabled: boolean) => void;
}

const EnabledBodySchema = z.object({ enabled: z.boolean() });

/**
 * "Is a newer GRIDCITY out?" for the in-app notice and Settings. Works in demo
 * mode too: the switch is an app setting, not part of hosts.yaml.
 */
export function registerUpdateRoutes(app: FastifyInstance, deps: UpdateRoutesDeps): void {
  app.get('/api/update', async () => deps.updates.view());

  /** The "Check now" button. */
  app.post('/api/update/check', async () => deps.updates.check());

  app.put('/api/update', async (request, reply) => {
    const body = EnabledBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(422).send({ problems: ['enabled: true or false'] });
    if (body.data.enabled && deps.updates.view().lockedOff) {
      return reply
        .code(409)
        .send({ error: 'GRIDCITY_UPDATE_CHECK=off is set: remove it to turn the check on.' });
    }
    deps.setEnabled(body.data.enabled);
    return body.data.enabled ? deps.updates.check() : deps.updates.view();
  });
}
