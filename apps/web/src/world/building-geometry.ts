import { BoxGeometry, BufferGeometry, CylinderGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { cityGeometry, encoding, resourceGeometry } from '../design/tokens';
import type { BuildingShape } from './city-layout';

/**
 * Fixed geometry per building shape. Base sits on the floor (y = 0).
 * Like the tower, no shape ever changes with data.
 */
export function buildShapeGeometry(shape: BuildingShape): BufferGeometry {
  switch (shape) {
    case 'tower': {
      const box = new BoxGeometry(
        cityGeometry.towerWidth,
        cityGeometry.towerHeight,
        cityGeometry.towerWidth,
      );
      box.translate(0, cityGeometry.towerHeight / 2, 0);
      return box;
    }
    case 'warehouse': {
      const { width, height, depth } = resourceGeometry.warehouse;
      const box = new BoxGeometry(width, height, depth);
      box.translate(0, height / 2, 0);
      return box;
    }
    case 'beacon': {
      const { width, height } = resourceGeometry.beacon;
      const spire = new BoxGeometry(width, height, width);
      spire.translate(0, height / 2, 0);
      return spire;
    }
    case 'gate': {
      const { width, height, depth } = resourceGeometry.gate;
      const slab = new BoxGeometry(width, height, depth);
      slab.translate(0, height / 2, 0);
      return slab;
    }
    case 'prism': {
      const { radius, height } = resourceGeometry.prism;
      const prism = new CylinderGeometry(radius, radius, height, 6, 1);
      prism.translate(0, height / 2, 0);
      return prism;
    }
    case 'drum':
    case 'caged-drum': {
      const spec = shape === 'drum' ? resourceGeometry.drum : resourceGeometry.cagedDrum;
      const discs = Array.from({ length: spec.discs }, (_, index) => {
        const disc = new CylinderGeometry(spec.radius, spec.radius, spec.discHeight, 40, 1);
        disc.translate(0, index * (spec.discHeight + spec.discGap) + spec.discHeight / 2, 0);
        return disc;
      });
      const merged = mergeGeometries(discs, false);
      for (const disc of discs) disc.dispose();
      return merged;
    }
  }
}

/** Height of a building's top, for labels and the focus ring. */
export function buildingHeight(shape: BuildingShape): number {
  switch (shape) {
    case 'tower':
      return cityGeometry.towerHeight;
    case 'warehouse':
      return resourceGeometry.warehouse.height;
    case 'beacon':
      return resourceGeometry.beacon.height;
    case 'gate':
      return resourceGeometry.gate.height;
    case 'prism':
      return resourceGeometry.prism.height;
    case 'drum':
      return discStackHeight(resourceGeometry.drum);
    case 'caged-drum':
      return resourceGeometry.cagedDrum.cageHeight;
  }
}

function discStackHeight(spec: { discs: number; discHeight: number; discGap: number }): number {
  return spec.discs * spec.discHeight + (spec.discs - 1) * spec.discGap;
}

/** Shader parameters for each shape (see tower-material.ts). */
export function shapeShaderParams(shape: BuildingShape) {
  switch (shape) {
    case 'tower':
      return {
        mode: 0,
        size: [cityGeometry.towerWidth, cityGeometry.towerHeight, cityGeometry.towerWidth] as const,
        bandCount: encoding.memoryBandCount,
      };
    case 'beacon': {
      const { width, height } = resourceGeometry.beacon;
      return { mode: 0, size: [width, height, width] as const, bandCount: 1 };
    }
    case 'gate': {
      const { width, height, depth, bands } = resourceGeometry.gate;
      return { mode: 0, size: [width, height, depth] as const, bandCount: bands };
    }
    case 'warehouse': {
      const { width, height, depth, roofColumns, roofRows } = resourceGeometry.warehouse;
      return {
        mode: 3,
        size: [width, height, depth] as const,
        bandCount: roofColumns * roofRows,
        roof: [roofColumns, roofRows] as const,
      };
    }
    case 'prism': {
      const { radius, height } = resourceGeometry.prism;
      return {
        mode: 2,
        size: [radius * 2, height, radius * 2] as const,
        radius,
        bandCount: encoding.connectionBands.prism,
      };
    }
    case 'drum':
    case 'caged-drum': {
      const spec = shape === 'drum' ? resourceGeometry.drum : resourceGeometry.cagedDrum;
      return {
        mode: 1,
        size: [spec.radius * 2, discStackHeight(spec), spec.radius * 2] as const,
        radius: spec.radius,
        disc: [spec.discHeight, spec.discGap] as const,
        bandCount: spec.discs,
      };
    }
  }
}
