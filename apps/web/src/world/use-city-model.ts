import type { Host } from '@app/shared';
import { useEffect, useMemo } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { cityGeometry } from '../design/tokens';
import { readStoredJson, writeStoredJson } from '../ui/browser-storage';
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
  const dataMode = useFleetStore((store) => store.dataMode);
  const now = useNow(1000);

  // Slot assignments are kept per data mode so demo and real layouts never mix.
  const storageKey = `city-layout-slots:${dataMode ?? 'none'}`;
  const slots = useMemo<SlotAssignments>(
    () => assignSlots(hosts, readStoredJson<SlotAssignments>(storageKey, {})),
    [hosts, storageKey],
  );
  useEffect(() => {
    if (dataMode && hosts.length > 0) writeStoredJson(storageKey, slots);
  }, [dataMode, hosts.length, slots, storageKey]);

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
