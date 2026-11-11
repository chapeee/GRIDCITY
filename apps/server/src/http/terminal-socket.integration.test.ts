import type { Host, StatusThresholds, TerminalServerMessage } from '@app/shared';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { RealFleet } from '../fleet/real-fleet';
import { buildAllowedOrigins } from '../security/origin';
import { buildAuthOptions } from '../ssh/auth-options';
import { HostConnection } from '../ssh/host-connection';
import { parseKnownHosts } from '../ssh/known-hosts';
import { AuditLog } from '../storage/audit-log';
import { openDatabase } from '../storage/database';
import { startFakeSshServer, type FakeSshServer } from '../testing/fake-ssh-server';
import { createApp } from './create-app';
import { registerTerminalSocket } from './terminal-socket';

/** Terminal end to end: browser WebSocket -> server -> PTY on the existing SSH connection. */

const TOKEN = 'terminal-test-token';
const ORIGIN = 'http://127.0.0.1:4601';
const thresholds: StatusThresholds = {
  pollIntervalMs: 500,
  staleAfterPolls: 3,
  discoveryIntervalMs: 60_000,
  cpuDegradedPercent: 90,
  cpuDegradedPolls: 3,
  memoryDegradedPercent: 90,
  diskDegradedPercent: 90,
};

let workDir: string;
let sshServer: FakeSshServer;
let fleet: RealFleet;
let app: FastifyInstance;
let audit: AuditLog;
let baseUrl: string;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'terminal-e2e-'));
  // Client test keys are ECDSA: rarely, a freshly generated ed25519 key failed ssh2's
  // connect-time parse in parallel test runs (not reproducible directly; real keys unaffected).
  const keys = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
  const keyFile = join(workDir, 'id');
  writeFileSync(keyFile, keys.private, { mode: 0o600 });
  sshServer = await startFakeSshServer({ authorizedKey: keys.public, user: 'ops' });

  const host: Host = {
    id: 'lab-01',
    name: 'lab-01',
    address: '127.0.0.1',
    port: sshServer.port,
    user: 'ops',
    district: 'lab',
    tags: [],
    auth: { method: 'keyFile', path: keyFile },
  };
  audit = new AuditLog(openDatabase(':memory:'));
  fleet = new RealFleet({
    hosts: [host],
    thresholds,
    createConnection: (target, onPhaseChange) =>
      new HostConnection({
        host: target,
        onPhaseChange,
        loadKnownHosts: () => parseKnownHosts(sshServer.knownHostsLine),
        buildAuth: (h) =>
          buildAuthOptions(h.auth, { env: {}, platform: process.platform, homeDir: workDir }),
      }),
  });
  fleet.start(() => {});

  app = await createApp({
    projectName: 'example',
    version: '0',
    sessionToken: TOKEN,
    port: 4600,
    allowedOrigins: buildAllowedOrigins([4600, 4601]),
    registerRoutes: (instance) =>
      registerTerminalSocket(instance, {
        audit,
        resolve: (hostId) => {
          const connection = fleet.connectionFor(hostId);
          return connection
            ? { kind: 'connection', connection }
            : { kind: 'unavailable', message: `Unknown host "${hostId}".` };
        },
      }),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  baseUrl = `ws://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  // Wait for the SSH connection before opening terminals.
  const deadline = Date.now() + 8000;
  while (fleet.connectionFor('lab-01')?.phase !== 'connected') {
    if (Date.now() > deadline) throw new Error('SSH connection not established');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
});

afterAll(async () => {
  fleet.stop();
  await app.close();
  await sshServer.close();
  rmSync(workDir, { recursive: true, force: true });
});

/** Opens a terminal socket, collecting output text and control messages. */
function openTerminal(hostId: string) {
  const socket = new WebSocket(`${baseUrl}/ws/terminal/${hostId}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN },
  });
  const session = { output: '', control: [] as TerminalServerMessage[], closed: false };
  socket.on('message', (data, isBinary) => {
    if (isBinary) session.output += data.toString();
    else session.control.push(JSON.parse(data.toString()) as TerminalServerMessage);
  });
  socket.on('close', () => (session.closed = true));
  const opened = new Promise<void>((resolve) => socket.on('open', () => resolve()));
  return { socket, session, opened };
}

async function eventually(check: () => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('terminal over SSH', () => {
  it('opens a PTY, streams both ways, resizes, and closes on exit', async () => {
    const { socket, session, opened } = openTerminal('lab-01');
    await opened;
    socket.send(JSON.stringify({ type: 'open', cols: 100, rows: 30 }));
    await eventually(() => session.control.some((m) => m.type === 'ready'));
    await eventually(() => session.output.includes('fake-shell ready'));
    expect(sshServer.lastWindow).toEqual({ cols: 100, rows: 30 });

    socket.send(Buffer.from('echo hi\r'), { binary: true });
    await eventually(() => session.output.includes('you typed: echo hi'));

    socket.send(JSON.stringify({ type: 'resize', cols: 140, rows: 40 }));
    await eventually(() => sshServer.lastWindow?.cols === 140);
    expect(sshServer.lastWindow).toEqual({ cols: 140, rows: 40 });

    socket.send(Buffer.from('exit\r'), { binary: true });
    await eventually(() => session.closed);
    expect(session.control.at(-1)).toEqual({ type: 'exit', code: 0, signal: null });

    const kinds = audit.recent().map((entry) => entry.kind);
    expect(kinds).toContain('terminal_opened');
    expect(kinds).toContain('terminal_closed');
  });

  it('records session open/close but never the keystrokes', async () => {
    const details = audit.recent().map((entry) => entry.detail ?? '');
    expect(details.join(' ')).not.toContain('echo hi');
  });

  it('refuses unknown hosts with a clear message', async () => {
    const { socket, session, opened } = openTerminal('nope');
    await opened;
    socket.send(JSON.stringify({ type: 'open', cols: 80, rows: 24 }));
    await eventually(() => session.closed);
    expect(session.control).toEqual([{ type: 'error', message: 'Unknown host "nope".' }]);
  });

  it('rejects absurd terminal sizes (no PTY opened)', async () => {
    const { socket, session, opened } = openTerminal('lab-01');
    await opened;
    socket.send(JSON.stringify({ type: 'open', cols: 100000, rows: 1 }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(session.control).toEqual([]); // ignored; it would time out without opening
    socket.close();
  });

  it('closes the shell when the SSH connection drops, telling the browser', async () => {
    const { socket, session, opened } = openTerminal('lab-01');
    await opened;
    socket.send(JSON.stringify({ type: 'open', cols: 80, rows: 24 }));
    await eventually(() => session.control.some((m) => m.type === 'ready'));
    sshServer.dropAllClients();
    await eventually(() => session.closed);
    expect(session.control.at(-1)?.type).toBe('exit');
  });
});
