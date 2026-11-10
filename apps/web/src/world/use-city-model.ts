import {
  DEFAULT_RESOURCE_THRESHOLDS,
  RESOURCE_SHAPES,
  type Host,
  type Resource,
} from '@app/shared';
import { useMemo } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { cityGeometry } from '../design/tokens';
import { useNow } from '../ui/use-now';
import {
  assignSlots,
  computeCityLayout,
  type BuildingShape,
  type CityLayout,
  type SlotAssignments,
} from './city-layout';
import { computeHostVisual, type HostVisual } from './host-visuals';
import { computeResourceVisual } from './resource-visuals';

/** Everything the 3D scene needs, derived from the fleet store. */
export interface CityModel {
  hosts: Host[];
  resources: Resource[];
  layout: CityLayout;
  visuals: ReadonlyMap<string, HostVisual>;
  /** Host and resource ids in reading order (district, then row, then column), for Tab navigation. */
  navigationOrder: string[];
}

/**
 * Derives layout and visual encodings from fleet data. Pure computation; the
 * scene components only render what this returns. Hosts and resources share
 * districts and slots, each with its own fixed shape.
 */
export function useCityModel(): CityModel {
  const hosts = useFleetStore((store) => store.hosts);
  const states = useFleetStore((store) => store.states);
  const resources = useFleetStore((store) => store.resources);
  const resourceStates = useFleetStore((store) => store.resourceStates);
  const thresholds = useFleetStore((store) => store.thresholds);
  const layoutSlots = useFleetStore((store) => store.layoutSlots);
  const now = useNow(1000);

  const items = useMemo(
    () => [
      ...hosts.map(({ id, district }) => ({ id, district })),
      ...resources.map(({ id, district }) => ({ id, district })),
    ],
    [hosts, resources],
  );

  // The server persists slots; assignSlots only fills in items it has not
  // assigned yet (e.g. between a config change and the next snapshot).
  const slots = useMemo<SlotAssignments>(
    () => assignSlots(items, layoutSlots),
    [items, layoutSlots],
  );

  const layout = useMemo(() => {
    const computed = computeCityLayout(items, slots, cityGeometry);
    const shapes = new Map<string, { shape: BuildingShape; label: string }>(
      resources.map((resource) => [
        resource.id,
        { shape: RESOURCE_SHAPES[resource.kind], label: resource.name },
      ]),
    );
    return {
      ...computed,
      towers: computed.towers.map((tower) => ({
        ...tower,
        shape: shapes.get(tower.hostId)?.shape ?? 'tower',
        label: shapes.get(tower.hostId)?.label ?? tower.hostId,
      })),
    };
  }, [items, slots, resources]);

  const visuals = useMemo(
    () =>
      new Map([
        ...hosts.map(
          (host) => [host.id, computeHostVisual(states[host.id], now, thresholds)] as const,
        ),
        ...resources.map(
          (resource) =>
            [
              resource.id,
              computeResourceVisual(
                resource,
                resourceStates[resource.id],
                now,
                DEFAULT_RESOURCE_THRESHOLDS.staleAfterPolls,
              ),
            ] as const,
        ),
      ]),
    [hosts, states, resources, resourceStates, now, thresholds],
  );

  const navigationOrder = useMemo(
    () =>
      [...layout.towers]
        .sort((a, b) => a.district.localeCompare(b.district) || a.z - b.z || a.x - b.x)
        .map((tower) => tower.hostId),
    [layout],
  );

  return { hosts, resources, layout, visuals, navigationOrder };
}
