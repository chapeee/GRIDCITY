import {
  DEFAULT_STATUS_THRESHOLDS as thresholds,
  createUnknownHostState,
  type Host,
  type HostState,
  type ServerMessage,
} from '@app/shared';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCollectorOutput, type RawSample } from '../metrics/parse-collector-output';
import { openDatabase } from '../storage/database';
import { LayoutStore } from '../storage/layout-store';
import type { FleetListener, FleetProvider } from './fleet-provider';
import {
  applyPhaseChange,
  applyPollFailure,
  applyPollSuccess,
  buildHostState,
  createHostRuntime,
} from './host-runtime';
import { StateHub } from './state-hub';

const raw: RawSample = parseCollectorOutput(
  readFileSync(new URL('../metrics/fixtures/ubuntu-vm-synthetic.txt', import.meta.url), 'utf8'),
)!;
const later = (sample: RawSample, idleDelta: number, totalDelta: number): RawSample => ({
  ...sample,
  cpu: { idle: sample.cpu!.idle + idleDelta, total: sample.cpu!.total + totalDelta },
});

const connected = { phase: 'connected' as const, error: null, hostKeyRefusal: null };
const failed = (error: string) => ({ phase: 'failed' as const, error, hostKeyRefusal: null });

describe('host runtime → HostState', () => {
  it('is unknown before the first poll', () => {
    const state = buildHostState('h', createHostRuntime(), 0, thresholds);
    expect(state.status).toBe('unknown');
    expect(state.cpuPercent).toBeNull();
  });

  it('is online after a poll, with CPU unknown until the second poll', () => {
    let runtime = applyPhaseChange(createHostRuntime(), connected);
    runtime = applyPollSuccess(runtime, { collectedAt: 1000, raw }, thresholds);
    const first = buildHostState('h', runtime, 1000, thresholds);
    expect(first.status).toBe('online');
    expect(first.cpuPercent).toBeNull();
    expect(first.memory).not.toBeNull();

    runtime = applyPollSuccess(
      runtime,
      { collectedAt: 3000, raw: later(raw, 150, 200) },
      thresholds,
    );
    expect(buildHostState('h', runtime, 3000, thresholds).cpuPercent).toBe(25);
  });

  it('goes offline with unknown metrics when the connection fails, keeping last seen', () => {
    let runtime = applyPhaseChange(createHostRuntime(), connected);
    runtime = applyPollSuccess(runtime, { collectedAt: 1000, raw }, thresholds);
    runtime = applyPhaseChange(runtime, failed('heartbeat lost (keepalive timeout)'));
    const state = buildHostState('h', runtime, 2000, thresholds);
    expect(state).toMatchObject({
      status: 'offline',
      statusReason: 'heartbeat lost (keepalive timeout)',
      error: 'heartbeat lost (keepalive timeout)',
      lastSeenAt: 1000,
      memory: null,
      disks: [],
      stale: false,
    });
  });

  it('stays offline while reconnecting', () => {
    let runtime = applyPhaseChange(createHostRuntime(), failed('ECONNREFUSED'));
    runtime = applyPhaseChange(runtime, { phase: 'connecting', error: null, hostKeyRefusal: null });
    expect(buildHostState('h', runtime, 0, thresholds).status).toBe('offline');
  });

  it('goes stale when polls stop succeeding, keeping the last values', () => {
    let runtime = applyPhaseChange(createHostRuntime(), connected);
    runtime = applyPollSuccess(runtime, { collectedAt: 1000, raw }, thresholds);
    runtime = applyPollFailure(runtime, 'polling failed: command timed out after 6000 ms');
    const state = buildHostState(
      'h',
      runtime,
      1000 + 3 * thresholds.pollIntervalMs + 1,
      thresholds,
    );
    expect(state.stale).toBe(true);
    expect(state.status).toBe('online');
    expect(state.memory).not.toBeNull();
    expect(state.error).toMatch(/timed out/);
  });

  it('becomes degraded after sustained high CPU', () => {
    let runtime = applyPhaseChange(createHostRuntime(), connected);
    let sample = raw;
    runtime = applyPollSuccess(runtime, { collectedAt: 0, raw: sample }, thresholds);
    for (let poll = 1; poll <= 3; poll++) {
      sample = later(sample, 2, 100); // 98 % busy
      runtime = applyPollSuccess(runtime, { collectedAt: poll * 2000, raw: sample }, thresholds);
    }
    expect(buildHostState('h', runtime, 6000, thresholds)).toMatchObject({
      status: 'degraded',
      statusReason: 'CPU 98% for 3 polls',
    });
  });
});

/** A provider whose states the test controls. */
class FakeProvider implements FleetProvider {
  readonly dataMode = 'real' as const;
  readonly thresholds = thresholds;
  listener: FleetListener = () => {};
  states: HostState[];
  constructor(readonly hosts: Host[]) {
    this.states = hosts.map((h) => createUnknownHostState(h.id));
  }
  start(listener: FleetListener) {
    this.listener = listener;
  }
  stop() {}
  currentStates() {
    return this.states;
  }
}

const host = (id: string): Host => ({
  id,
  name: id,
  address: '10.0.0.1',
  port: 22,
  user: 'ops',
  district: 'lab',
  tags: [],
  auth: { method: 'agent' },
});

describe('StateHub', () => {
  afterEach(() => vi.useRealTimers());

  function setup() {
    const provider = new FakeProvider([host('a'), host('b')]);
    const hub = new StateHub({ provider, projectName: 'example', staleCheckIntervalMs: 60_000 });
    const received: ServerMessage[] = [];
    hub.start();
    hub.subscribe((message) => received.push(message));
    return { provider, hub, received };
  }

  it('sends hello and a snapshot with layout slots on subscribe', () => {
    const { received, hub } = setup();
    expect(received.map((m) => m.type)).toEqual(['hello', 'snapshot']);
    expect(received[0]).toMatchObject({
      dataMode: 'real',
      projectName: 'example',
      protocolVersion: 3,
    });
    expect(received[1]).toMatchObject({ layoutSlots: { a: 0, b: 1 } });
    hub.stop();
  });

  it('broadcasts only the hosts that changed', () => {
    const { provider, received, hub } = setup();
    provider.listener({ type: 'changed' }); // establishes the baseline
    received.length = 0;
    provider.states = [{ ...provider.states[0]!, status: 'online' }, provider.states[1]!];
    provider.listener({ type: 'changed' });
    provider.listener({ type: 'changed' }); // nothing new: nothing sent
    expect(received).toEqual([{ type: 'hostStates', states: [provider.states[0]] }]);
    hub.stop();
  });

  it('forwards host key refusals and replays them to new subscribers', () => {
    const { provider, received, hub } = setup();
    provider.listener({
      type: 'hostKeyRefused',
      hostId: 'a',
      reason: 'changed',
      fingerprint: 'SHA256:x',
    });
    expect(received.at(-1)).toEqual({
      type: 'hostKeyRefused',
      hostId: 'a',
      reason: 'changed',
      fingerprint: 'SHA256:x',
    });
    const late: ServerMessage[] = [];
    hub.subscribe((message) => late.push(message));
    expect(late.map((m) => m.type)).toEqual(['hello', 'snapshot', 'hostKeyRefused']);
    hub.stop();
  });

  it('keeps layout slots stable across restarts via the layout store', () => {
    const db = openDatabase(':memory:');
    const store = new LayoutStore(db);
    new StateHub({ provider: new FakeProvider([host('b')]), projectName: 'x', layoutStore: store });
    // 'a' appears later and sorts first, but 'b' keeps its slot.
    const hub = new StateHub({
      provider: new FakeProvider([host('a'), host('b')]),
      projectName: 'x',
      layoutStore: store,
    });
    const received: ServerMessage[] = [];
    hub.subscribe((m) => received.push(m));
    expect(received[1]).toMatchObject({ layoutSlots: { b: 0, a: 1 } });
    db.close();
  });

  it('re-checks staleness on a timer even without fleet events', () => {
    vi.useFakeTimers();
    const provider = new FakeProvider([host('a')]);
    const hub = new StateHub({ provider, projectName: 'x', staleCheckIntervalMs: 1000 });
    const received: ServerMessage[] = [];
    hub.start();
    hub.subscribe((m) => received.push(m));
    vi.advanceTimersByTime(1000); // baseline
    received.length = 0;
    provider.states = [{ ...provider.states[0]!, stale: true }];
    vi.advanceTimersByTime(1000);
    expect(received).toEqual([{ type: 'hostStates', states: provider.states }]);
    hub.stop();
  });
});
