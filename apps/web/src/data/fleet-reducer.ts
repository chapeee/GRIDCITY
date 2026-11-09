import {
  DEFAULT_STATUS_THRESHOLDS,
  PROTOCOL_VERSION,
  usagePercent,
  type DataMode,
  type Host,
  type HostState,
  type ServerMessage,
  type SlotAssignments,
  type StatusThresholds,
} from '@app/shared';

/** One point of history per successful poll, for the HUD sparklines. */
export interface MetricSample {
  /** Epoch ms of the poll (the host state's `lastSeenAt`). */
  at: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  /** Sum of rx + tx over all interfaces; null while unknown. */
  networkBytesPerSec: number | null;
}

export interface HostKeyRefusal {
  reason: 'unknown' | 'changed';
  fingerprint: string;
}

/** Everything the client knows about the fleet. Mirrors server state. */
export interface FleetSnapshot {
  dataMode: DataMode | null;
  projectName: string | null;
  thresholds: StatusThresholds;
  /** True when the server speaks a different protocol version. */
  protocolMismatch: boolean;
  hosts: Host[];
  /** Sticky layout slots from the server. */
  layoutSlots: SlotAssignments;
  states: Record<string, HostState>;
  history: Record<string, MetricSample[]>;
  hostKeyRefusals: Record<string, HostKeyRefusal>;
  lastError: string | null;
}

/** Samples kept per host: 3 minutes at the default 2 s poll interval. */
export const HISTORY_LENGTH = 90;

export const EMPTY_FLEET: FleetSnapshot = {
  dataMode: null,
  projectName: null,
  thresholds: DEFAULT_STATUS_THRESHOLDS,
  protocolMismatch: false,
  hosts: [],
  layoutSlots: {},
  states: {},
  history: {},
  hostKeyRefusals: {},
  lastError: null,
};

/** Applies one server message. Pure: returns a new snapshot. */
export function reduceFleet(fleet: FleetSnapshot, message: ServerMessage): FleetSnapshot {
  switch (message.type) {
    case 'hello': {
      // Never mix demo and real data: a mode change wipes everything.
      const base =
        fleet.dataMode !== null && fleet.dataMode !== message.dataMode ? EMPTY_FLEET : fleet;
      return {
        ...base,
        dataMode: message.dataMode,
        projectName: message.projectName,
        thresholds: message.thresholds,
        protocolMismatch: message.protocolVersion !== PROTOCOL_VERSION,
        // The server re-sends current config errors right after hello.
        lastError: null,
      };
    }

    case 'snapshot': {
      const ids = new Set(message.hosts.map((host) => host.id));
      const history = keepKeys(fleet.history, ids);
      const states: Record<string, HostState> = {};
      for (const state of message.states) {
        states[state.hostId] = state;
        history[state.hostId] = appendSample(history[state.hostId], state);
      }
      return {
        ...fleet,
        hosts: message.hosts,
        layoutSlots: message.layoutSlots,
        states,
        history,
        hostKeyRefusals: keepKeys(fleet.hostKeyRefusals, ids),
      };
    }

    case 'hostStates': {
      const states = { ...fleet.states };
      const history = { ...fleet.history };
      let hostKeyRefusals = fleet.hostKeyRefusals;
      for (const state of message.states) {
        states[state.hostId] = state;
        history[state.hostId] = appendSample(history[state.hostId], state);
        // A host that is connected and polled again has had its key accepted.
        if (hostKeyRefusals[state.hostId] && isReachable(state)) {
          hostKeyRefusals = { ...hostKeyRefusals };
          delete hostKeyRefusals[state.hostId];
        }
      }
      return { ...fleet, states, history, hostKeyRefusals };
    }

    case 'hostRemoved': {
      const remaining = new Set(fleet.hosts.map((host) => host.id));
      remaining.delete(message.hostId);
      return {
        ...fleet,
        hosts: fleet.hosts.filter((host) => host.id !== message.hostId),
        states: keepKeys(fleet.states, remaining),
        history: keepKeys(fleet.history, remaining),
        hostKeyRefusals: keepKeys(fleet.hostKeyRefusals, remaining),
      };
    }

    case 'hostKeyRefused':
      return {
        ...fleet,
        hostKeyRefusals: {
          ...fleet.hostKeyRefusals,
          [message.hostId]: { reason: message.reason, fingerprint: message.fingerprint },
        },
      };

    case 'error':
      return { ...fleet, lastError: message.message };
  }
}

function isReachable(state: HostState): boolean {
  return state.status === 'online' || state.status === 'degraded';
}

/**
 * Adds a history point only for a *new* poll. Re-sent states (e.g. a stale
 * host) do not duplicate points, so sparklines never invent data.
 */
function appendSample(samples: MetricSample[] = [], state: HostState): MetricSample[] {
  if (state.lastSeenAt === null) return samples;
  const last = samples.at(-1);
  if (last && last.at >= state.lastSeenAt) return samples;

  const sample: MetricSample = {
    at: state.lastSeenAt,
    cpuPercent: state.cpuPercent,
    memoryPercent: state.memory ? usagePercent(state.memory) : null,
    networkBytesPerSec:
      state.network.length > 0
        ? state.network.reduce((sum, rate) => sum + rate.rxBytesPerSec + rate.txBytesPerSec, 0)
        : null,
  };
  const next = [...samples, sample];
  return next.length > HISTORY_LENGTH ? next.slice(next.length - HISTORY_LENGTH) : next;
}

function keepKeys<T>(record: Record<string, T>, keys: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => keys.has(key)));
}
