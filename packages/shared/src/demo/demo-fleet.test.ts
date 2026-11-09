import { describe, expect, it } from 'vitest';
import { HostSchema } from '../host';
import { HostStateSchema, type HostState } from '../host-state';
import { DEFAULT_STATUS_THRESHOLDS } from '../thresholds';
import { createDemoFleet } from './demo-fleet';

const startedAt = 1_800_000_000_000;
const poll = DEFAULT_STATUS_THRESHOLDS.pollIntervalMs;

/** Runs `polls` ticks and returns the states of the last one, by host id. */
function runPolls(polls: number, hostCount?: number): Map<string, HostState> {
  const fleet = createDemoFleet({ seed: 1, startedAt, hostCount });
  let states: HostState[] = [];
  for (let index = 0; index < polls; index++) states = fleet.tick(startedAt + index * poll);
  return new Map(states.map((state) => [state.hostId, state]));
}

describe('createDemoFleet', () => {
  it('produces valid hosts and states', () => {
    const fleet = createDemoFleet({ seed: 1, startedAt });
    for (const host of fleet.hosts) expect(() => HostSchema.parse(host)).not.toThrow();
    for (const state of fleet.tick(startedAt))
      expect(() => HostStateSchema.parse(state)).not.toThrow();
  });

  it('is deterministic for a given seed', () => {
    expect(runPolls(5)).toEqual(runPolls(5));
  });

  it('reports CPU and network as unknown on the first poll (no delta yet)', () => {
    const state = runPolls(1).get('web-01');
    expect(state?.cpuPercent).toBeNull();
    expect(state?.network).toEqual([]);
    expect(state?.memory).not.toBeNull();
  });

  it('covers every truth state', () => {
    const states = runPolls(4);
    expect(states.get('web-01')?.status).toBe('online');
    expect(states.get('backup-store')?.status).toBe('degraded');
    expect(states.get('db-primary')?.status).toBe('degraded');
    expect(states.get('legacy-vps')?.status).toBe('offline');
    expect(states.get('legacy-vps')?.cpuPercent).toBeNull();
    expect(states.get('garage-pi')?.status).toBe('unknown');
    expect(states.get('lab-01')?.stale).toBe(true);
  });

  it('marks sustained CPU as degraded only after the required streak', () => {
    // Poll 1 has no CPU value, so the busy streak starts on poll 2.
    expect(runPolls(3).get('api-01')?.status).toBe('online');
    expect(runPolls(4).get('api-01')?.status).toBe('degraded');
  });

  it('lets the flapping host go offline but keeps its last-seen time', () => {
    const states = runPolls(12);
    const flapping = states.get('app-02');
    expect(flapping?.status).toBe('offline');
    expect(flapping?.lastSeenAt).not.toBeNull();
    expect(flapping?.memory).toBeNull();
  });

  it('generates extra steady hosts beyond the hand-written fleet', () => {
    const fleet = createDemoFleet({ seed: 1, startedAt, hostCount: 50 });
    expect(fleet.hosts).toHaveLength(50);
    expect(new Set(fleet.hosts.map((host) => host.id)).size).toBe(50);
  });
});
