import { useFrame, useThree } from '@react-three/fiber';
import { useLayoutEffect, useMemo, useRef } from 'react';
import { BufferAttribute, BufferGeometry, Color, type Points, type ShaderMaterial } from 'three';
import { cityGeometry, encoding } from '../design/tokens';
import type { TowerPlacement } from './city-layout';
import type { FreezeTracker } from './freeze-tracker';
import type { HostVisual } from './host-visuals';
import { createParticleMaterial } from './materials/particle-material';

interface NetworkParticlesProps {
  towers: readonly TowerPlacement[];
  visuals: ReadonlyMap<string, HostVisual>;
  freezeTracker: FreezeTracker;
  glowScale: number;
}

const POOL = cityGeometry.particlesPerTower;

/** Rising particles for network throughput: every tower's pool in one draw call. */
export function NetworkParticles({
  towers,
  visuals,
  freezeTracker,
  glowScale,
}: NetworkParticlesProps) {
  const pointsRef = useRef<Points>(null);
  const pixelRatio = useThree((state) => state.viewport.dpr);
  const count = towers.length * POOL;

  const geometry = useMemo(() => {
    const buffer = new BufferGeometry();
    const seeds = new Float32Array(count);
    const slots = new Float32Array(count);
    for (let index = 0; index < count; index++) {
      seeds[index] = index * 0.618 + 1;
      slots[index] = index % POOL;
    }
    buffer.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    buffer.setAttribute('aSeed', new BufferAttribute(seeds, 1));
    buffer.setAttribute('aSlot', new BufferAttribute(slots, 1));
    buffer.setAttribute('aActiveSlots', new BufferAttribute(new Float32Array(count), 1));
    buffer.setAttribute('aColor', new BufferAttribute(new Float32Array(count * 3), 3));
    buffer.setAttribute('aFrozenAt', new BufferAttribute(new Float32Array(count), 1));
    buffer.setAttribute('aSaturation', new BufferAttribute(new Float32Array(count), 1));
    return buffer;
  }, [count]);

  const material = useMemo(() => createParticleMaterial(pixelRatio), [pixelRatio]);

  useLayoutEffect(() => {
    const points = pointsRef.current;
    if (!points) return;
    const attribute = (name: string) => points.geometry.getAttribute(name) as BufferAttribute;
    const shaderTime = (points.material as ShaderMaterial).uniforms.uTime?.value ?? 0;
    const color = new Color();

    towers.forEach((tower, towerIndex) => {
      const visual = visuals.get(tower.hostId);
      if (!visual) return;
      const activeSlots = Math.min(
        POOL,
        Math.round(visual.particlesPerSecond * encoding.particleLifetimeSec),
      );
      const frozenAt = freezeTracker.update(tower.hostId, visual.frozen, shaderTime);
      color.set(visual.glowColor ?? '#000000').multiplyScalar(visual.brightness);
      for (let slot = 0; slot < POOL; slot++) {
        const index = towerIndex * POOL + slot;
        attribute('position').setXYZ(index, tower.x, 0, tower.z);
        attribute('aActiveSlots').setX(index, visual.glowColor ? activeSlots : 0);
        attribute('aColor').setXYZ(index, color.r, color.g, color.b);
        attribute('aFrozenAt').setX(index, frozenAt);
        attribute('aSaturation').setX(index, visual.saturation);
      }
    });
    for (const name of ['position', 'aActiveSlots', 'aColor', 'aFrozenAt', 'aSaturation']) {
      attribute(name).needsUpdate = true;
    }
  }, [towers, visuals, freezeTracker, geometry]);

  useFrame(({ clock }) => {
    const uniforms = (pointsRef.current?.material as ShaderMaterial | undefined)?.uniforms;
    if (!uniforms?.uTime || !uniforms.uGlowScale) return;
    uniforms.uTime.value = clock.elapsedTime;
    uniforms.uGlowScale.value = glowScale;
  });

  if (count === 0) return null;

  return (
    <points
      key={count}
      ref={pointsRef}
      args={[geometry, material]}
      frustumCulled={false}
      raycast={() => null}
    />
  );
}
