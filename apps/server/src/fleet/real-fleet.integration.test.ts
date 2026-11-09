import type { Host, HostState, StatusThresholds } from '@app/shared';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { utils } from 'ssh2';
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { buildAuthOptions } from '../ssh/auth-options';
import { HostConnection } from '../ssh/host-connection';
import { parseKnownHosts } from '../ssh/known-hosts';
import { AuditLog } from '../storage/audit-log';
import { openDatabase } from '../storage/database';
import { startFakeSshServer, type FakeSshServer } from '../testing/fake-ssh-server';
import type { FleetEvent } from './fleet-provider';
import { RealFleet } from './real-fleet';

/**
 * End to end over real SSH: connection manager + known_hosts + key auth +
 * collector exec + parsing + status rules, against an in-process SSH server.
 * These are the truth rules the brief asks us to verify.
 */

const USER = 'ops';
/** Fast timings so the whole suite runs in seconds. */
const thresholds: StatusThresholds = {
  pollIntervalMs: 250,
  staleAfterPolls: 3,
  cpuDegradedPercent: 90,
  cpuDegradedPolls: 3,
  memoryDegradedPercent: 90,
  diskDegradedPercent: 90,
};

let workDir: string;
let keyFile: string;
let clientPublicKey: string;
let server: FakeSshServer;
const running: RealFleet[] = [];

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), 'fleet-e2e-'));
  const keys = utils.generateKeyPairSync('ed25519');
  keyFile = join(workDir, 'id_ed25519');
  writeFileSync(keyFile, keys.private, { mode: 0o600 });
  clientPublicKey = keys.public;
});

afterAll(() => rmSync(workDir, { recursive: true, force: true }));

afterEach(async () => {
  for (const fleet of running.splice(0)) fleet.stop();
  await server?.close();
});

function hostFor(port: number, keyPath = keyFile): Host {
  return {
    id: 'lab-01',
    name: 'lab-01',
    address: '127.0.0.1',
    port,
    user: USER,
    district: 'lab',
    tags: [],
    auth: { method: 'keyFile', path: keyPath },
  };
}

function startFleet(host: Host, knownHosts: string) {
  const db = openDatabase(':memory:');
  const audit = new AuditLog(db);
  const events: FleetEvent[] = [];
  const fleet = new RealFleet({
    hosts: [host],
    thresholds,
    audit,
    createConnection: (target, onPhaseChange) =>
      new HostConnection({
        host: target,
        onPhaseChange,
        loadKnownHosts: () => parseKnownHosts(knownHosts),
        buildAuth: (h) =>
          buildAuthOptions(h.auth, { env: {}, platform: process.platform, homeDir: workDir }),
        keepaliveIntervalMs: 200,
        keepaliveCountMax: 2,
        readyTimeoutMs: 3000,
        backoff: { baseMs: 100, maxMs: 400, jitterRatio: 0 },
      }),
  });
  fleet.start((event) => events.push(event));
  running.push(fleet);
  const state = (): HostState => fleet.currentStates(Date.now())[0]!;
  return { fleet, audit, events, state };
}

async function eventually(check: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('RealFleet over SSH', () => {
  it('connects with a key file, polls, and reports real metrics', async () => {
    server = await startFakeSshServer({ authorizedKey: clientPublicKey, user: USER });
    const { state, audit } = startFleet(hostFor(server.port), server.knownHostsLine);

    await eventually(() => state().cpuPercent !== null); // needs two polls
    const current = state();
    expect(current.status).toBe('online');
    expect(current.os).toMatch(/Debian/);
    expect(current.memory?.totalBytes).toBeGreaterThan(0);
    expect(current.disks.map((d) => d.mount)).toEqual(['/']);
    expect(current.stale).toBe(false);
    expect(audit.recent().map((e) => e.kind)).toContain('connection_opened');
  });

  it('refuses a host key that is not in known_hosts, and says so', async () => {
    server = await startFakeSshServer({ authorizedKey: clientPublicKey, user: USER });
    const { state, events, audit } = startFleet(hostFor(server.port), '');

    await eventually(() => state().status === 'offline');
    expect(state().statusReason).toMatch(/not in known_hosts/);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'hostKeyRefused',
        reason: 'unknown',
        fingerprint: expect.stringMatching(/^SHA256:/),
      }),
    );
    expect(server.execCount).toBe(0); // nothing ever ran on the host
    expect(audit.recent()[0]?.kind).toBe('host_key_refused');
  });

  it('refuses a changed host key as a possible man-in-the-middle', async () => {
    server = await startFakeSshServer({ authorizedKey: clientPublicKey, user: USER });
    const impostor = utils.generateKeyPairSync('ed25519').public.split(' ').slice(0, 2).join(' ');
    const { state, events } = startFleet(
      hostFor(server.port),
      `[127.0.0.1]:${server.port} ${impostor}`,
    );

    await eventually(() => state().status === 'offline');
    expect(state().statusReason).toMatch(/HOST KEY CHANGED/);
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'hostKeyRefused', reason: 'changed' }),
    );
    expect(server.execCount).toBe(0);
  });

  it('goes offline when the connection is killed, then recovers on reconnect', async () => {
    server = await startFakeSshServer({ authorizedKey: clientPublicKey, user: USER });
    const { state, audit } = startFleet(hostFor(server.port), server.knownHostsLine);
    await eventually(() => state().status === 'online');
    const lastSeen = state().lastSeenAt;

    server.dropAllClients();
    await eventually(() => state().status === 'offline');
    expect(state().memory).toBeNull(); // offline: current metrics are unknown
    expect(state().lastSeenAt).not.toBeNull();
    expect(state().lastSeenAt).toBeGreaterThanOrEqual(lastSeen!);

    await eventually(() => state().status === 'online' && state().lastSeenAt! > lastSeen!);
    const kinds = audit.recent().map((e) => e.kind);
    expect(kinds).toContain('connection_lost');
    expect(kinds.filter((k) => k === 'connection_opened').length).toBeGreaterThanOrEqual(2);
  });

  it('goes stale (not offline) when polling is blocked on a live connection', async () => {
    server = await startFakeSshServer({ authorizedKey: clientPublicKey, user: USER });
    const { state } = startFleet(hostFor(server.port), server.knownHostsLine);
    await eventually(() => state().status === 'online');

    server.execBehavior = 'stall';
    await eventually(() => state().stale);
    const current = state();
    expect(current.status).not.toBe('offline');
    expect(current.memory).not.toBeNull(); // last known values stay visible
    await eventually(() => /timed out/.test(state().error ?? ''));
  });

  it('treats unparseable output as a failed poll, never as data', async () => {
    server = await startFakeSshServer({ authorizedKey: clientPublicKey, user: USER });
    server.execBehavior = 'garbage';
    const { state } = startFleet(hostFor(server.port), server.knownHostsLine);
    await eventually(() => state().error === 'metrics output was incomplete');
    expect(state().status).toBe('unknown'); // connected, but no valid poll yet
    expect(state().memory).toBeNull();
  });

  it('reports a rejected client key as an authentication failure', async () => {
    server = await startFakeSshServer({ authorizedKey: clientPublicKey, user: USER });
    const otherKey = join(workDir, 'other_key');
    writeFileSync(otherKey, utils.generateKeyPairSync('ed25519').private, { mode: 0o600 });
    const { state } = startFleet(hostFor(server.port, otherKey), server.knownHostsLine);
    await eventually(() => state().status === 'offline');
    expect(state().statusReason).toMatch(/authentication failed/);
  });

  it('reports a closed port clearly', async () => {
    server = await startFakeSshServer({ authorizedKey: clientPublicKey, user: USER });
    const port = server.port;
    await server.close();
    const { state } = startFleet(hostFor(port), '');
    await eventually(() => state().status === 'offline');
    expect(state().statusReason).toMatch(/ECONNREFUSED/);
  });
});
