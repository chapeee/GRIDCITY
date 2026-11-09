import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { camera as cameraTokens, cityGeometry } from '../design/tokens';
import { focusPose, overviewPose } from './camera-poses';
import type { CityLayout } from './city-layout';

const tower = { hostId: 'web-01', district: 'east', x: 10, z: -5 };

/** Signed horizontal screen offset of a point: negative = left of center. */
function screenOffset(point: Vector3, position: Vector3, target: Vector3): number {
  const forward = new Vector3().subVectors(target, position).normalize();
  const right = new Vector3().crossVectors(forward, new Vector3(0, 1, 0)).normalize();
  return new Vector3().subVectors(point, position).dot(right);
}

describe('focusPose', () => {
  const fromPosition = new Vector3(0, 60, 90);
  const fromTarget = new Vector3(0, 0, 0);
  const pose = focusPose(tower, fromPosition, fromTarget);
  const towerCenter = new Vector3(
    tower.x,
    cityGeometry.towerHeight * cameraTokens.focusHeightRatio,
    tower.z,
  );

  it('frames the tower left of screen center, leaving room for the HUD', () => {
    expect(screenOffset(towerCenter, pose.position, pose.target)).toBeLessThan(0);
  });

  it('keeps the configured distance and looks down from above', () => {
    expect(pose.position.distanceTo(pose.target)).toBeCloseTo(cameraTokens.focusDistance);
    expect(pose.position.y).toBeGreaterThan(pose.target.y);
  });

  it('approaches from the side the camera is already on', () => {
    const fromBehind = focusPose(tower, new Vector3(0, 60, -90), fromTarget);
    expect(pose.position.z).toBeGreaterThan(tower.z);
    expect(fromBehind.position.z).toBeLessThan(tower.z);
  });
});

describe('overviewPose', () => {
  it('looks at the city center from above and in front', () => {
    const layout: CityLayout = {
      towers: [],
      districts: [],
      bounds: { minX: -50, maxX: 50, minZ: -30, maxZ: 30 },
    };
    const pose = overviewPose(layout);
    expect(pose.target.toArray()).toEqual([0, 0, 0]);
    expect(pose.position.y).toBeGreaterThan(0);
    expect(pose.position.z).toBeGreaterThan(0);
  });
});
