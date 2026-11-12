import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import {
  AdditiveBlending,
  Color,
  DoubleSide,
  type Group,
  type Mesh,
  MeshBasicMaterial,
} from 'three';
import { SEVERITY_RANK, type ThreatSeverity } from '@app/shared';
import { accents, cityGeometry } from '../design/tokens';
import { buildingHeight, shapeShaderParams } from './building-geometry';
import type { TowerPlacement } from './city-layout';

interface AttackRingsProps {
  towers: readonly TowerPlacement[];
  /** Worst open finding per building. */
  severities: ReadonlyMap<string, ThreatSeverity>;
  animate: boolean;
}

/** Seconds per strike: critical repeats faster than high. */
const PERIOD_S = { high: 2.4, critical: 1.4 } as const;
/** Share of the cycle the strike takes to fall from the top to the ground. */
const FALL = 0.35;
/** Nothing may reach the next slot (slots are 6.5 apart). */
const MAX_RADIUS = 3.15;
const FLOOR = cityGeometry.plateHeight + 0.05;

/** How far the building reaches from its centre on the ground. */
function footprintRadius(tower: TowerPlacement): number {
  const [width, , depth] = shapeShaderParams(tower.shape ?? 'tower').size;
  return Math.hypot(width, depth) / 2;
}

/**
 * Attacks on a building, readable from anywhere in the city. High and
 * critical: a red marker flashes above the roof, a red band strikes down the
 * building, and a ring spreads from its base and fades; then it repeats
 * (faster for critical). The steady red ring at the base stays. This is the
 * only use of the alert accent in the 3D world. Medium: a still, thin amber
 * ring. Low: nothing. Encodes one field: the worst open finding's severity.
 */
export function AttackRings({ towers, severities, animate }: AttackRingsProps) {
  const marked = towers
    .map((tower) => ({ tower, severity: severities.get(tower.hostId) }))
    .filter(
      (entry): entry is { tower: TowerPlacement; severity: ThreatSeverity } =>
        entry.severity !== undefined && SEVERITY_RANK[entry.severity] >= SEVERITY_RANK.medium,
    );
  if (marked.length === 0) return null;
  return (
    <group>
      {marked.map(({ tower, severity }) =>
        severity === 'medium' ? (
          <MediumRing key={tower.hostId} tower={tower} />
        ) : (
          <AttackStrike
            key={tower.hostId}
            tower={tower}
            period={PERIOD_S[severity as 'high' | 'critical']}
            animate={animate}
          />
        ),
      )}
    </group>
  );
}

function additive(color: string, opacity: number) {
  return new MeshBasicMaterial({
    color: new Color(color),
    transparent: true,
    opacity,
    blending: AdditiveBlending,
    depthWrite: false,
    side: DoubleSide,
  });
}

function MediumRing({ tower }: { tower: TowerPlacement }) {
  const material = useMemo(() => additive(accents.degraded, 0.6), []);
  const radius = Math.min(MAX_RADIUS - 0.3, Math.max(footprintRadius(tower) + 0.5, 2.45));
  return (
    <mesh
      material={material}
      position={[tower.x, FLOOR, tower.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      raycast={() => null}
      renderOrder={6}
    >
      <ringGeometry args={[radius, radius + 0.12, 64]} />
    </mesh>
  );
}

function AttackStrike({
  tower,
  period,
  animate,
}: {
  tower: TowerPlacement;
  period: number;
  animate: boolean;
}) {
  const top = buildingHeight(tower.shape ?? 'tower') + cityGeometry.plateHeight;
  const hug = footprintRadius(tower) + 0.12;
  const base = Math.min(MAX_RADIUS - 0.7, Math.max(hug + 0.4, 2.45));
  const materials = useMemo(
    () => ({
      steady: additive(accents.alert, 0.85),
      band: additive(accents.alert, 0.9),
      wave: additive(accents.alert, 0.8),
      marker: additive(accents.alert, 1),
    }),
    [],
  );
  const band = useRef<Mesh>(null);
  const wave = useRef<Group>(null);
  const marker = useRef<Mesh>(null);
  // Each building starts at its own moment, so a row of attacked buildings does not blink in step.
  const offset = useMemo(
    () => (Math.abs(Math.sin(tower.x * 12.9898 + tower.z * 78.233)) * 43758) % 1,
    [tower.x, tower.z],
  );

  useFrame(({ clock }) => {
    if (!band.current || !wave.current || !marker.current) return;
    if (!animate) {
      band.current.visible = false;
      wave.current.visible = false;
      marker.current.visible = true;
      materials.marker.opacity = 0.9;
      return;
    }
    const phase = (clock.getElapsedTime() / period + offset) % 1;
    // 1. The marker above the roof flashes as the strike starts.
    materials.marker.opacity = phase < FALL ? 1 : 0.35 + 0.25 * (1 - phase);
    marker.current.rotation.y = clock.getElapsedTime() * 1.5;
    // 2. A red band falls from the roof to the ground, accelerating.
    if (phase < FALL) {
      const t = phase / FALL;
      band.current.visible = true;
      band.current.position.y = top - (top - FLOOR) * t * t;
      materials.band.opacity = 0.5 + 0.5 * t;
    } else {
      band.current.visible = false;
    }
    // 3. It hits the ground and a ring spreads out and fades.
    if (phase >= FALL) {
      const t = (phase - FALL) / (1 - FALL);
      wave.current.visible = true;
      const radius = base + (MAX_RADIUS - base) * t;
      wave.current.scale.setScalar(radius / base);
      materials.wave.opacity = 0.85 * (1 - t);
    } else {
      wave.current.visible = false;
    }
  });

  return (
    <group position={[tower.x, 0, tower.z]}>
      <mesh
        ref={marker}
        material={materials.marker}
        position={[0, top + 1.0, 0]}
        raycast={() => null}
        renderOrder={6}
      >
        <octahedronGeometry args={[0.35, 0]} />
      </mesh>
      <mesh
        ref={band}
        material={materials.band}
        position={[0, top, 0]}
        raycast={() => null}
        renderOrder={6}
      >
        <cylinderGeometry args={[hug, hug, 0.3, 48, 1, true]} />
      </mesh>
      <mesh
        material={materials.steady}
        position={[0, FLOOR, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={() => null}
        renderOrder={6}
      >
        <ringGeometry args={[base, base + 0.18, 64]} />
      </mesh>
      <group ref={wave} position={[0, FLOOR + 0.01, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh material={materials.wave} raycast={() => null} renderOrder={6}>
          <ringGeometry args={[base, base + 0.14, 64]} />
        </mesh>
      </group>
    </group>
  );
}
