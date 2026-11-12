import { describe, expect, it } from 'vitest';
import { shortLabel } from './WorldLabels';

describe('building labels', () => {
  it('keeps short names and shortens long ones in the middle', () => {
    expect(shortLabel('orders-db')).toBe('orders-db');
    expect(shortLabel('exactly-16-char')).toBe('exactly-16-char');
    const short = shortLabel('media-1794434186338');
    expect(short).toBe('media-1794…86338');
    expect(short).toHaveLength(16);
  });
});
