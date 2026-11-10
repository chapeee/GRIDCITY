import { describe, expect, it } from 'vitest';
import { createDemoHistory } from './demo/demo-history';
import { HistoryResponseSchema, incidentTotals } from './history';

describe('history helpers', () => {
  it('totals incident time clipped to the window, ongoing ones up to now', () => {
    const totals = incidentTotals(
      [
        { targetId: 'a', status: 'degraded', reason: null, startedAt: 0, endedAt: 100 },
        { targetId: 'a', status: 'offline', reason: null, startedAt: 150, endedAt: null },
      ],
      50,
      200,
    );
    expect(totals).toEqual({ degraded: 50, offline: 50 });
  });

  it('demo history is valid, deterministic and has gaps while offline', () => {
    const now = Date.UTC(2026, 10, 10);
    const first = createDemoHistory(['web', 'db'], 'web', now, 7);
    expect(HistoryResponseSchema.parse(first)).toBeTruthy();
    expect(createDemoHistory(['web', 'db'], 'web', now, 7)).toEqual(first);
    expect(first.points.length).toBeGreaterThan(100);
    expect(first.points.length).toBeLessThanOrEqual(1100);
    const fleet = createDemoHistory(['web', 'db', 'cache', 'api'], null, now, 7);
    expect(fleet.points).toEqual([]);
    for (const incident of fleet.incidents)
      expect(incident.startedAt).toBeGreaterThanOrEqual(fleet.since);
  });
});
