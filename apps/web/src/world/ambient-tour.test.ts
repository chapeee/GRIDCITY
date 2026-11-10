import { createUnknownHostState, DEFAULT_STATUS_THRESHOLDS, type HostState } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { hostsNeedingAttention, nextAmbientTarget } from './ambient-tour';

const now = 1_800_000_000_000;
const live: HostState = {
  ...createUnknownHostState('x'),
  status: 'online',
  statusReason: 'ok',
  lastSeenAt: now - 1000,
  cpuPercent: 10,
};

describe('hostsNeedingAttention', () => {
  it('picks offline, degraded and stale hosts in navigation order, never healthy ones', () => {
    const states: Record<string, HostState | undefined> = {
      healthy: live,
      down: { ...live, status: 'offline' },
      busy: { ...live, status: 'degraded', statusReason: 'disk / 95%' },
      frozen: { ...live, lastSeenAt: now - 60_000 },
      waiting: undefined, // unknown: not yet measured, not a problem
    };
    expect(
      hostsNeedingAttention(
        ['healthy', 'frozen', 'down', 'waiting', 'busy'],
        states,
        now,
        DEFAULT_STATUS_THRESHOLDS,
      ),
    ).toEqual(['frozen', 'down', 'busy']);
  });
});

describe('nextAmbientTarget', () => {
  it('cycles through candidates and wraps around', () => {
    expect(nextAmbientTarget(['a', 'b'], null)).toBe('a');
    expect(nextAmbientTarget(['a', 'b'], 'a')).toBe('b');
    expect(nextAmbientTarget(['a', 'b'], 'b')).toBe('a');
  });

  it('starts over when the current host recovered (no longer a candidate)', () => {
    expect(nextAmbientTarget(['a', 'b'], 'gone')).toBe('a');
  });

  it('returns null when everything is healthy', () => {
    expect(nextAmbientTarget([], 'a')).toBeNull();
  });
});
