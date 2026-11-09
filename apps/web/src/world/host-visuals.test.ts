import { createUnknownHostState, DEFAULT_STATUS_THRESHOLDS, type HostState } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { accents, encoding, glow, statusGlowColor } from '../design/tokens';
import {
  computeHostVisual,
  cpuToPulseHz,
  disksToArcs,
  memoryToLitBands,
  networkToParticleRate,
} from './host-visuals';

const now = 1_800_000_000_000;
const thresholds = DEFAULT_STATUS_THRESHOLDS;
const GiB = 1024 ** 3;

const online: HostState = {
  ...createUnknownHostState('web-01'),
  status: 'online',
  statusReason: 'all metrics within thresholds',
  lastSeenAt: now - 1000,
  cpuPercent: 50,
  memory: { usedBytes: 8 * GiB, totalBytes: 16 * GiB },
  disks: [{ mount: '/', usedBytes: 40 * GiB, totalBytes: 100 * GiB }],
  network: [{ iface: 'eth0', rxBytesPerSec: 1e6, txBytesPerSec: 1e6 }],
};

describe('computeHostVisual truth states', () => {
  it('gives an offline host no light and no motion at all', () => {
    const visual = computeHostVisual({ ...online, status: 'offline' }, now, thresholds);
    expect(visual).toMatchObject({
      glowColor: null,
      glowIntensity: 0,
      pulseHz: 0,
      memoryLitBands: null,
      diskArcs: [],
      particlesPerSecond: 0,
      frozen: true,
    });
    expect(visual.caption).toMatch(/^offline · last seen/);
  });

  it('shows an unknown host as a faint neutral outline only', () => {
    const visual = computeHostVisual(createUnknownHostState('x'), now, thresholds);
    expect(visual.glowColor).toBe(statusGlowColor.unknown);
    expect(visual.glowIntensity).toBe(glow.towerEdgeUnknown);
    expect(visual.pulseHz).toBe(0);
    expect(visual.memoryLitBands).toBeNull();
    expect(visual.particlesPerSecond).toBe(0);
  });

  it('treats a missing state as unknown', () => {
    expect(computeHostVisual(undefined, now, thresholds).caption).toBe('waiting for first poll');
  });

  it('freezes and desaturates stale data, keeping last known values', () => {
    const visual = computeHostVisual({ ...online, lastSeenAt: now - 7000 }, now, thresholds);
    expect(visual.frozen).toBe(true);
    expect(visual.pulseHz).toBe(0);
    expect(visual.saturation).toBe(encoding.staleSaturation);
    expect(visual.brightness).toBe(encoding.staleBrightness);
    expect(visual.glowIntensity).toBeLessThan(glow.towerEdge);
    expect(visual.memoryLitBands).toBe(5);
    expect(visual.caption).toBe('last seen 7s ago');
    expect(visual.labelTone).toBe('dim');
  });

  it('detects staleness on the client clock even if the server flag is false', () => {
    const visual = computeHostVisual(
      { ...online, stale: false, lastSeenAt: now - 60_000 },
      now,
      thresholds,
    );
    expect(visual.frozen).toBe(true);
  });

  it('lights a healthy host in the online accent with live motion', () => {
    const visual = computeHostVisual(online, now, thresholds);
    expect(visual.glowColor).toBe(accents.online);
    expect(visual.frozen).toBe(false);
    expect(visual.pulseHz).toBeGreaterThan(0);
    expect(visual.caption).toBeNull();
  });

  it('uses the degraded accent and shows the reason', () => {
    const visual = computeHostVisual(
      { ...online, status: 'degraded', statusReason: 'disk / 95%' },
      now,
      thresholds,
    );
    expect(visual.glowColor).toBe(accents.degraded);
    expect(visual.caption).toBe('disk / 95%');
    expect(visual.labelTone).toBe('warning');
  });
});

describe('encoding functions', () => {
  it('maps CPU linearly to pulse frequency', () => {
    expect(cpuToPulseHz(0)).toBe(encoding.pulseHz.atIdle);
    expect(cpuToPulseHz(100)).toBe(encoding.pulseHz.atFull);
    expect(cpuToPulseHz(null)).toBe(0);
  });

  it('rounds memory to bands and keeps unknown as null', () => {
    expect(memoryToLitBands({ usedBytes: 0, totalBytes: 10 })).toBe(0);
    expect(memoryToLitBands({ usedBytes: 46, totalBytes: 100 })).toBe(5);
    expect(memoryToLitBands({ usedBytes: 10, totalBytes: 10 })).toBe(10);
    expect(memoryToLitBands(null)).toBeNull();
  });

  it('keeps the fullest disks, ordered by mount, flagging those over threshold', () => {
    const disks = ['/a', '/b', '/c', '/d', '/e'].map((mount, index) => ({
      mount,
      usedBytes: [10, 95, 50, 20, 70][index] ?? 0,
      totalBytes: 100,
    }));
    expect(disksToArcs(disks, 90)).toEqual([
      { fillRatio: 0.95, overThreshold: true }, // /b
      { fillRatio: 0.5, overThreshold: false }, // /c
      { fillRatio: 0.2, overThreshold: false }, // /d
      { fillRatio: 0.7, overThreshold: false }, // /e
    ]);
  });

  it('maps network throughput on a log scale with a floor and a ceiling', () => {
    const rate = (bytes: number) =>
      networkToParticleRate([{ iface: 'e', rxBytesPerSec: bytes, txBytesPerSec: 0 }]);
    expect(rate(500)).toBe(0);
    expect(rate(1e12)).toBe(encoding.particlesPerSecMax);
    expect(rate(1e6)).toBeGreaterThan(rate(1e4));
    expect(networkToParticleRate([])).toBe(0);
  });
});
