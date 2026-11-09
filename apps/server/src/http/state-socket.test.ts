import {
  createUnknownHostState,
  DEFAULT_STATUS_THRESHOLDS,
  type Host,
  type ServerMessage,
} from '@app/shared';
import type { FastifyInstance } from 'fastify';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FleetProvider } from '../fleet/fleet-provider';
import { StateHub } from '../fleet/state-hub';
import { buildAllowedOrigins, isAllowedOrigin, requiresOriginCheck } from '../security/origin';
import { openDatabase } from '../storage/database';
import { AuditLog } from '../storage/audit-log';
import { registerApiRoutes } from './api-routes';
import { createApp } from './create-app';
import { registerStateSocket } from './state-socket';

const TOKEN = 'test-token';
const WEB_PORT = 4601;
const ALLOWED_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

const host: Host = {
  id: 'web-01',
  name: 'web-01',
  address: '10.0.0.1',
  port: 22,
  user: 'ops',
  district: 'lab',
  tags: [],
  auth: { method: 'agent' },
};

const provider: FleetProvider = {
  dataMode: 'real',
  hosts: [host],
  thresholds: DEFAULT_STATUS_THRESHOLDS,
  start: () => {},
  stop: () => {},
  currentStates: () => [createUnknownHostState('web-01')],
};

describe('origin rules', () => {
  const allowed = buildAllowedOrigins([4600, 4601]);
  it('allows only this machine on our ports', () => {
    expect(isAllowedOrigin('http://localhost:4601', allowed)).toBe(true);
    expect(isAllowedOrigin('http://[::1]:4600', allowed)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:9999', allowed)).toBe(false);
    expect(isAllowedOrigin('https://evil.example', allowed)).toBe(false);
    expect(isAllowedOrigin(undefined, allowed)).toBe(false);
  });

  it('checks upgrades and writes, not reads', () => {
    expect(requiresOriginCheck('GET', 'websocket')).toBe(true);
    expect(requiresOriginCheck('POST', undefined)).toBe(true);
    expect(requiresOriginCheck('GET', undefined)).toBe(false);
  });
});

describe('state WebSocket and API over a real socket', () => {
  let app: FastifyInstance;
  let hub: StateHub;
  let baseUrl: string;

  beforeEach(async () => {
    hub = new StateHub({ provider, projectName: 'example', staleCheckIntervalMs: 60_000 });
    hub.start();
    const db = openDatabase(':memory:');
    app = await createApp({
      projectName: 'example',
      version: '0.0.0',
      sessionToken: TOKEN,
      port: 4600,
      allowedOrigins: buildAllowedOrigins([4600, WEB_PORT]),
      registerRoutes: async (instance) => {
        await registerStateSocket(instance, hub);
        registerApiRoutes(instance, {
          audit: new AuditLog(db),
          importSshConfig: async () => ({
            added: ['x'],
            skipped: [],
            warnings: [],
            hostsFile: '/h',
          }),
        });
      },
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    baseUrl = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    hub.stop();
    await app.close();
  });

  /** Opens a socket and collects messages; resolves on open or rejects with the HTTP status. */
  function connect(headers: Record<string, string>) {
    const messages: ServerMessage[] = [];
    const socket = new WebSocket(`ws://${baseUrl}/ws/state`, { headers });
    socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as ServerMessage));
    const opened = new Promise<void>((resolve, reject) => {
      socket.on('open', () => resolve());
      socket.on('unexpected-response', (_request, response) => {
        socket.terminate();
        reject(new Error(`HTTP ${response.statusCode}`));
      });
      socket.on('error', reject);
    });
    return { socket, messages, opened };
  }

  const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 100 && !condition(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('streams hello and snapshot to an authenticated, same-origin client', async () => {
    const { socket, messages, opened } = connect({
      Authorization: `Bearer ${TOKEN}`,
      Origin: ALLOWED_ORIGIN,
    });
    await opened;
    await waitFor(() => messages.length >= 2);
    expect(messages.map((m) => m.type)).toEqual(['hello', 'snapshot']);
    socket.close();
  });

  it('answers resync with a snapshot and rejects malformed messages', async () => {
    const { socket, messages, opened } = connect({
      Authorization: `Bearer ${TOKEN}`,
      Origin: ALLOWED_ORIGIN,
    });
    await opened;
    socket.send(JSON.stringify({ type: 'resync' }));
    socket.send('not json');
    await waitFor(() => messages.length >= 4);
    expect(messages.slice(2).map((m) => m.type)).toEqual(['snapshot', 'error']);
    socket.close();
  });

  it('refuses an upgrade without the session token', async () => {
    await expect(connect({ Origin: ALLOWED_ORIGIN }).opened).rejects.toThrow('HTTP 401');
  });

  it('refuses an upgrade from a foreign origin, even with the token', async () => {
    await expect(
      connect({ Authorization: `Bearer ${TOKEN}`, Origin: 'https://evil.example' }).opened,
    ).rejects.toThrow('HTTP 403');
  });

  it('refuses an upgrade without an Origin header', async () => {
    await expect(connect({ Authorization: `Bearer ${TOKEN}` }).opened).rejects.toThrow('HTTP 403');
  });

  it('requires our Origin for state-changing API calls', async () => {
    const url = `http://${baseUrl}/api/hosts/import-ssh-config`;
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await fetch(url, { method: 'POST', headers: auth })).status).toBe(403);
    const ok = await fetch(url, { method: 'POST', headers: { ...auth, Origin: ALLOWED_ORIGIN } });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ added: ['x'] });
  });

  it('serves the audit log to authenticated readers', async () => {
    const response = await fetch(`http://${baseUrl}/api/audit`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [] });
  });
});
