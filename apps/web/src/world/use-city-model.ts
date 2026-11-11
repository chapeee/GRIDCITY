import {
  DEFAULT_RESOURCE_THRESHOLDS,
  RESOURCE_SHAPES,
  replayHostState,
  replayResourceState,
  thresholdsForHost,
  type District,
  type Host,
  type HostStatus,
  type Link,
  type Resource,
} from '@app/shared';
import { useMemo } from 'react';
import { useFleetStore } from '../data/fleet-store';
import { useReplayStore } from '../data/replay-store';
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
import { districtTone, type DistrictTone } from './district-visuals';

/** Everything the 3D scene needs, derived from the fleet store. */
export interface CityModel {
  hosts: Host[];
  resources: Resource[];
  districts: District[];
  links: Link[];
  layout: CityLayout;
  visuals: ReadonlyMap<string, HostVisual>;
  /** District name -> the tone of its plate edge (attention, online, unknown). */
  districtTones: ReadonlyMap<string, DistrictTone>;
  /** Building id -> its status right now (or at the replayed moment). */
  statuses: ReadonlyMap<string, HostStatus>;
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
  const liveStates = useFleetStore((store) => store.states);
  const resources = useFleetStore((store) => store.resources);
  const liveResourceStates = useFleetStore((store) => store.resourceStates);
  // Time travel swaps the whole picture for a recorded moment, never a mix.
  const replayFrame = useReplayStore((store) => (store.active ? store.frame : null));
  const states = useMemo(
    () =>
      replayFrame
        ? Object.fromEntries(
            hosts.map((h) => [
              h.id,
              replayHostState(h.id, replayFrame.hosts[h.id], replayFrame.at),
            ]),
          )
        : liveStates,
    [replayFrame, hosts, liveStates],
  );
  const resourceStates = useMemo(
    () =>
      replayFrame
        ? Object.fromEntries(
            resources.map((r) => [
              r.id,
              replayResourceState(r.id, replayFrame.resources[r.id], replayFrame.at),
            ]),
          )
        : liveResourceStates,
    [replayFrame, resources, liveResourceStates],
  );
  const districts = useFleetStore((store) => store.districts);
  const links = useFleetStore((store) => store.links);
  const thresholds = useFleetStore((store) => store.thresholds);
  const layoutSlots = useFleetStore((store) => store.layoutSlots);
  const clock = useNow(1000);
  const now = replayFrame ? replayFrame.at : clock;

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
          (host) =>
            [
              host.id,
              computeHostVisual(states[host.id], now, thresholdsForHost(thresholds, host)),
            ] as const,
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

  const statuses = useMemo(
    () =>
      new Map<string, HostStatus>([
        ...hosts.map((h) => [h.id, states[h.id]?.status ?? 'unknown'] as const),
        ...resources.map((r) => [r.id, resourceStates[r.id]?.status ?? 'unknown'] as const),
      ]),
    [hosts, resources, states, resourceStates],
  );
  const districtTones = useMemo(() => {
    const members = new Map<string, { status: HostStatus; stale: boolean }[]>();
    const add = (district: string, status: HostStatus, frozen: boolean) => {
      const list = members.get(district) ?? [];
      list.push({ status, stale: frozen });
      members.set(district, list);
    };
    for (const h of hosts)
      add(h.district, statuses.get(h.id) ?? 'unknown', visuals.get(h.id)?.frozen ?? false);
    for (const r of resources)
      add(r.district, statuses.get(r.id) ?? 'unknown', visuals.get(r.id)?.frozen ?? false);
    return new Map(layout.districts.map((d) => [d.name, districtTone(members.get(d.name) ?? [])]));
  }, [hosts, resources, statuses, visuals, layout.districts]);

  return {
    hosts,
    resources,
    districts,
    links,
    layout,
    visuals,
    navigationOrder,
    statuses,
    districtTones,
  };
}
