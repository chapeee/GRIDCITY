import { create } from 'zustand';
import { postProcessing } from '../design/tokens';

/** Live-tunable rendering values. Production always uses the token values. */
export interface WorldTuning {
  /** Multiplies every emissive intensity (edges, bands, rings, particles). */
  glowScale: number;
  bloomIntensity: number;
  bloomThreshold: number;
}

export const TOKEN_TUNING: WorldTuning = {
  glowScale: 1,
  bloomIntensity: postProcessing.bloomIntensity,
  bloomThreshold: postProcessing.bloomThreshold,
};

/**
 * Current tuning. Only the dev tuning panel (DevTuningPanel, loaded lazily in
 * development) ever writes to it, so production renders the token values and
 * never bundles the tuning UI. Copy values you like back into tokens.ts.
 */
export const useWorldTuning = create<WorldTuning>()(() => TOKEN_TUNING);
