import { describe, expect, it } from 'vitest';
import { createDemoReplayFrame, replayHostState, replayResourceState } from './replay';

describe('time travel frames', () => {
  it('shows an unmeasured host as unknown, never healthy', () => {
    const state = replayHostState('web', undefined, 1000);
    expect(state).toMatchObject({
      status: 'unknown',
      cpuPercent: null,
      memory: null,
      lastSeenAt: null,
    });
  });

  it('turns recorded percentages into ratios the city can draw', () => {
    const state = replayHostState(
      'web',
      {
        status: 'degraded',
        reason: 'CPU 97%',
        cpuPercent: 97,
        memoryPercent: 40,
        maxDiskPercent: 91,
        networkBytesPerSec: 2000,
        loadOne: 3.9,
      },
      5000,
    );
    expect(state).toMatchObject({
      status: 'degraded',
      lastSeenAt: 5000,
      cpuPercent: 97,
      memory: { usedBytes: 40, totalBytes: 100 },
      disks: [{ mount: 'fullest disk', usedBytes: 91, totalBytes: 100 }],
    });
    expect(state.network[0]!.rxBytesPerSec + state.network[0]!.txBytesPerSec).toBe(2000);
  });

  it('drops every metric of an offline moment', () => {
    const state = replayHostState(
      'web',
      {
        status: 'offline',
        reason: 'heartbeat lost',
        cpuPercent: 10,
        memoryPercent: 10,
        maxDiskPercent: 10,
        networkBytesPerSec: 10,
        loadOne: 1,
      },
      5000,
    );
    expect(state).toMatchObject({
      cpuPercent: null,
      memory: null,
      disks: [],
      network: [],
      lastSeenAt: null,
    });
    expect(replayResourceState('db', undefined, 1).status).toBe('unknown');
  });

  it('generates demo frames that agree with the demo incidents', () => {
    const now = Date.UTC(2026, 10, 11, 12);
    const frame = createDemoReplayFrame(['a', 'b'], ['db'], now - 3_600_000, now);
    expect(Object.keys(frame.hosts)).toEqual(['a', 'b']);
    expect(frame.resources.db).toBeDefined();
    expect(createDemoReplayFrame(['a'], [], now - 3_600_000, now)).toEqual(
      createDemoReplayFrame(['a'], [], now - 3_600_000, now),
    );
  });
});
