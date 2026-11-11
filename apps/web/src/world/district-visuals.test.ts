import { describe, expect, it } from 'vitest';
import { districtTone } from './district-visuals';

describe('district plate tone', () => {
  const m = (status: 'online' | 'degraded' | 'offline' | 'unknown', stale = false) => ({
    status,
    stale,
  });

  it('asks for attention when anything inside is degraded or offline', () => {
    expect(districtTone([m('online'), m('degraded')])).toBe('attention');
    expect(districtTone([m('online'), m('offline')])).toBe('attention');
  });

  it('is online only with live online members', () => {
    expect(districtTone([m('online'), m('unknown')])).toBe('online');
    expect(districtTone([m('online', true)])).toBe('unknown');
    expect(districtTone([])).toBe('unknown');
  });
});
