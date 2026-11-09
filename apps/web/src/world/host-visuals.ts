import { isStale, type HostState, type StatusThresholds } from '@app/shared';
import { encoding, glow, statusGlowColor } from '../design/tokens';
import { formatLastSeen } from '../ui/format';

/**
 * Pure translation from host data to light. This file *is* the visual
 * language in code: every field here is documented in
 * docs/VISUAL_LANGUAGE.md and nothing else drives the towers.
 */

/** One segment of the disk ring at a tower's base. */
export interface DiskArc {
  /** Used / total, 0..1. */
  fillRatio: number;
  /** Above the disk threshold: drawn in the degraded accent. */
  overThreshold: boolean;
}

export interface HostVisual {
  /** Edge glow color (hex), or null for no emissive light at all. */
  glowColor: string | null;
  glowIntensity: number;
  /** Edge pulse frequency; 0 means a steady (or absent) glow. */
  pulseHz: number;
  /** Lit memory bands, or null when memory is unknown (no bands drawn). */
  memoryLitBands: number | null;
  diskArcs: DiskArc[];
  particlesPerSecond: number;
  /** Color saturation 0..1; reduced when data is stale. */
  saturation: number;
  /** Multiplier 0..1 for every light of the host; reduced when data is stale. */
  brightness: number;
  /** True when every motion must stop (stale or offline). */
  frozen: boolean;
  /** Second label line under the host name, or null. */
  caption: string | null;
  /** Label emphasis: dim for hosts without live data, warning for degraded. */
  labelTone: LabelTone;
}

export type LabelTone = 'normal' | 'dim' | 'warning';

const NO_LIGHT: Omit<HostVisual, 'caption'> = {
  labelTone: 'dim',
  glowColor: null,
  glowIntensity: 0,
  pulseHz: 0,
  memoryLitBands: null,
  diskArcs: [],
  particlesPerSecond: 0,
  saturation: 1,
  brightness: 1,
  frozen: true,
};

export function computeHostVisual(
  state: HostState | undefined,
  now: number,
  thresholds: StatusThresholds,
): HostVisual {
  // Truth state: offline. Dark, motionless. Must never look operational.
  if (state?.status === 'offline') {
    const lastSeen = state.lastSeenAt === null ? null : formatLastSeen(state.lastSeenAt, now);
    return { ...NO_LIGHT, caption: lastSeen ? `offline · ${lastSeen}` : 'offline' };
  }

  // Truth state: unknown. Present but unmeasured: a faint neutral outline only.
  if (!state || state.status === 'unknown') {
    return {
      ...NO_LIGHT,
      glowColor: statusGlowColor.unknown,
      glowIntensity: glow.towerEdgeUnknown,
      caption: 'waiting for first poll',
    };
  }

  const stale = state.stale || isStale(state.lastSeenAt, now, thresholds);

  return {
    glowColor: statusGlowColor[state.status],
    glowIntensity: glow.towerEdge * (stale ? encoding.staleBrightness : 1),
    // Truth state: stale. Last known values stay visible but frozen and desaturated.
    pulseHz: stale ? 0 : cpuToPulseHz(state.cpuPercent),
    memoryLitBands: memoryToLitBands(state.memory),
    diskArcs: disksToArcs(state.disks, thresholds.diskDegradedPercent),
    particlesPerSecond: networkToParticleRate(state.network),
    saturation: stale ? encoding.staleSaturation : 1,
    brightness: stale ? encoding.staleBrightness : 1,
    frozen: stale,
    labelTone: stale ? 'dim' : state.status === 'degraded' ? 'warning' : 'normal',
    caption: stale
      ? formatLastSeen(state.lastSeenAt, now)
      : state.status === 'degraded'
        ? state.statusReason
        : null,
  };
}

/** CPU 0..100 % -> pulse frequency, linear. Unknown CPU -> no pulse. */
export function cpuToPulseHz(cpuPercent: number | null): number {
  if (cpuPercent === null) return 0;
  const { atIdle, atFull } = encoding.pulseHz;
  const ratio = Math.min(1, Math.max(0, cpuPercent / 100));
  return atIdle + (atFull - atIdle) * ratio;
}

/** Memory ratio -> number of lit bands (rounded). Unknown -> null. */
export function memoryToLitBands(memory: HostState['memory']): number | null {
  if (!memory || memory.totalBytes <= 0) return null;
  const ratio = Math.min(1, Math.max(0, memory.usedBytes / memory.totalBytes));
  return Math.round(ratio * encoding.memoryBandCount);
}

/**
 * Disks -> ring arcs. Keeps the fullest `diskArcMax` disks (so a nearly full
 * disk is never hidden), then orders them by mount path for stability.
 */
export function disksToArcs(disks: HostState['disks'], diskDegradedPercent: number): DiskArc[] {
  return disks
    .filter((disk) => disk.totalBytes > 0)
    .map((disk) => ({
      mount: disk.mount,
      fillRatio: Math.min(1, disk.usedBytes / disk.totalBytes),
    }))
    .sort((a, b) => b.fillRatio - a.fillRatio)
    .slice(0, encoding.diskArcMax)
    .sort((a, b) => a.mount.localeCompare(b.mount))
    .map(({ fillRatio }) => ({ fillRatio, overThreshold: fillRatio * 100 > diskDegradedPercent }));
}

/**
 * Total network throughput -> particles per second, on a log scale between
 * the floor (nothing below ~1 KiB/s) and the ceiling (max rate).
 */
export function networkToParticleRate(network: HostState['network']): number {
  const total = network.reduce((sum, rate) => sum + rate.rxBytesPerSec + rate.txBytesPerSec, 0);
  const { floor, ceiling } = encoding.networkBytesPerSec;
  if (total < floor) return 0;
  const ratio = Math.log10(total / floor) / Math.log10(ceiling / floor);
  return Math.min(1, ratio) * encoding.particlesPerSecMax;
}
