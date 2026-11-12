import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { AdditiveBlending, Color, DoubleSide, type Group, MeshBasicMaterial } from 'three';
import { cityGeometry, neutrals } from '../design/tokens';
import { useUiStore } from '../ui/ui-store';
import { buildingHeight, shapeShaderParams } from './building-geometry';
import type { TowerPlacement } from './city-layout';

/** How long the highlight plays after "Show building", seconds. */
const DURATION_S = 2.2;
const FLOOR = cityGeometry.plateHeight + 0.06;

/**
 * "This one": after Show building, a white column of light rises around the
 * building and two rings ripple out from its base, then it all fades. UI
 * state, not data, so it is drawn in the neutral bright text color.
 */
export function BuildingHighlight({ towers }: { towers: readonly TowerPlacement[] }) {
  const highlight = useUiStore((store) => store.highlight);
  const tower = highlight ? towers.find((t) => t.hostId === highlight.id) : undefined;
  if (!highlight || !tower) return null;
  return <Highlight key={highlight.at} tower={tower} startedAt={highlight.at} />;
}

function Highlight({ tower, startedAt }: { tower: TowerPlacement; startedAt: number }) {
  const [width, , depth] = shapeShaderParams(tower.shape ?? 'tower').size;
  const radius = Math.hypot(width, depth) / 2 + 0.25;
  const height = buildingHeight(tower.shape ?? 'tower') + 2;
  const materials = useMemo(() => {
    const make = () =>
      new MeshBasicMaterial({
        color: new Color(neutrals.textBright),
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        depthWrite: false,
        side: DoubleSide,
      });
    return { column: make(), ring1: make(), ring2: make() };
  }, []);
  const column = useRef<Group>(null);
  const ring1 = useRef<Group>(null);
  const ring2 = useRef<Group>(null);

  useFrame(() => {
    const t = (performance.now() - startedAt) / 1000 / DURATION_S;
    if (!column.current || !ring1.current || !ring2.current) return;
    if (t >= 1) {
      materials.column.opacity = materials.ring1.opacity = materials.ring2.opacity = 0;
      return;
    }
    // The column rises in the first third, then fades.
    const rise = Math.min(1, t / 0.3);
    column.current.scale.set(1, Math.max(0.01, rise), 1);
    materials.column.opacity = 0.35 * (t < 0.3 ? 1 : 1 - (t - 0.3) / 0.7);
    // Two ripples, the second half a beat behind.
    const ripple = (group: Group, material: MeshBasicMaterial, delay: number) => {
      const local = Math.min(1, Math.max(0, (t - delay) / 0.6));
      group.scale.setScalar(1 + local * 1.1);
      material.opacity = local > 0 && local < 1 ? 0.9 * (1 - local) : 0;
    };
    ripple(ring1.current, materials.ring1, 0);
    ripple(ring2.current, materials.ring2, 0.25);
  });

  return (
    <group position={[tower.x, 0, tower.z]}>
      <group ref={column} position={[0, FLOOR, 0]}>
        <mesh
          material={materials.column}
          position={[0, height / 2, 0]}
          raycast={() => null}
          renderOrder={7}
        >
          <cylinderGeometry args={[radius, radius, height, 48, 1, true]} />
        </mesh>
      </group>
      <group ref={ring1} position={[0, FLOOR, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh material={materials.ring1} raycast={() => null} renderOrder={7}>
          <ringGeometry args={[radius, radius + 0.12, 64]} />
        </mesh>
      </group>
      <group ref={ring2} position={[0, FLOOR, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh material={materials.ring2} raycast={() => null} renderOrder={7}>
          <ringGeometry args={[radius, radius + 0.12, 64]} />
        </mesh>
      </group>
    </group>
  );
}
