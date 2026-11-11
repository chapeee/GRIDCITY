import {
  isStale,
  RESOURCE_SHAPES,
  type Resource,
  type ResourceShape,
  type ResourceState,
} from '@app/shared';
import { encoding, glow, resourceGeometry, statusGlowColor } from '../design/tokens';
import { formatLastSeen } from '../ui/format';
import type { HostVisual } from './host-visuals';

/**
 * Pure translation from resource data to light, the counterpart of
 * host-visuals.ts. Every mapping is documented in docs/VISUAL_LANGUAGE.md
 * ("Resource encodings"). The result reuses the host visual shape, so rings,
 * particles and labels work the same for every building.
 *
 * Reused channels per shape:
 * - pulse: ops/s (drum, prism), CPU % (caged drum), none (warehouse)
 * - bands (`memoryLitBands`): connections ÷ max (drum, prism; RDS has no max
 *   so no bands), or roof cells = stored bytes (warehouse)
 * - ring (`diskArcs`): used ÷ limit when a limit is known (Redis maxmemory,
 *   RDS allocated storage); one arc
 * - particles: bucket growth only
 */
export function computeResourceVisual(
  resource: Resource,
  state: ResourceState | undefined,
  now: number,
  staleAfterPolls = 3,
): HostVisual {
  const shape = RESOURCE_SHAPES[resource.kind];
  const base = {
    glowColor: null,
    glowIntensity: 0,
    pulseHz: 0,
    memoryLitBands: null,
    diskArcs: [],
    particlesPerSecond: 0,
    saturation: 1,
    brightness: 1,
    frozen: true,
    labelTone: 'dim' as const,
  };

  if (state?.status === 'offline') {
    const lastSeen = state.lastSeenAt === null ? null : formatLastSeen(state.lastSeenAt, now);
    return { ...base, caption: lastSeen ? `offline · ${lastSeen}` : 'offline' };
  }
  if (!state || state.status === 'unknown') {
    return {
      ...base,
      glowColor: statusGlowColor.unknown,
      glowIntensity: glow.towerEdgeUnknown,
      caption: 'waiting for first poll',
    };
  }

  const stale =
    state.stale ||
    isStale(state.lastSeenAt, now, { pollIntervalMs: state.pollIntervalMs, staleAfterPolls });
  const { gauges } = state;
  const storageRatio = gauges.storage?.totalBytes
    ? Math.min(1, gauges.storage.usedBytes / gauges.storage.totalBytes)
    : null;

  return {
    glowColor: statusGlowColor[state.status],
    glowIntensity: glow.towerEdge * (stale ? encoding.staleBrightness : 1),
    pulseHz: stale ? 0 : pulseFor(shape, state),
    memoryLitBands: bandsFor(shape, state),
    diskArcs:
      storageRatio === null || shape === 'warehouse'
        ? []
        : // Degraded accent exactly when the server's storage rule fired.
          [
            {
              fillRatio: storageRatio,
              overThreshold:
                state.status === 'degraded' && /storage/.test(state.statusReason ?? ''),
            },
          ],
    particlesPerSecond: shape === 'warehouse' ? growthToParticleRate(gauges.growthBytesPerHour) : 0,
    saturation: stale ? encoding.staleSaturation : 1,
    brightness: stale ? encoding.staleBrightness : 1,
    frozen: stale,
    labelTone: stale ? 'dim' : state.status === 'degraded' ? 'warning' : 'normal',
    caption: stale
      ? formatLastSeen(state.lastSeenAt, now)
      : state.status === 'degraded'
        ? state.statusReason
        : resource.engine,
  };
}

function pulseFor(shape: ResourceShape, state: ResourceState): number {
  const { atIdle, atFull } = encoding.pulseHz;
  if (shape === 'warehouse') return 0;
  if (shape === 'beacon') return latencyToPulseHz(state.gauges.latencyMs);
  if (shape === 'caged-drum') {
    const cpu = state.gauges.cpuPercent;
    return cpu === null ? 0 : atIdle + (atFull - atIdle) * Math.min(1, Math.max(0, cpu / 100));
  }
  return opsToPulseHz(state.gauges.opsPerSec);
}

/** Ops per second -> pulse frequency on a log scale; unknown -> steady glow. */
export function opsToPulseHz(opsPerSec: number | null): number {
  if (opsPerSec === null) return 0;
  const { atIdle, atFull } = encoding.pulseHz;
  const { floor, ceiling } = encoding.opsPerSec;
  if (opsPerSec <= floor) return atIdle;
  const ratio = Math.min(1, Math.log10(opsPerSec / floor) / Math.log10(ceiling / floor));
  return atIdle + (atFull - atIdle) * ratio;
}

/** Latency -> pulse frequency on a log scale: a slow endpoint pulses fast. Unknown -> steady. */
export function latencyToPulseHz(latencyMs: number | null): number {
  if (latencyMs === null) return 0;
  const { atIdle, atFull } = encoding.pulseHz;
  const { floor, ceiling } = encoding.latencyMs;
  if (latencyMs <= floor) return atIdle;
  const ratio = Math.min(1, Math.log10(latencyMs / floor) / Math.log10(ceiling / floor));
  return atIdle + (atFull - atIdle) * ratio;
}

/** Healthy targets -> lit gate bands (all lit = every target healthy). Unknown -> none. */
export function targetsToBands(
  targets: { healthy: number; total: number } | null,
  bands: number,
): number | null {
  if (!targets || targets.total <= 0) return null;
  return Math.round((targets.healthy / targets.total) * bands);
}

function bandsFor(shape: ResourceShape, state: ResourceState): number | null {
  if (shape === 'warehouse') return bytesToRoofCells(state.gauges.storage?.usedBytes ?? null);
  if (shape === 'beacon') return null;
  if (shape === 'gate') return targetsToBands(state.gauges.targets, resourceGeometry.gate.bands);
  const connections = state.gauges.connections;
  if (!connections?.max || shape === 'caged-drum') return null;
  const count = shape === 'prism' ? encoding.connectionBands.prism : encoding.connectionBands.drum;
  const ratio = Math.min(1, Math.max(0, connections.used / connections.max));
  return Math.round(ratio * count);
}

/** Stored bytes -> lit roof cells (log scale). Unknown -> no cells drawn. */
export function bytesToRoofCells(bytes: number | null): number | null {
  if (bytes === null) return null;
  const { floor, ceiling } = encoding.bucketBytes;
  if (bytes < floor) return 0;
  const ratio = Math.min(1, Math.log10(bytes / floor) / Math.log10(ceiling / floor));
  return Math.max(1, Math.round(ratio * encoding.roofCells));
}

/** Positive growth -> particles per second (log scale). Shrinking or unknown -> none. */
export function growthToParticleRate(bytesPerHour: number | null): number {
  if (bytesPerHour === null || bytesPerHour <= 0) return 0;
  const { floor, ceiling } = encoding.growthBytesPerHour;
  if (bytesPerHour < floor) return 0;
  const ratio = Math.min(1, Math.log10(bytesPerHour / floor) / Math.log10(ceiling / floor));
  return ratio * encoding.particlesPerSecMax;
}
