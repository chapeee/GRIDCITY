import type { ServerMessage } from '@app/shared';
import { create } from 'zustand';
import { EMPTY_FLEET, reduceFleet, type FleetSnapshot } from './fleet-reducer';

interface FleetStore extends FleetSnapshot {
  /** Feeds one server message into the store. */
  receive(message: ServerMessage): void;
}

/**
 * The single client store mirroring server state. All data logic lives in
 * the pure `reduceFleet`; this file only wires it to React.
 */
export const useFleetStore = create<FleetStore>()((set) => ({
  ...EMPTY_FLEET,
  receive: (message) => set((store) => reduceFleet(store, message)),
}));
