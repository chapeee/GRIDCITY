/**
 * Sticky layout slots. Each host owns a numbered slot in its district: once
 * assigned, a host keeps its slot, and new hosts take the lowest free one, so
 * adding a host never moves anyone else. The server persists assignments;
 * the client turns slots into positions.
 */

export interface LayoutHost {
  id: string;
  district: string;
}

/** Host id -> slot number within its district. */
export type SlotAssignments = Record<string, number>;

/** Keeps existing slots and gives new hosts the lowest free slot in their district. */
export function assignSlots(
  hosts: readonly LayoutHost[],
  previous: SlotAssignments,
): SlotAssignments {
  const assignments: SlotAssignments = {};
  const takenByDistrict = new Map<string, Set<number>>();
  const taken = (district: string) => {
    let set = takenByDistrict.get(district);
    if (!set) takenByDistrict.set(district, (set = new Set()));
    return set;
  };

  const sorted = [...hosts].sort((a, b) => a.id.localeCompare(b.id));

  // First pass: honor previous slots (first host by id wins a conflict).
  for (const host of sorted) {
    const slot = previous[host.id];
    if (slot === undefined || taken(host.district).has(slot)) continue;
    assignments[host.id] = slot;
    taken(host.district).add(slot);
  }

  // Second pass: new hosts fill the lowest free slots, in id order.
  for (const host of sorted) {
    if (assignments[host.id] !== undefined) continue;
    const used = taken(host.district);
    let slot = 0;
    while (used.has(slot)) slot++;
    assignments[host.id] = slot;
    used.add(slot);
  }

  return assignments;
}
