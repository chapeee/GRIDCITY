import { describe, expect, it } from 'vitest';
import {
  sortFindings,
  ThreatFindingSchema,
  worstOpenSeverity,
  type ThreatFinding,
} from './threats';

const finding = (over: Partial<ThreatFinding>): ThreatFinding => ({
  id: 'x',
  targetId: 'web-1',
  source: 'builtin',
  severity: 'medium',
  category: 'brute-force',
  title: 't',
  detail: 'd',
  advice: 'a',
  attackerIp: null,
  count: 1,
  firstSeen: 0,
  lastSeen: 0,
  blocked: null,
  status: 'open',
  resolvedAt: null,
  ...over,
});

describe('threat findings', () => {
  it('validates the wire shape', () => {
    expect(ThreatFindingSchema.parse(finding({}))).toMatchObject({ targetId: 'web-1' });
    expect(() => ThreatFindingSchema.parse({ ...finding({}), severity: 'urgent' })).toThrow();
  });

  it('takes the worst open severity per target and ignores resolved ones', () => {
    const worst = worstOpenSeverity([
      finding({ id: 'a', severity: 'medium' }),
      finding({ id: 'b', severity: 'critical', status: 'resolved' }),
      finding({ id: 'c', severity: 'high' }),
      finding({ id: 'd', targetId: 'db', severity: 'low' }),
    ]);
    expect(worst.get('web-1')).toBe('high');
    expect(worst.get('db')).toBe('low');
  });

  it('sorts open before resolved, then by severity, then newest', () => {
    const sorted = sortFindings([
      finding({ id: 'old-low', severity: 'low', lastSeen: 5 }),
      finding({ id: 'resolved', severity: 'critical', status: 'resolved' }),
      finding({ id: 'new-high', severity: 'high', lastSeen: 9 }),
      finding({ id: 'old-high', severity: 'high', lastSeen: 1 }),
    ]);
    expect(sorted.map((f) => f.id)).toEqual(['new-high', 'old-high', 'old-low', 'resolved']);
  });
});
