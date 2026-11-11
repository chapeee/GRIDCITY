import type { DataMode, Host, HostState, StatusThresholds } from '@app/shared';
import type { HostInventory } from '../metrics/parse-inventory';

export type FleetEvent =
  /** Some host state may have changed; the hub recomputes and diffs. */
  | { type: 'changed' }
  /** A discovery round finished on a host: services and connections may have changed. */
  | { type: 'discovered'; hostId: string }
  | { type: 'hostKeyRefused'; hostId: string; reason: 'unknown' | 'changed'; fingerprint: string };

export type FleetListener = (event: FleetEvent) => void;

/**
 * A source of fleet state: real SSH hosts or the demo fleet. Exactly one
 * runs per server process, and it announces its data mode, so real and demo
 * data never mix.
 */
export interface FleetProvider {
  readonly dataMode: DataMode;
  readonly hosts: readonly Host[];
  readonly thresholds: StatusThresholds;
  start(listener: FleetListener): void;
  stop(): void;
  /** Current state of every host. Staleness is evaluated against `now`. */
  currentStates(now: number): HostState[];
  /** Latest discovery round per host, for the topology (real fleets only). */
  inventories?(): ReadonlyMap<string, HostInventory>;
}
