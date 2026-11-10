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
    const state = runPolls(1).get('ausia-web');
    expect(state?.cpuPercent).toBeNull();
    expect(state?.network).toEqual([]);
    expect(state?.memory).not.toBeNull();
  });

  it('covers every truth state', () => {
    const states = runPolls(4);
    expect(states.get('ausia-web')?.status).toBe('online');
    expect(states.get('lekhix-backups')?.status).toBe('degraded');
    expect(states.get('lekhix-db')?.status).toBe('degraded');
    expect(states.get('bugspoon-legacy')?.status).toBe('offline');
    expect(states.get('bugspoon-legacy')?.cpuPercent).toBeNull();
    expect(states.get('garage-pi')?.status).toBe('unknown');
    expect(states.get('gridcity-lab')?.stale).toBe(true);
  });

  it('marks sustained CPU as degraded only after the required streak', () => {
    // Poll 1 has no CPU value, so the busy streak starts on poll 2.
    expect(runPolls(3).get('lekhix-api')?.status).toBe('online');
    expect(runPolls(4).get('lekhix-api')?.status).toBe('degraded');
  });

  it('lets the flapping host go offline but keeps its last-seen time', () => {
    const states = runPolls(12);
    const flapping = states.get('skillgen-app');
    expect(flapping?.status).toBe('offline');
    expect(flapping?.lastSeenAt).not.toBeNull();
    expect(flapping?.memory).toBeNull();
  });

  describe('incidents on steady hosts', () => {
    /** Runs `polls` ticks, calling `each` with every poll's states and active incidents. */
    function play(
      polls: number,
      each: (states: Map<string, HostState>, incidents: { hostId: string; kind: string }[]) => void,
    ): void {
      const fleet = createDemoFleet({ seed: 1, startedAt });
      for (let index = 0; index < polls; index++) {
        const states = fleet.tick(startedAt + index * poll);
        each(new Map(states.map((s) => [s.hostId, s])), fleet.activeIncidents());
      }
    }

    it('stays calm at the start, then plays every kind, at most two at once', () => {
      const kinds = new Set<string>();
      let poll = 0;
      play(1500, (_states, incidents) => {
        poll += 1;
        if (poll <= 15) expect(incidents).toEqual([]);
        expect(incidents.length).toBeLessThanOrEqual(2);
        for (const incident of incidents) kinds.add(incident.kind);
      });
      expect([...kinds].sort()).toEqual(['cpu-spike', 'memory-leak', 'reboot', 'traffic-surge']);
    });

    it('a busy job turns a steady host degraded, and it recovers afterwards', () => {
      const seen = new Map<string, string[]>();
      play(1500, (states, incidents) => {
        for (const { hostId, kind } of incidents) {
          if (kind !== 'cpu-spike') continue;
          seen.set(hostId, [...(seen.get(hostId) ?? []), states.get(hostId)?.status ?? '']);
        }
      });
      expect(seen.size).toBeGreaterThan(0);
      for (const statuses of seen.values()) expect(statuses).toContain('degraded');
    });

    it('a reboot goes offline, then comes back with fresh uptime and unknown rates', () => {
      let rebooting: string | null = null;
      let checked = false;
      play(1500, (states, incidents) => {
        if (checked) return;
        const reboot = incidents.find((incident) => incident.kind === 'reboot');
        if (reboot) {
          rebooting = reboot.hostId;
          const state = states.get(reboot.hostId);
          expect(state?.status).toBe('offline');
          expect(state?.error).toMatch(/rebooting/);
          expect(state?.lastSeenAt).not.toBeNull();
        } else if (rebooting && states.get(rebooting)?.status !== 'offline') {
          // (The poll that ends the reboot is still offline; the next one reconnects.)
          const state = states.get(rebooting);
          expect(state?.status).toBe('online');
          expect(state?.cpuPercent).toBeNull();
          expect(state?.uptimeSeconds).toBeLessThan(5);
          checked = true;
        }
      });
      expect(checked).toBe(true);
    });
  });

  it('generates extra steady hosts beyond the hand-written fleet', () => {
    const fleet = createDemoFleet({ seed: 1, startedAt, hostCount: 50 });
    expect(fleet.hosts).toHaveLength(50);
    expect(new Set(fleet.hosts.map((host) => host.id)).size).toBe(50);
  });
});
