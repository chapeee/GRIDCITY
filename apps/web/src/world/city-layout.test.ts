import { describe, expect, it } from 'vitest';
import { assignSlots, computeCityLayout, type LayoutHost } from './city-layout';

const dimensions = { slotSpacing: 10, districtColumns: 2, districtGap: 20, districtPadding: 5 };

const hosts: LayoutHost[] = [
  { id: 'b', district: 'east' },
  { id: 'a', district: 'east' },
  { id: 'c', district: 'west' },
];

describe('assignSlots', () => {
  it('assigns slots in id order per district on first run', () => {
    expect(assignSlots(hosts, {})).toEqual({ a: 0, b: 1, c: 0 });
  });

  it('keeps existing slots when a new host appears', () => {
    const before = { a: 0, b: 1, c: 0 };
    const after = assignSlots([...hosts, { id: '0-new', district: 'east' }], before);
    expect(after).toMatchObject(before);
    expect(after['0-new']).toBe(2);
  });

  it('reuses a freed slot for the next new host', () => {
    const after = assignSlots(
      [
        { id: 'b', district: 'east' },
        { id: 'z', district: 'east' },
      ],
      { a: 0, b: 1 },
    );
    expect(after).toEqual({ b: 1, z: 0 });
  });

  it('resolves duplicate previous slots deterministically', () => {
    expect(assignSlots(hosts, { a: 0, b: 0, c: 0 })).toEqual({ a: 0, b: 1, c: 0 });
  });
});

describe('computeCityLayout', () => {
  it('places districts in name order and centers the city', () => {
    const layout = computeCityLayout(hosts, assignSlots(hosts, {}), dimensions);
    expect(layout.districts.map((d) => d.name)).toEqual(['east', 'west']);
    expect(layout.bounds.minX).toBeCloseTo(-layout.bounds.maxX);
    expect(layout.bounds.minZ).toBeCloseTo(-layout.bounds.maxZ);
  });

  it('puts towers in their slot grid inside the district outline', () => {
    const layout = computeCityLayout(hosts, assignSlots(hosts, {}), dimensions);
    const a = layout.towers.find((t) => t.hostId === 'a');
    const b = layout.towers.find((t) => t.hostId === 'b');
    const east = layout.districts.find((d) => d.name === 'east');
    expect(b!.x - a!.x).toBe(10);
    expect(a!.z).toBe(b!.z);
    expect(a!.x).toBeGreaterThan(east!.minX);
    expect(b!.x).toBeLessThan(east!.maxX);
  });

  it('is deterministic', () => {
    const slots = assignSlots(hosts, {});
    expect(computeCityLayout(hosts, slots, dimensions)).toEqual(
      computeCityLayout([...hosts].reverse(), slots, dimensions),
    );
  });

  it('handles an empty fleet', () => {
    expect(computeCityLayout([], {}, dimensions).towers).toEqual([]);
  });
});
