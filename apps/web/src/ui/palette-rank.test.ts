import { describe, expect, it } from 'vitest';
import { rankSections } from './palette-rank';

const sections = [
  {
    key: 'hosts',
    entries: [
      { value: 'host skillgen-redis DigitalOcean 198.51.100.30 demo cache' },
      { value: 'host gitsmith-docs Hetzner 10.40.0.11 demo web' },
    ],
  },
  {
    key: 'resources',
    entries: [
      { value: 'session-cache Redis', keywords: ['redis', 'DigitalOcean'] },
      { value: 'orders-db PostgreSQL', keywords: ['postgres', 'AWS Mumbai'] },
    ],
  },
  {
    key: 'actions',
    entries: [
      { value: 'settings preferences history retention thresholds warnings' },
      { value: 'open audit log' },
      { value: 'toggle lite mode' },
    ],
  },
];

const first = (search: string) => rankSections(sections, search)[0]?.entries[0]?.value;

describe('rankSections', () => {
  it('returns everything unchanged without a search', () => {
    expect(rankSections(sections, '  ')).toBe(sections);
  });

  it('puts an exact match first even when it is not in the first section', () => {
    expect(first('session-cache')).toBe('session-cache Redis');
    expect(first('settings')).toMatch(/^settings/);
    expect(first('open audit log')).toBe('open audit log');
    expect(first('lite mode')).toBe('toggle lite mode');
  });

  it('drops entries and sections that do not match', () => {
    const ranked = rankSections(sections, 'orders-db');
    expect(ranked.map((section) => section.key)).toEqual(['resources']);
    expect(ranked[0]?.entries).toHaveLength(1);
  });

  it('matches keywords', () => {
    expect(first('AWS Mumbai')).toBe('orders-db PostgreSQL');
  });

  it('keeps the original order on ties', () => {
    const tied = rankSections(sections, 'x', () => 1);
    expect(tied.map((section) => section.key)).toEqual(['hosts', 'resources', 'actions']);
  });
});
