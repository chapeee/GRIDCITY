import {
  DEFAULT_STATUS_THRESHOLDS,
  PROTOCOL_VERSION,
  usagePercent,
  type DataMode,
  type District,
  type Host,
  type Link,
  type Runbook,
  type HostState,
  type Resource,
  type ResourceState,
  type ServerMessage,
  type SlotAssignments,
  type StatusThresholds,
  type ThreatFinding,
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
  /** Databases, RDS instances and buckets (protocol v2). */
  resources: Resource[];
  resourceStates: Record<string, ResourceState>;
  /** One point per resource poll: its main metric, for the HUD sparkline. */
  resourceHistory: Record<string, ResourceSample[]>;
  /** Every district something lives in (protocol v3). */
  districts: District[];
  /** Topology: who uses whom (protocol v3). */
  links: Link[];
  runbooks: Runbook[];
  /** Open attack and exposure findings (protocol v4). */
  threats: ThreatFinding[];
  lastError: string | null;
}

export interface ResourceSample {
  at: number;
  /** ops/s, CPU % (RDS) or stored bytes (buckets, SQLite); null while unknown. */
  value: number | null;
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
  resources: [],
  resourceStates: {},
  resourceHistory: {},
  districts: [],
  links: [],
  runbooks: [],
  threats: [],
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
        ...applyResourceSnapshot(fleet, message.resources, message.resourceStates),
        districts: message.districts,
        links: message.links,
        runbooks: message.runbooks,
        threats: message.threats,
      };
    }

    case 'threats':
      return { ...fleet, threats: message.findings };

    case 'links':
      return { ...fleet, links: message.links };

    case 'resourceStates': {
      const resourceStates = { ...fleet.resourceStates };
      const resourceHistory = { ...fleet.resourceHistory };
      const known = new Set(fleet.resources.map((resource) => resource.id));
      for (const state of message.states) {
        if (!known.has(state.resourceId)) continue;
        resourceStates[state.resourceId] = state;
        resourceHistory[state.resourceId] = appendResourceSample(
          resourceHistory[state.resourceId],
          state,
        );
      }
      return { ...fleet, resourceStates, resourceHistory };
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

function applyResourceSnapshot(
  fleet: FleetSnapshot,
  resources: Resource[],
  states: ResourceState[],
): Pick<FleetSnapshot, 'resources' | 'resourceStates' | 'resourceHistory'> {
  const ids = new Set(resources.map((resource) => resource.id));
  const resourceHistory = keepKeys(fleet.resourceHistory, ids);
  const resourceStates: Record<string, ResourceState> = {};
  for (const state of states) {
    if (!ids.has(state.resourceId)) continue;
    resourceStates[state.resourceId] = state;
    resourceHistory[state.resourceId] = appendResourceSample(
      resourceHistory[state.resourceId],
      state,
    );
  }
  return { resources, resourceStates, resourceHistory };
}

/** The value a resource's sparkline follows (same as its pulse or roof light). */
export function resourceHeadline(state: ResourceState): number | null {
  const { gauges } = state;
  return gauges.opsPerSec ?? gauges.cpuPercent ?? gauges.storage?.usedBytes ?? null;
}

function appendResourceSample(
  samples: ResourceSample[] = [],
  state: ResourceState,
): ResourceSample[] {
  if (state.lastSeenAt === null || state.status === 'offline') return samples;
  const last = samples.at(-1);
  if (last && last.at >= state.lastSeenAt) return samples;
  const next = [...samples, { at: state.lastSeenAt, value: resourceHeadline(state) }];
  return next.length > HISTORY_LENGTH ? next.slice(next.length - HISTORY_LENGTH) : next;
}

function keepKeys<T>(record: Record<string, T>, keys: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => keys.has(key)));
}
