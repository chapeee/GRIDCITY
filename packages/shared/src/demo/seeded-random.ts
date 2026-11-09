/**
 * Small deterministic PRNG (mulberry32). Demo data must be reproducible so
 * screenshots and visual reviews show the same city every time.
 */
export interface SeededRandom {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform float in [min, max). */
  between(min: number, max: number): number;
  /** Roughly normal noise with mean 0 and the given spread (sum of uniforms). */
  noise(spread: number): number;
}

export function createSeededRandom(seed: number): SeededRandom {
  let state = seed >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    between: (min, max) => min + (max - min) * next(),
    noise: (spread) => ((next() + next() + next()) / 3 - 0.5) * 2 * spread,
  };
}
