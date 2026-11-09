import { Vector3 } from 'three';
import { camera as cameraTokens, cityGeometry } from '../design/tokens';
import type { CityLayout, TowerPlacement } from './city-layout';

/** Where the camera sits and what it looks at. */
export interface CameraPose {
  position: Vector3;
  target: Vector3;
}

/** Frames the whole city from above and in front. */
export function overviewPose(layout: CityLayout): CameraPose {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const size = Math.max(maxX - minX, maxZ - minZ, 40);
  const distance = size * 1.05 + 20;
  return {
    target: new Vector3(0, 0, 0),
    position: new Vector3(0, distance * 0.6, distance * 0.8),
  };
}

/**
 * Looks at one tower from the direction the camera is already facing, so the
 * flight feels continuous. The tower is shifted left of screen center to
 * leave room for the HUD on the right.
 */
export function focusPose(
  tower: TowerPlacement,
  currentPosition: Vector3,
  currentTarget: Vector3,
): CameraPose {
  const lookAt = new Vector3(
    tower.x,
    cityGeometry.towerHeight * cameraTokens.focusHeightRatio,
    tower.z,
  );

  const horizontal = new Vector3().subVectors(currentPosition, currentTarget).setY(0);
  if (horizontal.lengthSq() < 1e-6) horizontal.set(0, 0, 1);
  horizontal.normalize();

  const offset = horizontal
    .clone()
    .multiplyScalar(Math.cos(cameraTokens.focusElevation) * cameraTokens.focusDistance)
    .setY(Math.sin(cameraTokens.focusElevation) * cameraTokens.focusDistance);

  // Camera right vector (horizontal) = forward × up, with forward = -horizontal.
  // Moving target and camera together to the right puts the tower on the left.
  const right = new Vector3(horizontal.z, 0, -horizontal.x).multiplyScalar(
    cameraTokens.focusScreenShift,
  );

  const target = lookAt.clone().add(right);
  return { target, position: target.clone().add(offset) };
}
