import { HostStatusSchema } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { accents, durations, statusGlowColor } from './tokens';

describe('design tokens', () => {
  it('defines at most three accent colors', () => {
    expect(Object.keys(accents).length).toBeLessThanOrEqual(3);
  });

  it('maps every host status to a glow', () => {
    for (const status of HostStatusSchema.options) {
      expect(statusGlowColor).toHaveProperty(status);
    }
  });

  it('never gives an offline host emissive light', () => {
    expect(statusGlowColor.offline).toBeNull();
  });

  it('keeps the jack-in dive under 500 ms', () => {
    expect(durations.jackIn).toBeLessThan(500);
    expect(durations.jackOut).toBeLessThan(500);
  });
});
