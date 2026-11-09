import type { Host } from '@app/shared';
import { useMemo } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { cityGeometry } from '../design/tokens';
import { useNow } from '../ui/use-now';
import {
  assignSlots,
  computeCityLayout,
  type CityLayout,
  type SlotAssignments,
} from './city-layout';
import { computeHostVisual, type HostVisual } from './host-visuals';

/** Everything the 3D scene needs, derived from the fleet store. */
export interface CityModel {
  hosts: Host[];
  layout: CityLayout;
  visuals: ReadonlyMap<string, HostVisual>;
  /** Host ids in reading order (district, then row, then column), for Tab navigation. */
  navigationOrder: string[];
}

/**
 * Derives layout and visual encodings from fleet data. Pure computation; the
 * scene components only render what this returns.
 */
export function useCityModel(): CityModel {
  const hosts = useFleetStore((store) => store.hosts);
  const states = useFleetStore((store) => store.states);
  const thresholds = useFleetStore((store) => store.thresholds);
  const layoutSlots = useFleetStore((store) => store.layoutSlots);
  const now = useNow(1000);

  // The server persists slots; assignSlots only fills in hosts it has not
  // assigned yet (e.g. between a config change and the next snapshot).
  const slots = useMemo<SlotAssignments>(
    () => assignSlots(hosts, layoutSlots),
    [hosts, layoutSlots],
  );

  const layout = useMemo(() => computeCityLayout(hosts, slots, cityGeometry), [hosts, slots]);

  const visuals = useMemo(
    () =>
      new Map(hosts.map((host) => [host.id, computeHostVisual(states[host.id], now, thresholds)])),
    [hosts, states, now, thresholds],
  );

  const navigationOrder = useMemo(
    () =>
      [...layout.towers]
        .sort((a, b) => a.district.localeCompare(b.district) || a.z - b.z || a.x - b.x)
        .map((tower) => tower.hostId),
    [layout],
  );

  return { hosts, layout, visuals, navigationOrder };
}
