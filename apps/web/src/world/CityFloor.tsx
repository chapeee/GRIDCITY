import { Grid } from '@react-three/drei';
import { useMemo } from 'react';
import { BufferAttribute, BufferGeometry, Color, LineBasicMaterial } from 'three';
import { accents, cityGeometry, neutrals } from '../design/tokens';
import type { DistrictPlacement } from './city-layout';

interface CityFloorProps {
  districts: readonly DistrictPlacement[];
}

/** Opacity of district outlines: the "line" neutral (cyan at low strength). */
const DISTRICT_OUTLINE_OPACITY = 0.18;

/** Dark grid floor plus thin district outlines. Static: atmosphere, not data. */
export function CityFloor({ districts }: CityFloorProps) {
  const outlineGeometry = useMemo(() => {
    const vertices: number[] = [];
    const y = 0.02;
    for (const d of districts) {
      const corners = [
        [d.minX, d.minZ],
        [d.maxX, d.minZ],
        [d.maxX, d.maxZ],
        [d.minX, d.maxZ],
      ] as const;
      corners.forEach(([x, z], index) => {
        const [nextX, nextZ] = corners[(index + 1) % corners.length]!;
        vertices.push(x, y, z, nextX, y, nextZ);
      });
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3));
    return geometry;
  }, [districts]);

  const outlineMaterial = useMemo(
    () =>
      new LineBasicMaterial({
        color: new Color(accents.online),
        transparent: true,
        opacity: DISTRICT_OUTLINE_OPACITY,
        fog: true,
      }),
    [],
  );

  return (
    <group>
      <Grid
        infiniteGrid
        position={[0, 0, 0]}
        cellSize={cityGeometry.slotSpacing / 4}
        cellThickness={0.5}
        cellColor={neutrals.grid}
        sectionSize={cityGeometry.slotSpacing}
        sectionThickness={0.9}
        sectionColor={neutrals.gridSection}
        fadeDistance={260}
        fadeStrength={1.6}
        raycast={() => null}
      />
      <lineSegments args={[outlineGeometry, outlineMaterial]} raycast={() => null} />
    </group>
  );
}
