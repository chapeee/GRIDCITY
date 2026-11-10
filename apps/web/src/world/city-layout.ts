/**
 * Deterministic, stable city layout.
 *
 * Each district is a block with a fixed number of columns; each host owns a
 * numbered slot in its district. Slots are sticky: once assigned, a host
 * keeps its slot, and new hosts take the lowest free one. Adding a host
 * therefore never moves anyone else, which keeps spatial memory intact.
 *
 * Phase 1 persists slot assignments in the browser; Phase 2 moves them to
 * the server's SQLite database.
 */

import type { LayoutHost, ResourceShape, SlotAssignments } from '@app/shared';

export type BuildingShape = 'tower' | ResourceShape;

export { assignSlots, type LayoutHost, type SlotAssignments } from '@app/shared';

export interface LayoutDimensions {
  slotSpacing: number;
  districtColumns: number;
  districtGap: number;
  districtPadding: number;
}

export interface TowerPlacement {
  /** Host or resource id (they share one layout). */
  hostId: string;
  district: string;
  /** Fixed shape: a tower for hosts, one shape per resource kind. */
  shape?: BuildingShape;
  /** Text above the building (host id, resource name). */
  label?: string;
  /** World position of the tower base center on the floor (x, z). */
  x: number;
  z: number;
}

export interface DistrictPlacement {
  name: string;
  /** Outline rectangle on the floor. */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface CityLayout {
  towers: TowerPlacement[];
  districts: DistrictPlacement[];
  /** Overall extent, for framing the overview camera. */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
}

export function computeCityLayout(
  hosts: readonly LayoutHost[],
  slots: SlotAssignments,
  dimensions: LayoutDimensions,
): CityLayout {
  const { slotSpacing, districtColumns, districtGap, districtPadding } = dimensions;
  const districtNames = [...new Set(hosts.map((host) => host.district))].sort((a, b) =>
    a.localeCompare(b),
  );

  // Districts sit on a grid; every cell is sized for a full row of towers.
  const districtGridColumns = Math.max(1, Math.ceil(Math.sqrt(districtNames.length)));
  const blockWidth = (districtColumns - 1) * slotSpacing + 2 * districtPadding;
  const rowsByDistrict = new Map<string, number>();
  for (const host of hosts) {
    const rows = Math.floor((slots[host.id] ?? 0) / districtColumns) + 1;
    rowsByDistrict.set(host.district, Math.max(rowsByDistrict.get(host.district) ?? 1, rows));
  }

  // Each row of districts is as deep as its deepest district.
  const gridRowCount = Math.ceil(districtNames.length / districtGridColumns);
  const rowDepths = Array.from({ length: gridRowCount }, (_, row) =>
    Math.max(
      1,
      ...districtNames
        .slice(row * districtGridColumns, (row + 1) * districtGridColumns)
        .map((name) => rowsByDistrict.get(name) ?? 1),
    ),
  );
  const rowOffsets = rowDepths.map((_, row) =>
    rowDepths
      .slice(0, row)
      .reduce((sum, rows) => sum + (rows - 1) * slotSpacing + 2 * districtPadding + districtGap, 0),
  );

  const districtOrigins = new Map<string, { x: number; z: number }>();
  const districts: DistrictPlacement[] = districtNames.map((name, index) => {
    const column = index % districtGridColumns;
    const row = Math.floor(index / districtGridColumns);
    const minX = column * (blockWidth + districtGap);
    const minZ = rowOffsets[row] ?? 0;
    const depth = ((rowsByDistrict.get(name) ?? 1) - 1) * slotSpacing + 2 * districtPadding;
    districtOrigins.set(name, { x: minX + districtPadding, z: minZ + districtPadding });
    return { name, minX, maxX: minX + blockWidth, minZ, maxZ: minZ + depth };
  });

  // Sorted by id so the output never depends on the order hosts arrived in.
  const sortedHosts = [...hosts].sort((a, b) => a.id.localeCompare(b.id));
  const towers: TowerPlacement[] = sortedHosts.map((host) => {
    const origin = districtOrigins.get(host.district) ?? { x: 0, z: 0 };
    const slot = slots[host.id] ?? 0;
    return {
      hostId: host.id,
      district: host.district,
      x: origin.x + (slot % districtColumns) * slotSpacing,
      z: origin.z + Math.floor(slot / districtColumns) * slotSpacing,
    };
  });

  return centerLayout(towers, districts);
}

/** Moves the city so its center sits at the world origin. */
function centerLayout(towers: TowerPlacement[], districts: DistrictPlacement[]): CityLayout {
  if (districts.length === 0) {
    return { towers, districts, bounds: { minX: 0, maxX: 0, minZ: 0, maxZ: 0 } };
  }
  const minX = Math.min(...districts.map((d) => d.minX));
  const maxX = Math.max(...districts.map((d) => d.maxX));
  const minZ = Math.min(...districts.map((d) => d.minZ));
  const maxZ = Math.max(...districts.map((d) => d.maxZ));
  const offsetX = (minX + maxX) / 2;
  const offsetZ = (minZ + maxZ) / 2;

  return {
    towers: towers.map((t) => ({ ...t, x: t.x - offsetX, z: t.z - offsetZ })),
    districts: districts.map((d) => ({
      ...d,
      minX: d.minX - offsetX,
      maxX: d.maxX - offsetX,
      minZ: d.minZ - offsetZ,
      maxZ: d.maxZ - offsetZ,
    })),
    bounds: {
      minX: minX - offsetX,
      maxX: maxX - offsetX,
      minZ: minZ - offsetZ,
      maxZ: maxZ - offsetZ,
    },
  };
}
