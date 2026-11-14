import { describe, expect, it } from 'vitest';
import { metric } from '../connectors/connector';
import { formatMetric } from './fleet-tools';

describe('metrics as the AI reads them', () => {
  it('shows sizes the way the app does, not raw byte counts', () => {
    expect(formatMetric(metric('allocated', 'Allocated storage', 'bytes', 20 * 1024 ** 3))).toBe(
      '20 GiB',
    );
    expect(formatMetric(metric('size', 'Size', 'bytes', 15_007))).toBe('14.7 KiB');
    expect(formatMetric(metric('size', 'Size', 'bytes', 9))).toBe('9 B');
    expect(formatMetric(metric('objects', 'Size', 'bytes', 1024 ** 2, true))).toBe('≥ 1 MiB');
    expect(formatMetric(metric('growth', 'Growth', 'bytesPerHour', 2048))).toBe('+2 KiB/h');
    expect(formatMetric(metric('growth', 'Growth', 'bytesPerHour', -2048))).toBe('-2 KiB/h');
    expect(formatMetric(metric('latency', 'Round trip', 'ms', 10.456))).toBe('10.46 ms');
    expect(formatMetric(metric('cpu', 'CPU', 'percent', null))).toBe('unknown');
  });
});
