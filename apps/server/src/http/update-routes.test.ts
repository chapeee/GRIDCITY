import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { UpdateChecker } from '../updates/update-check';
import { registerUpdateRoutes } from './update-routes';

function setup(lockedOff = false) {
  let enabled = true;
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v1.0.1' })));
  const updates = new UpdateChecker({
    currentVersion: '1.0.0',
    install: 'desktop',
    enabled: () => enabled,
    lockedOff,
    fetch: fetchImpl as unknown as typeof fetch,
  });
  const app = Fastify();
  registerUpdateRoutes(app, { updates, setEnabled: (next) => (enabled = next) });
  return { app, fetchImpl };
}

describe('update routes', () => {
  it('checks on demand and reports the newer version', async () => {
    const { app } = setup();
    const checked = (await app.inject({ method: 'POST', url: '/api/update/check' })).json();
    expect(checked).toMatchObject({ current: '1.0.0', latest: '1.0.1', available: true });
    expect((await app.inject({ url: '/api/update' })).json()).toMatchObject({ available: true });
  });

  it('turns the check off and on', async () => {
    const { app, fetchImpl } = setup();
    const off = await app.inject({
      method: 'PUT',
      url: '/api/update',
      payload: { enabled: false },
    });
    expect(off.json()).toMatchObject({ enabled: false, available: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    const on = await app.inject({ method: 'PUT', url: '/api/update', payload: { enabled: true } });
    expect(on.json()).toMatchObject({ enabled: true, available: true });
  });

  it('refuses to turn on what the environment turned off', async () => {
    const { app } = setup(true);
    const on = await app.inject({ method: 'PUT', url: '/api/update', payload: { enabled: true } });
    expect(on.statusCode).toBe(409);
  });
});
