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
  /** Every fourth floor grid line (aligned with tower slots). */
  gridSection: '#123544',
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
  /** Errors and refusals (host key, failed connect) in 2D UI; in 3D only the attack ring (AttackRings). */
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
  /** How long one particle takes to rise, in seconds. */
  particleLifetimeSec: 2.6,
  /** At most this many disk arcs per ring; the fullest disks win. */
  diskArcMax: 4,
  /** Stale data is shown with this much color saturation (0..1) and no motion. */
  staleSaturation: 0.15,
  /** Stale data also dims to this brightness (0..1), so frozen never reads as "hot". */
  staleBrightness: 0.45,
  /** Resources: queries/ops per second on a log scale to the same pulse range. */
  opsPerSec: { floor: 1, ceiling: 10_000 },
  /** Lit bands for connections: drums have 3 discs, prisms 6 bands. */
  connectionBands: { drum: 3, prism: 6 },
  /** Bucket roof cells lit = stored bytes on a log scale (1 KiB .. 10 TiB). */
  roofCells: 10,
  bucketBytes: { floor: 1024, ceiling: 10 * 1024 ** 4 },
  /** Bucket growth (bytes/hour, positive only) on a log scale to particle rate. */
  growthBytesPerHour: { floor: 1024 ** 2, ceiling: 100 * 1024 ** 3 },
  /** Probe latency (ms) on a log scale to the pulse range: a slow endpoint pulses fast. */
  latencyMs: { floor: 20, ceiling: 3000 },
} as const;

/**
 * Fixed shapes for resources, in world units (see docs/VISUAL_LANGUAGE.md).
 * Like towers, their geometry never changes with data.
 */
export const resourceGeometry = {
  drum: { radius: 1.25, discHeight: 1.1, discGap: 0.35, discs: 3 },
  prism: { radius: 1.2, height: 4.2 },
  /** RDS: a drum (4 discs) inside a thin static cage marking "managed". */
  cagedDrum: {
    radius: 1.15,
    discHeight: 1.05,
    discGap: 0.3,
    discs: 4,
    cageWidth: 3.0,
    cageHeight: 6.4,
  },
  warehouse: { width: 4.4, depth: 3.2, height: 1.6, roofColumns: 5, roofRows: 2 },
  /** Probes (HTTP, TCP): a thin spire, taller than a tower, watching from the edge. */
  beacon: { width: 0.8, height: 10.5 },
  /** Load balancers: a wide low gate the traffic passes through. */
  gate: { width: 5.4, height: 3.2, depth: 1.2, bands: 6 },
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
  /** Lens phase of the intro (entering the machine). */
  introLens: 1400,
  /** Camera descent onto the city after the lens. */
  introCamera: 2400,
  /** Slow, calm flights between hosts in ambient mode. */
  ambientFly: 3200,
} as const;

/** Easing curves (GSAP names). */
export const easings = {
  cameraFlyTo: 'expo.inOut',
  jackIn: 'power4.in',
  jackOut: 'power3.out',
  hudUnfold: 'power3.out',
  introCamera: 'power2.out',
  ambientFly: 'sine.inOut',
} as const;

/** Scene atmosphere. */
export const atmosphere = {
  fogColor: neutrals.void,
  fogNear: 100,
  fogFar: 480,
} as const;

/**
 * City geometry in world units. Tower geometry is fixed for every host:
 * metrics never change shape, so spatial memory stays stable.
 */
export const cityGeometry = {
  towerWidth: 2.2,
  towerHeight: 8,
  /** Width of the glowing edge lines on a tower. */
  towerEdgeWidth: 0.07,
  /** Distance between tower centers inside a district. */
  slotSpacing: 6.5,
  /** Towers per row inside a district. Fixed, so adding a host never reflows the others. */
  districtColumns: 4,
  /** Empty space between districts. */
  districtGap: 16,
  /** Padding between a district's outline and its outer towers. */
  districtPadding: 3.5,
  diskRingInnerRadius: 1.9,
  diskRingOuterRadius: 2.3,
  /** Particle pool per tower; caps the visible rate. */
  particlesPerTower: 64,
  /** Height of the district plates the buildings stand on; floor marks (rings, links) sit above it. */
  plateHeight: 0.12,
} as const;

/** Camera framing. */
export const camera = {
  fieldOfView: 40,
  /** Distance from the focused tower during a fly-to. */
  focusDistance: 32,
  /** Elevation of the focus view above the horizon (radians); high enough to see over front rows. */
  focusElevation: 0.75,
  /** Height of the focus point above the tower base, as a fraction of tower height. */
  focusHeightRatio: 0.55,
  /** Shift the focused tower left of center so the HUD fits on the right (world units). */
  focusScreenShift: 5,
  minDistance: 3,
  maxDistance: 420,
  /** Keep the camera above the floor. Radians from straight down. */
  maxPolarAngle: 1.54,
  /** Orbit speed in ambient mode (OrbitControls autoRotate units; 2 = 30 s per turn). */
  ambientOrbitSpeed: 0.35,
  /** Pixels per arrow-key press (OrbitControls units). */
  keyPanSpeed: 28,
} as const;

/** Post-processing. Disabled entirely in lite mode. */
export const postProcessing = {
  bloomIntensity: 1.15,
  bloomThreshold: 0.55,
  bloomSmoothing: 0.25,
  vignetteDarkness: 0.65,
} as const;

/** Frame time above this (ms, averaged) for `liteSuggestAfterMs` suggests lite mode. */
export const performanceBudget = {
  liteSuggestFrameMs: 24,
  liteSuggestAfterMs: 5000,
} as const;
