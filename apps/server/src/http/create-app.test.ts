import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildAllowedOrigins } from '../security/origin';
import { createApp, type CreateAppOptions } from './create-app';

const sessionToken = 'test-token';
const port = 4600;
const baseOptions: CreateAppOptions = {
  projectName: 'example',
  version: '0.0.0',
  sessionToken,
  port,
  allowedOrigins: buildAllowedOrigins([port]),
};

describe('session guard', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await createApp(baseOptions);
  });

  afterEach(async () => {
    await app.close();
  });

  it('rejects requests without a token', async () => {
    const response = await app.inject({ url: '/api/meta' });
    expect(response.statusCode).toBe(401);
  });

  it('rejects a wrong token', async () => {
    const response = await app.inject({ url: '/api/meta?token=wrong' });
    expect(response.statusCode).toBe(401);
  });

  it('accepts the query token and sets a strict, http-only cookie', async () => {
    const response = await app.inject({ url: `/api/meta?token=${sessionToken}` });
    expect(response.statusCode).toBe(200);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain(`session_token_${port}=${sessionToken}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('accepts the session cookie', async () => {
    const response = await app.inject({
      url: '/api/meta',
      headers: { cookie: `session_token_${port}=${sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ projectName: 'example', protocolVersion: 2 });
  });

  it('accepts a Bearer token', async () => {
    const response = await app.inject({
      url: '/api/meta',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(response.statusCode).toBe(200);
  });

  it('rejects foreign Host headers even with a valid token (DNS rebinding)', async () => {
    const response = await app.inject({
      url: `/api/meta?token=${sessionToken}`,
      headers: { host: 'attacker.example' },
    });
    expect(response.statusCode).toBe(421);
  });
});

describe('request logging', () => {
  it('never writes the session token to the log', async () => {
    const logLines: string[] = [];
    const app = await createApp({
      ...baseOptions,
      logger: { level: 'info', stream: { write: (line: string) => void logLines.push(line) } },
    });

    await app.inject({ url: `/api/meta?token=${sessionToken}` });
    await app.close();

    const log = logLines.join('');
    expect(log).toContain('[redacted]');
    expect(log).not.toContain(sessionToken);
  });
});
