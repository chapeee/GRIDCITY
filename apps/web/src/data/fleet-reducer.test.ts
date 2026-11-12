import {
  createUnknownHostState,
  DEFAULT_STATUS_THRESHOLDS,
  PROTOCOL_VERSION,
  type Host,
  type HostState,
  type ServerMessage,
} from '@app/shared';
import { describe, expect, it } from 'vitest';
import { EMPTY_FLEET, HISTORY_LENGTH, reduceFleet, type FleetSnapshot } from './fleet-reducer';

const host = (id: string): Host => ({
  id,
  name: id,
  address: '203.0.113.1',
  port: 22,
  user: 'ops',
  district: 'default',
  tags: [],
  auth: { method: 'agent' },
});

const polled = (id: string, lastSeenAt: number): HostState => ({
  ...createUnknownHostState(id),
  status: 'online',
  lastSeenAt,
  cpuPercent: 10,
  memory: { usedBytes: 1, totalBytes: 4 },
  network: [{ iface: 'eth0', rxBytesPerSec: 100, txBytesPerSec: 50 }],
});

const hello = (dataMode: 'real' | 'demo', protocolVersion = PROTOCOL_VERSION): ServerMessage => ({
  type: 'hello',
  protocolVersion,
  dataMode,
  projectName: 'example',
  thresholds: DEFAULT_STATUS_THRESHOLDS,
});

const apply = (messages: ServerMessage[], start: FleetSnapshot = EMPTY_FLEET) =>
  messages.reduce(reduceFleet, start);

describe('reduceFleet', () => {
  it('records data mode and thresholds from hello', () => {
    const fleet = apply([hello('demo')]);
    expect(fleet.dataMode).toBe('demo');
    expect(fleet.protocolMismatch).toBe(false);
  });

  it('flags a protocol version mismatch', () => {
    expect(apply([hello('real', 99)]).protocolMismatch).toBe(true);
  });

  it('wipes everything when the data mode changes (never mix demo and real)', () => {
    const demo = apply([
      hello('demo'),
      {
        type: 'snapshot',
        resources: [],
        resourceStates: [],
        districts: [],
        links: [],
        runbooks: [],
        threats: [],
        layoutSlots: {},
        hosts: [host('a')],
        states: [polled('a', 1000)],
      },
    ]);
    const real = reduceFleet(demo, hello('real'));
    expect(real.hosts).toEqual([]);
    expect(real.states).toEqual({});
    expect(real.history).toEqual({});
  });

  it('builds history only from new polls', () => {
    const fleet = apply([
      {
        type: 'snapshot',
        resources: [],
        resourceStates: [],
        districts: [],
        links: [],
        runbooks: [],
        threats: [],
        layoutSlots: {},
        hosts: [host('a')],
        states: [createUnknownHostState('a')],
      },
      { type: 'hostStates', states: [polled('a', 1000)] },
      { type: 'hostStates', states: [polled('a', 1000)] }, // re-sent, e.g. stale
      { type: 'hostStates', states: [polled('a', 3000)] },
    ]);
    expect(fleet.history.a?.map((s) => s.at)).toEqual([1000, 3000]);
    expect(fleet.history.a?.[0]).toMatchObject({
      cpuPercent: 10,
      memoryPercent: 25,
      networkBytesPerSec: 150,
    });
  });

  it('caps history length', () => {
    const messages: ServerMessage[] = Array.from({ length: HISTORY_LENGTH + 10 }, (_, i) => ({
      type: 'hostStates',
      states: [polled('a', (i + 1) * 1000)],
    }));
    expect(apply(messages).history.a).toHaveLength(HISTORY_LENGTH);
  });

  it('removes a host with all its data', () => {
    const fleet = apply([
      {
        type: 'snapshot',
        resources: [],
        resourceStates: [],
        districts: [],
        links: [],
        runbooks: [],
        threats: [],
        layoutSlots: {},
        hosts: [host('a'), host('b')],
        states: [polled('a', 1), polled('b', 1)],
      },
      { type: 'hostKeyRefused', hostId: 'a', reason: 'changed', fingerprint: 'SHA256:x' },
      { type: 'hostRemoved', hostId: 'a' },
    ]);
    expect(fleet.hosts.map((h) => h.id)).toEqual(['b']);
    expect(fleet.states.a).toBeUndefined();
    expect(fleet.hostKeyRefusals.a).toBeUndefined();
  });

  it('clears a host key refusal once the host is reachable again', () => {
    const fleet = apply([
      { type: 'hostKeyRefused', hostId: 'a', reason: 'unknown', fingerprint: 'SHA256:y' },
      { type: 'hostStates', states: [{ ...createUnknownHostState('a'), status: 'offline' }] },
    ]);
    expect(fleet.hostKeyRefusals.a).toBeDefined();
    expect(
      reduceFleet(fleet, { type: 'hostStates', states: [polled('a', 5)] }).hostKeyRefusals.a,
    ).toBeUndefined();
  });

  it('clears config errors on a new hello (the server re-sends current ones)', () => {
    const fleet = apply([{ type: 'error', message: 'hosts.yaml has errors' }, hello('real')]);
    expect(fleet.lastError).toBeNull();
  });

  it('records host key refusals', () => {
    const fleet = apply([
      { type: 'hostKeyRefused', hostId: 'a', reason: 'unknown', fingerprint: 'SHA256:y' },
    ]);
    expect(fleet.hostKeyRefusals.a).toEqual({ reason: 'unknown', fingerprint: 'SHA256:y' });
  });
});
