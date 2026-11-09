import { useFrame } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import {
  Color,
  InstancedBufferAttribute,
  Matrix4,
  RingGeometry,
  type InstancedMesh,
  type ShaderMaterial,
} from 'three';
import { cityGeometry, glow } from '../design/tokens';
import type { TowerPlacement } from './city-layout';
import type { HostVisual } from './host-visuals';
import {
  createDiskRingMaterial,
  DISK_RING_INSTANCE_ATTRIBUTES,
} from './materials/disk-ring-material';

interface DiskRingsProps {
  towers: readonly TowerPlacement[];
  visuals: ReadonlyMap<string, HostVisual>;
  glowScale: number;
}

/** Lift above the floor to avoid z-fighting with the grid. */
const RING_HEIGHT = 0.03;

/** Disk usage rings at every tower base, as one instanced mesh. */
export function DiskRings({ towers, visuals, glowScale }: DiskRingsProps) {
  const meshRef = useRef<InstancedMesh>(null);
  const count = towers.length;

  const geometry = useMemo(() => {
    const ring = new RingGeometry(
      cityGeometry.diskRingInnerRadius,
      cityGeometry.diskRingOuterRadius,
      96,
      1,
    );
    ring.rotateX(-Math.PI / 2); // lie flat on the floor
    for (const [name, size] of Object.entries(DISK_RING_INSTANCE_ATTRIBUTES)) {
      ring.setAttribute(
        name,
        new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * size), size),
      );
    }
    return ring;
  }, [count]);

  const material = useMemo(() => createDiskRingMaterial(), []);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const matrix = new Matrix4();
    towers.forEach((tower, index) =>
      mesh.setMatrixAt(index, matrix.makeTranslation(tower.x, RING_HEIGHT, tower.z)),
    );
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [towers, geometry]);

  useLayoutEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    const attribute = (name: keyof typeof DISK_RING_INSTANCE_ATTRIBUTES) =>
      mesh.geometry.getAttribute(name) as InstancedBufferAttribute;
    const color = new Color();

    towers.forEach((tower, index) => {
      const visual = visuals.get(tower.hostId);
      if (!visual) return;
      const arcs = visual.diskArcs;
      const fill = (i: number) => arcs[i]?.fillRatio ?? 0;
      const over = (i: number) => (arcs[i]?.overThreshold ? 1 : 0);
      color.set(visual.glowColor ?? '#000000');
      attribute('aDiskFill').setXYZW(index, fill(0), fill(1), fill(2), fill(3));
      attribute('aDiskOver').setXYZW(index, over(0), over(1), over(2), over(3));
      attribute('aArcCount').setX(index, arcs.length);
      attribute('aRingColor').setXYZ(index, color.r, color.g, color.b);
      attribute('aRingIntensity').setX(
        index,
        visual.glowColor ? glow.diskRing * visual.brightness : 0,
      );
      attribute('aSaturation').setX(index, visual.saturation);
    });
    for (const name of Object.keys(DISK_RING_INSTANCE_ATTRIBUTES)) {
      attribute(name as keyof typeof DISK_RING_INSTANCE_ATTRIBUTES).needsUpdate = true;
    }
  }, [towers, visuals, geometry]);

  useFrame(() => {
    const uniforms = (meshRef.current?.material as ShaderMaterial | undefined)?.uniforms;
    if (uniforms?.uGlowScale) uniforms.uGlowScale.value = glowScale;
  });

  if (count === 0) return null;

  // Rings are decoration of the tower: they never capture clicks.
  return (
    <instancedMesh
      key={count}
      ref={meshRef}
      args={[geometry, material, count]}
      raycast={() => null}
    />
  );
}
