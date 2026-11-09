import { describe, expect, it } from 'vitest';
import { parseDemoOptions, DEFAULT_DEMO_OPTIONS } from '../data/demo-options';
import {
  formatBytes,
  formatDurationShort,
  formatLastSeen,
  formatPercent,
  formatRate,
  formatUptime,
  UNKNOWN,
} from './format';

describe('formatters', () => {
  it('render unknown values as a dash, never as zero', () => {
    expect(formatBytes(null)).toBe(UNKNOWN);
    expect(formatRate(null)).toBe(UNKNOWN);
    expect(formatPercent(null)).toBe(UNKNOWN);
    expect(formatUptime(null)).toBe(UNKNOWN);
  });

  it('format bytes in binary units', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(250 * 1024 ** 3)).toBe('250 GiB');
  });

  it('format durations compactly', () => {
    expect(formatDurationShort(45_000)).toBe('45s');
    expect(formatDurationShort(12 * 60_000)).toBe('12m');
    expect(formatDurationShort(5 * 3_600_000)).toBe('5h');
    expect(formatDurationShort(72 * 3_600_000)).toBe('3d');
  });

  it('format uptime and last seen', () => {
    expect(formatUptime(12 * 86_400 + 4 * 3600)).toBe('12d 4h');
    expect(formatLastSeen(1000, 46_000)).toBe('last seen 45s ago');
    expect(formatLastSeen(null, 0)).toBe('never seen');
  });
});

describe('parseDemoOptions', () => {
  it('uses defaults without parameters', () => {
    expect(parseDemoOptions('')).toEqual(DEFAULT_DEMO_OPTIONS);
  });

  it('reads valid parameters', () => {
    expect(parseDemoOptions('?hosts=50&seed=3&poll=500')).toEqual({
      hostCount: 50,
      seed: 3,
      pollIntervalMs: 500,
    });
  });

  it('ignores invalid or out-of-range values', () => {
    expect(parseDemoOptions('?hosts=9999&poll=abc&seed=-1')).toEqual(DEFAULT_DEMO_OPTIONS);
  });
});
