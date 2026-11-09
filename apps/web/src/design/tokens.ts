import type { HostStatus } from '@app/shared';

/**
 * Design tokens: the single source for color, glow, motion timing and the
 * mapping ranges of every visual encoding.
 *
 * Palette DNA comes from the entrance of myselfraj.com (deep blue-black
 * void, cyan "city of light" glow, icy text). Rules:
 * - At most three accent colors. Everything else is a neutral.
 * - Every encoding here must be documented in docs/VISUAL_LANGUAGE.md.
 *   If it is not documented there, it should not exist.
 */

/** Dark neutrals, from deepest to lightest, plus text colors. */
export const neutrals = {
  /** Fog and far background. */
  void: '#020406',
  /** Page background and scene clear color. */
  base: '#050708',
  /** 2D panels (HUD, palette). */
  surface: '#0b1316',
  /** Floor grid lines and dark volumes. */
  grid: '#0b1f29',
  /** Hairlines and panel borders (cyan at 20%). */
  line: 'rgba(143, 227, 255, 0.2)',
  /** Unknown status, disabled text, frozen (stale) elements. */
  muted: '#4d5759',
  /** Primary text. */
  text: '#d8f3fb',
  /** Emphasized text and numbers. */
  textBright: '#eef9ff',
} as const;

/** The only three accent colors allowed in the product. */
export const accents = {
  /** Healthy, live. The signature cyan glow. */
  online: '#8fe3ff',
  /** Over a threshold; needs attention. */
  degraded: '#ffc22d',
  /** Errors and refusals (host key, failed connect). Used in 2D UI only. */
  alert: '#ff3b30',
} as const;

/**
 * Tower edge glow per status. `null` means no emissive light at all:
 * an offline server must never look operational.
 */
export const statusGlowColor: Record<HostStatus, string | null> = {
  online: accents.online,
  degraded: accents.degraded,
  unknown: neutrals.muted,
  offline: null,
};

/** Emissive intensities. Bloom picks up anything above ~1. */
export const glow = {
  towerEdge: 1.6,
  /** Unknown hosts get a faint outline so they read as "present but unmeasured". */
  towerEdgeUnknown: 0.35,
  memoryBandLit: 1.2,
  memoryBandUnlit: 0.08,
  diskRing: 1.0,
  particle: 1.4,
  districtLabel: 0.6,
} as const;

/** Data-to-visual mapping ranges. See docs/VISUAL_LANGUAGE.md. */
export const encoding = {
  /** CPU 0% -> slowest pulse, 100% -> fastest pulse (Hz, linear). */
  pulseHz: { atIdle: 0.2, atFull: 2.0 },
  /** Memory is shown as this many horizontal bands; lit = round(used/total * count). */
  memoryBandCount: 10,
  /** Network throughput (rx + tx) mapped on a log scale to particle rate. */
  networkBytesPerSec: { floor: 1024, ceiling: 100 * 1024 * 1024 },
  /** Particles per second at the network ceiling. */
  particlesPerSecMax: 24,
  /** Stale data is shown with this much color saturation (0..1) and no motion. */
  staleSaturation: 0.15,
} as const;

/** Durations in milliseconds. */
export const durations = {
  cameraFlyTo: 900,
  cameraReturn: 700,
  /** The jack-in dive must stay under 500 ms (and is skippable). */
  jackIn: 450,
  jackOut: 450,
  hudUnfold: 220,
  /** Upper bound for the intro; always skippable, auto-skipped after first visit. */
  introMax: 4000,
} as const;

/** Easing curves (GSAP names). */
export const easings = {
  cameraFlyTo: 'expo.inOut',
  jackIn: 'power4.in',
  jackOut: 'power3.out',
  hudUnfold: 'power3.out',
} as const;

/** Scene atmosphere. */
export const atmosphere = {
  fogColor: neutrals.void,
  fogNear: 40,
  fogFar: 220,
} as const;
