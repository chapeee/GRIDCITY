import { useMemo } from 'react';
import { RingGeometry } from 'three';
import { cityGeometry, neutrals } from '../design/tokens';
import type { TowerPlacement } from './city-layout';

interface FocusMarkerProps {
  tower: TowerPlacement | undefined;
}

/** Just outside the disk ring, so it never reads as part of the disk encoding. */
const MARKER_INNER_RADIUS = cityGeometry.diskRingOuterRadius + 0.45;
const MARKER_OUTER_RADIUS = MARKER_INNER_RADIUS + 0.08;

/**
 * Thin neutral ring on the floor under the focused tower. UI state, not data:
 * it shows which tower the HUD describes, in a neutral color so it never
 * competes with the status accents.
 */
export function FocusMarker({ tower }: FocusMarkerProps) {
  const geometry = useMemo(() => {
    const ring = new RingGeometry(MARKER_INNER_RADIUS, MARKER_OUTER_RADIUS, 96, 1);
    ring.rotateX(-Math.PI / 2);
    return ring;
  }, []);

  if (!tower) return null;

  return (
    <mesh geometry={geometry} position={[tower.x, 0.04, tower.z]} raycast={() => null}>
      <meshBasicMaterial color={neutrals.textBright} transparent opacity={0.85} fog />
    </mesh>
  );
}
