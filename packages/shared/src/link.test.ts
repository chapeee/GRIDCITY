import { describe, expect, it } from 'vitest';
import { blastRadius, linkId, rootCauses, type Link } from './link';

const link = (from: string, to: string): Link => ({
  id: linkId(from, to),
  from,
  to,
  kind: 'declared',
  label: null,
  lastSeenAt: null,
});
const links = [
  link('probe', 'alb'),
  link('alb', 'web'),
  link('web', 'api'),
  link('api', 'db'),
  link('api', 'cache'),
  link('worker', 'db'),
];

describe('blast radius and root causes', () => {
  it('walks dependents backwards with their distance', () => {
    expect(blastRadius(links, 'db')).toEqual([
      { id: 'api', depth: 1 },
      { id: 'worker', depth: 1 },
      { id: 'web', depth: 2 },
      { id: 'alb', depth: 3 },
      { id: 'probe', depth: 4 },
    ]);
    expect(blastRadius(links, 'probe')).toEqual([]);
  });

  it('points at the most upstream failure and what it explains', () => {
    const failing = new Set(['probe', 'alb', 'web', 'api', 'db']);
    expect(rootCauses(links, failing)).toEqual([
      { id: 'db', explains: ['api', 'web', 'alb', 'probe'] },
    ]);
  });

  it('keeps independent failures apart', () => {
    expect(rootCauses(links, new Set(['cache', 'worker'])).map((r) => r.id)).toEqual([
      'cache',
      'worker',
    ]);
  });

  it('survives cycles', () => {
    const cyclic = [link('a', 'b'), link('b', 'a')];
    expect(blastRadius(cyclic, 'a')).toEqual([{ id: 'b', depth: 1 }]);
    expect(rootCauses(cyclic, new Set(['a', 'b']))).toEqual([]);
  });
});
