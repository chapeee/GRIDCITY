import { useFrame, type ThreeEvent } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  Color,
  InstancedBufferAttribute,
  Matrix4,
  type InstancedMesh,
  type ShaderMaterial,
} from 'three';
import { buildShapeGeometry } from './building-geometry';
import type { BuildingShape, TowerPlacement } from './city-layout';
import type { FreezeTracker } from './freeze-tracker';
import type { HostVisual } from './host-visuals';
import { createTowerMaterial, TOWER_INSTANCE_ATTRIBUTES } from './materials/tower-material';

interface TowerFieldProps {
  towers: readonly TowerPlacement[];
  /** Which buildings this field draws; each shape is its own instanced mesh. */
  shape?: BuildingShape;
  visuals: ReadonlyMap<string, HostVisual>;
  freezeTracker: FreezeTracker;
  glowScale: number;
  onSelect(hostId: string): void;
}

/** Pointer travel (px) above which a press counts as a camera drag, not a click. */
const CLICK_DRAG_TOLERANCE_PX = 5;

/** All buildings of one shape as one instanced mesh: one draw call regardless of count. */
export function TowerField({
  towers: allTowers,
  shape = 'tower',
  visuals,
  freezeTracker,
  glowScale,
  onSelect,
}: TowerFieldProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const towers = useMemo(
    () => allTowers.filter((tower) => (tower.shape ?? 'tower') === shape),
    [allTowers, shape],
  );
  const count = towers.length;

  const geometry = useMemo(() => {
    const box = buildShapeGeometry(shape);
    for (const [name, size] of Object.entries(TOWER_INSTANCE_ATTRIBUTES)) {
      box.setAttribute(
        name,
        new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * size), size),
      );
    }
    return box;
  }, [count, shape]);

  const material = useMemo(() => createTowerMaterial(shape), [shape]);

  // Positions only change when the layout does.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    towers.forEach((tower, index) =>
      mesh.setMatrixAt(index, matrix.makeTranslation(tower.x, 0, tower.z)),
    );
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [towers, geometry]);

  // Encodings change on every poll and every clock tick.
  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const shaderTime = (mesh.material as ShaderMaterial).uniforms.uTime?.value ?? 0;
    const attribute = (name: keyof typeof TOWER_INSTANCE_ATTRIBUTES) =>
      mesh.geometry.getAttribute(name) as InstancedBufferAttribute;
    const color = new Color();

    towers.forEach((tower, index) => {
      const visual = visuals.get(tower.hostId);
      if (!visual) return;
      color.set(visual.glowColor ?? '#000000');
      attribute('aGlowColor').setXYZ(index, color.r, color.g, color.b);
      attribute('aGlowIntensity').setX(index, visual.glowColor ? visual.glowIntensity : 0);
      attribute('aPulseHz').setX(index, visual.pulseHz);
      attribute('aPulsePhase').setX(index, index * 2.399); // golden angle: towers never pulse in sync
      attribute('aMemoryLitBands').setX(index, visual.memoryLitBands ?? -1);
      attribute('aSaturation').setX(index, visual.saturation);
      attribute('aFrozenAt').setX(
        index,
        freezeTracker.update(tower.hostId, visual.frozen, shaderTime),
      );
    });
    for (const name of Object.keys(TOWER_INSTANCE_ATTRIBUTES)) {
      attribute(name as keyof typeof TOWER_INSTANCE_ATTRIBUTES).needsUpdate = true;
    }
  }, [towers, visuals, freezeTracker, geometry]);

  useFrame(({ clock }) => {
    const uniforms = (meshRef.current?.material as ShaderMaterial | undefined)?.uniforms;
    if (!uniforms?.uTime || !uniforms.uGlowScale) return;
    uniforms.uTime.value = clock.elapsedTime;
    uniforms.uGlowScale.value = glowScale;
  });

  const handleClick = (event: ThreeEvent<MouseEvent>) => {
    if (event.delta > CLICK_DRAG_TOLERANCE_PX || event.instanceId === undefined) return;
    event.stopPropagation();
    const tower = towers[event.instanceId];
    if (tower) onSelect(tower.hostId);
  };

  if (count === 0) return null;

  return (
    <instancedMesh
      key={count}
      ref={meshRef}
      args={[geometry, material, count]}
      onClick={handleClick}
      onPointerOver={() => (document.body.style.cursor = 'pointer')}
      onPointerOut={() => (document.body.style.cursor = '')}
    />
  );
}
