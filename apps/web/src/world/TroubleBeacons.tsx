import { useMemo } from 'react';
import { AdditiveBlending, Color, DoubleSide, ShaderMaterial } from 'three';
import type { HostStatus } from '@app/shared';
import { accents } from '../design/tokens';
import { buildingHeight } from './building-geometry';
import type { TowerPlacement } from './city-layout';
import type { HostVisual } from './host-visuals';

interface TroubleBeaconsProps {
  towers: readonly TowerPlacement[];
  statuses: ReadonlyMap<string, HostStatus>;
  visuals: ReadonlyMap<string, HostVisual>;
}

/** How high the shaft rises above the building's top. */
const SHAFT_HEIGHT = 26;
const SHAFT_RADIUS = 1.35;

const vertexShader = /* glsl */ `
  varying float vHeight;
  void main() {
    vHeight = uv.y;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  varying float vHeight;
  void main() {
    // Brightest at the building, fading to nothing high up.
    // Clamped: uv.y can overshoot 1.0 by a rounding error, and pow() of a negative
    // base is NaN, which bloom would spread across the whole frame.
    float alpha = pow(clamp(1.0 - vHeight, 0.0, 1.0), 2.2) * 0.42;
    gl_FragColor = vec4(uColor * alpha, alpha);
  }
`;

/**
 * A soft amber shaft of light rising from every degraded building, so a
 * problem is visible from anywhere in the city, even behind other towers.
 * Encodes one field: status === 'degraded' (live, not stale). Offline
 * buildings stay dark, as always; the shaft never moves.
 */
export function TroubleBeacons({ towers, statuses, visuals }: TroubleBeaconsProps) {
  const material = useMemo(
    () =>
      new ShaderMaterial({
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        side: DoubleSide,
        uniforms: { uColor: { value: new Color(accents.degraded) } },
      }),
    [],
  );
  const degraded = towers.filter(
    (tower) => statuses.get(tower.hostId) === 'degraded' && !visuals.get(tower.hostId)?.frozen,
  );
  if (degraded.length === 0) return null;
  return (
    <group>
      {degraded.map((tower) => {
        const base = buildingHeight(tower.shape ?? 'tower');
        return (
          <mesh
            key={tower.hostId}
            material={material}
            position={[tower.x, base + SHAFT_HEIGHT / 2, tower.z]}
            raycast={() => null}
            renderOrder={5}
          >
            <cylinderGeometry
              args={[SHAFT_RADIUS * 0.55, SHAFT_RADIUS, SHAFT_HEIGHT, 24, 1, true]}
            />
          </mesh>
        );
      })}
    </group>
  );
}
