import { useMemo } from 'react';
import { BoxGeometry, BufferGeometry, EdgesGeometry, Float32BufferAttribute } from 'three';
import { neutrals, resourceGeometry } from '../design/tokens';
import type { TowerPlacement } from './city-layout';

const { cageWidth, cageHeight } = resourceGeometry.cagedDrum;

/**
 * The thin cage around managed database instances (RDS). It marks the
 * *kind* of building, like its shape: static, neutral, never lit by data,
 * so an offline instance is still a dark drum in a faint frame. All cages
 * are one line-segment draw call.
 */
export function ResourceCages({ towers }: { towers: readonly TowerPlacement[] }) {
  const caged = useMemo(() => towers.filter((tower) => tower.shape === 'caged-drum'), [towers]);

  const geometry = useMemo(() => {
    const box = new BoxGeometry(cageWidth, cageHeight, cageWidth);
    box.translate(0, cageHeight / 2, 0);
    const edges = new EdgesGeometry(box);
    box.dispose();
    const template = edges.getAttribute('position').array;
    const positions = new Float32Array(template.length * caged.length);
    caged.forEach((tower, index) => {
      for (let i = 0; i < template.length; i += 3) {
        positions[index * template.length + i] = template[i]! + tower.x;
        positions[index * template.length + i + 1] = template[i + 1]!;
        positions[index * template.length + i + 2] = template[i + 2]! + tower.z;
      }
    });
    edges.dispose();
    const merged = new BufferGeometry();
    merged.setAttribute('position', new Float32BufferAttribute(positions, 3));
    return merged;
  }, [caged]);

  if (caged.length === 0) return null;
  return (
    <lineSegments geometry={geometry} raycast={() => null}>
      <lineBasicMaterial color={neutrals.gridSection} transparent opacity={0.9} />
    </lineSegments>
  );
}
