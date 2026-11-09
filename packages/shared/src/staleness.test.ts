import { describe, expect, it } from 'vitest';
import { isStale } from './staleness';

const thresholds = { pollIntervalMs: 2000, staleAfterPolls: 3 };
const now = 1_000_000;

describe('isStale', () => {
  it('treats never-polled hosts as unknown, not stale', () => {
    expect(isStale(null, now, thresholds)).toBe(false);
  });

  it('is fresh at exactly the stale window', () => {
    expect(isStale(now - 6000, now, thresholds)).toBe(false);
  });

  it('is stale just past the stale window (3 x poll interval)', () => {
    expect(isStale(now - 6001, now, thresholds)).toBe(true);
  });

  it('follows a custom poll interval', () => {
    expect(isStale(now - 4000, now, { pollIntervalMs: 1000, staleAfterPolls: 3 })).toBe(true);
  });
});
