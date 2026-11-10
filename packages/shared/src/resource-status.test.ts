import { describe, expect, it } from 'vitest';
import { createDemoResources } from './demo/demo-resources';
import { DEFAULT_RESOURCE_THRESHOLDS, EMPTY_GAUGES, ResourceStateSchema } from './resource';
import {
  computeResourceStatus,
  nextResourceStreaks,
  type ResourceHealthSample,
} from './resource-status';

const sample = (overrides: Partial<ResourceHealthSample> = {}): ResourceHealthSample => ({
  gauges: EMPTY_GAUGES,
  replicationLagSeconds: null,
  slowQueries: null,
  cacheHitPercent: null,
  warnings: [],
  ...overrides,
});
const t = DEFAULT_RESOURCE_THRESHOLDS;
const noStreaks = { slowQueries: 0, cpu: 0 };

describe('resource status rules', () => {
  it('orders offline, unknown, degraded, online', () => {
    expect(
      computeResourceStatus(
        {
          failed: true,
          failureReason: 'refused',
          hasPolled: true,
          sample: sample(),
          streaks: noStreaks,
        },
        t,
      ),
    ).toEqual({ status: 'offline', reason: 'refused' });
    expect(
      computeResourceStatus(
        { failed: false, hasPolled: false, sample: null, streaks: noStreaks },
        t,
      ).status,
    ).toBe('unknown');
    expect(
      computeResourceStatus(
        { failed: false, hasPolled: true, sample: sample(), streaks: noStreaks },
        t,
      ).status,
    ).toBe('online');
  });

  it('flags lag, cache hit, storage and warnings', () => {
    const result = computeResourceStatus(
      {
        failed: false,
        hasPolled: true,
        sample: sample({
          replicationLagSeconds: 45,
          cacheHitPercent: 70,
          gauges: { ...EMPTY_GAUGES, storage: { usedBytes: 95, totalBytes: 100 } },
          warnings: ['replica link down'],
        }),
        streaks: noStreaks,
      },
      t,
    );
    expect(result).toEqual({
      status: 'degraded',
      reason: 'replica link down, replica 45s behind, cache hit 70%, storage 95%',
    });
  });

  it('needs slow queries and high CPU for several polls in a row', () => {
    let streaks = noStreaks;
    const busy = sample({ slowQueries: 2, gauges: { ...EMPTY_GAUGES, cpuPercent: 97 } });
    for (let i = 0; i < 2; i++) streaks = nextResourceStreaks(streaks, busy, t);
    expect(
      computeResourceStatus({ failed: false, hasPolled: true, sample: busy, streaks }, t).status,
    ).toBe('online');
    streaks = nextResourceStreaks(streaks, busy, t);
    expect(
      computeResourceStatus({ failed: false, hasPolled: true, sample: busy, streaks }, t).reason,
    ).toBe('2 slow queries, CPU 97% for 3 polls');
    expect(nextResourceStreaks(streaks, sample({ slowQueries: 0 }), t)).toEqual(noStreaks);
  });
});

describe('demo resources', () => {
  it('produce valid states that cover every truth state', () => {
    const demo = createDemoResources({ startedAt: 0 });
    let states = demo.tick(0);
    expect(states.every((s) => s.status === 'unknown')).toBe(true);
    for (let now = 2000; now <= 60_000; now += 1000) states = demo.tick(now);
    for (const state of states) ResourceStateSchema.parse(state);
    const byId = new Map(states.map((s) => [s.resourceId, s]));
    expect(byId.get('session-cache')?.status).toBe('offline');
    expect(byId.get('orders-replica')?.status).toBe('degraded');
    expect(byId.get('reports-rds')?.stale).toBe(true);
    expect(byId.get('orders-db')?.status).toBe('online');
    expect(new Set(demo.resources.map((r) => r.kind))).toEqual(
      new Set(['postgres', 'mysql', 'mongodb', 'redis', 'rds', 's3']),
    );
  });
});
