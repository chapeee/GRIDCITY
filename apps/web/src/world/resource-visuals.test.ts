import {
  createUnknownResourceState,
  EMPTY_GAUGES,
  type Resource,
  type ResourceState,
} from '@app/shared';
import { describe, expect, it } from 'vitest';
import { encoding, glow, statusGlowColor } from '../design/tokens';
import {
  bytesToRoofCells,
  computeResourceVisual,
  growthToParticleRate,
  opsToPulseHz,
} from './resource-visuals';

const resource = (kind: Resource['kind']): Resource => ({
  id: 'r',
  name: 'r',
  kind,
  engine: 'Engine',
  district: 'Databases',
  tags: [],
  target: 'x',
  sourceId: 'r',
});
const NOW = 1_000_000;
const live = (overrides: Partial<ResourceState> = {}): ResourceState => ({
  ...createUnknownResourceState('r', 10_000),
  status: 'online',
  statusReason: 'ok',
  lastSeenAt: NOW,
  ...overrides,
});

describe('resource visuals', () => {
  it('offline is dark and still; unknown is a faint outline', () => {
    const offline = computeResourceVisual(resource('postgres'), live({ status: 'offline' }), NOW);
    expect(offline).toMatchObject({
      glowColor: null,
      pulseHz: 0,
      memoryLitBands: null,
      particlesPerSecond: 0,
      frozen: true,
    });
    const unknown = computeResourceVisual(resource('postgres'), undefined, NOW);
    expect(unknown).toMatchObject({
      glowColor: statusGlowColor.unknown,
      glowIntensity: glow.towerEdgeUnknown,
    });
  });

  it('drums pulse with ops/s and light one disc per third of connections', () => {
    const visual = computeResourceVisual(
      resource('postgres'),
      live({ gauges: { ...EMPTY_GAUGES, opsPerSec: 100, connections: { used: 70, max: 100 } } }),
      NOW,
    );
    expect(visual.pulseHz).toBeCloseTo(opsToPulseHz(100));
    expect(visual.memoryLitBands).toBe(2);
    expect(visual.caption).toBe('Engine');
  });

  it('RDS pulses with CPU, draws no bands without a max, rings allocated storage', () => {
    const visual = computeResourceVisual(
      resource('rds'),
      live({
        gauges: {
          ...EMPTY_GAUGES,
          cpuPercent: 100,
          connections: { used: 9, max: null },
          storage: { usedBytes: 50, totalBytes: 100 },
        },
      }),
      NOW,
    );
    expect(visual.pulseHz).toBe(encoding.pulseHz.atFull);
    expect(visual.memoryLitBands).toBeNull();
    expect(visual.diskArcs).toEqual([{ fillRatio: 0.5, overThreshold: false }]);
  });

  it('buckets: roof cells for size, particles only for growth, never a pulse', () => {
    const visual = computeResourceVisual(
      resource('s3'),
      live({
        gauges: {
          ...EMPTY_GAUGES,
          storage: { usedBytes: 1024 ** 4, totalBytes: null },
          growthBytesPerHour: 1024 ** 3,
        },
      }),
      NOW,
    );
    expect(visual.pulseHz).toBe(0);
    expect(visual.memoryLitBands).toBe(bytesToRoofCells(1024 ** 4));
    expect(visual.particlesPerSecond).toBeGreaterThan(0);
    expect(growthToParticleRate(-5)).toBe(0);
    expect(bytesToRoofCells(null)).toBeNull();
  });

  it('stale (3 missed polls on the client clock) desaturates and freezes', () => {
    const visual = computeResourceVisual(
      resource('redis'),
      live({ lastSeenAt: NOW - 31_000, gauges: { ...EMPTY_GAUGES, opsPerSec: 500 } }),
      NOW,
    );
    expect(visual).toMatchObject({
      frozen: true,
      pulseHz: 0,
      saturation: encoding.staleSaturation,
      labelTone: 'dim',
    });
  });

  it('marks the storage arc degraded only when the server storage rule fired', () => {
    const visual = computeResourceVisual(
      resource('redis'),
      live({
        status: 'degraded',
        statusReason: 'storage 95%',
        gauges: { ...EMPTY_GAUGES, storage: { usedBytes: 95, totalBytes: 100 } },
      }),
      NOW,
    );
    expect(visual.diskArcs[0]?.overThreshold).toBe(true);
  });
});
