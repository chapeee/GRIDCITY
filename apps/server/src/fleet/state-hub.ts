import {
  assignSlots,
  PROTOCOL_VERSION,
  type HostState,
  type ResourceState,
  type ServerMessage,
  type SlotAssignments,
} from '@app/shared';
import type { LayoutStore } from '../storage/layout-store';
import type { SampleHistory } from '../storage/sample-history';
import type { FleetEvent, FleetProvider } from './fleet-provider';
import { EmptyResourceProvider, type ResourceEvent, type ResourceProvider } from './resource-fleet';

export type MessageSink = (message: ServerMessage) => void;

export interface StateHubOptions {
  provider: FleetProvider;
  /** Databases, RDS and buckets (optional; none by default). */
  resources?: ResourceProvider;
  projectName: string;
  layoutStore?: LayoutStore;
  history?: SampleHistory;
  now?: () => number;
  /** How often staleness is re-evaluated even without new data, ms. */
  staleCheckIntervalMs?: number;
}

type HostKeyRefusedMessage = Extract<ServerMessage, { type: 'hostKeyRefused' }>;

/**
 * Fans fleet state out to WebSocket clients: `hello` and `snapshot` on
 * subscribe, then only the hosts and resources whose state actually changed.
 * Staleness is re-checked every second so a silent host freezes on time.
 */
export class StateHub {
  private readonly sinks = new Set<MessageSink>();
  private lastSent = new Map<string, string>();
  private lastSentResources = new Map<string, string>();
  private readonly refusals = new Map<string, HostKeyRefusedMessage>();
  private layoutSlots: SlotAssignments;
  private provider: FleetProvider;
  private resourceProvider: ResourceProvider;
  /** Problems in hosts.yaml, replayed to every client until fixed. */
  private configErrors: string[] = [];
  /** Problems in resources.yaml, replayed the same way. */
  private resourceConfigErrors: string[] = [];
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: StateHubOptions) {
    this.now = options.now ?? Date.now;
    this.provider = options.provider;
    this.resourceProvider = options.resources ?? new EmptyResourceProvider(this.provider.dataMode);
    this.layoutSlots = this.assignLayout();
  }

  /** The fleet currently being served (it changes when hosts.yaml reloads). */
  get currentProvider(): FleetProvider {
    return this.provider;
  }

  /** The resource source currently being served (it changes when resources.yaml reloads). */
  get currentResources(): ResourceProvider {
    return this.resourceProvider;
  }

  start(): void {
    this.startProvider(this.provider);
    this.startResources(this.resourceProvider);
    this.staleTimer = setInterval(
      () => this.publishChanges(),
      this.options.staleCheckIntervalMs ?? 1000,
    );
  }

  stop(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    this.provider.stop();
    this.resourceProvider.stop();
    this.options.history?.flush(this.now());
  }

  /**
   * Swaps in a new fleet (hosts.yaml changed). Every client receives a fresh
   * hello and snapshot, so nothing from the old fleet lingers.
   */
  replaceProvider(provider: FleetProvider): void {
    this.provider.stop();
    this.provider = provider;
    this.layoutSlots = this.assignLayout();
    this.lastSent = new Map();
    this.refusals.clear();
    this.startProvider(provider);
    for (const sink of this.sinks) this.sendWelcome(sink);
  }

  /** Swaps the resource source (resources.yaml changed). */
  replaceResources(resources: ResourceProvider): void {
    this.resourceProvider.stop();
    this.resourceProvider = resources;
    this.relayoutAndResnapshot();
    this.startResources(resources);
  }

  /** Reports hosts.yaml problems to every client (empty list clears them). */
  setConfigErrors(errors: string[]): void {
    this.configErrors = errors;
    for (const sink of this.sinks) this.sendConfigErrors(sink);
  }

  /** Reports resources.yaml problems to every client (empty list clears them). */
  setResourceConfigErrors(errors: string[]): void {
    this.resourceConfigErrors = errors;
    for (const sink of this.sinks) this.sendConfigErrors(sink);
  }

  /** Registers a client and sends it the full picture. Returns an unsubscribe function. */
  subscribe(sink: MessageSink): () => void {
    this.sendWelcome(sink);
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** Full state for one client (initial connect or `resync`). */
  sendSnapshot(sink: MessageSink): void {
    const now = this.now();
    sink({
      type: 'snapshot',
      hosts: [...this.provider.hosts],
      states: this.provider.currentStates(now),
      layoutSlots: this.layoutSlots,
      resources: this.resourceProvider.resources(),
      resourceStates: this.resourceProvider.currentStates(now),
    });
    for (const refusal of this.refusals.values()) sink(refusal);
  }

  private sendWelcome(sink: MessageSink): void {
    sink({
      type: 'hello',
      protocolVersion: PROTOCOL_VERSION,
      dataMode: this.provider.dataMode,
      projectName: this.options.projectName,
      thresholds: this.provider.thresholds,
    });
    this.sendSnapshot(sink);
    this.sendConfigErrors(sink);
  }

  private sendConfigErrors(sink: MessageSink): void {
    const parts: string[] = [];
    if (this.configErrors.length > 0) {
      parts.push(
        `hosts.yaml has errors; showing the last valid fleet:\n${this.configErrors.join('\n')}`,
      );
    }
    if (this.resourceConfigErrors.length > 0) {
      parts.push(
        `resources.yaml has errors; showing the last valid resources:\n${this.resourceConfigErrors.join('\n')}`,
      );
    }
    if (parts.length > 0) sink({ type: 'error', message: parts.join('\n\n') });
  }

  private startProvider(provider: FleetProvider): void {
    provider.start((event) => {
      // Ignore late events from a provider that was just replaced.
      if (provider === this.provider) this.handleFleetEvent(event);
    });
  }

  private startResources(resources: ResourceProvider): void {
    resources.start((event: ResourceEvent) => {
      if (resources !== this.resourceProvider) return;
      if (event.type === 'resourcesChanged') this.relayoutAndResnapshot();
      else this.publishChanges();
    });
  }

  /** Discovery found or lost resources: new slots and a fresh snapshot for everyone. */
  private relayoutAndResnapshot(): void {
    this.layoutSlots = this.assignLayout();
    this.lastSentResources = new Map(
      this.resourceProvider
        .currentStates(this.now())
        .map((state) => [state.resourceId, JSON.stringify(state)]),
    );
    for (const sink of this.sinks) this.sendSnapshot(sink);
  }

  /** Hosts and resources share districts, so they share one slot assignment. */
  private assignLayout(): SlotAssignments {
    const { layoutStore } = this.options;
    const items = [
      ...this.provider.hosts,
      ...this.resourceProvider.resources().map(({ id, district }) => ({ id, district })),
    ];
    const slots = assignSlots(items, layoutStore?.load(this.provider.dataMode) ?? {});
    layoutStore?.save(this.provider.dataMode, slots);
    return slots;
  }

  private handleFleetEvent(event: FleetEvent): void {
    if (event.type === 'hostKeyRefused') {
      const message: HostKeyRefusedMessage = { ...event };
      this.refusals.set(event.hostId, message);
      this.broadcast(message);
      return;
    }
    this.publishChanges();
  }

  /** Sends only hosts and resources whose state differs from what clients last received. */
  private publishChanges(): void {
    const now = this.now();
    const changed: HostState[] = [];
    const next = new Map<string, string>();
    for (const state of this.provider.currentStates(now)) {
      const serialized = JSON.stringify(state);
      next.set(state.hostId, serialized);
      if (this.lastSent.get(state.hostId) !== serialized) changed.push(state);
      if (state.status !== 'offline' && state.lastSeenAt !== null)
        this.refusals.delete(state.hostId);
    }
    this.lastSent = next;
    if (changed.length > 0) {
      for (const state of changed) this.options.history?.record(state);
      this.broadcast({ type: 'hostStates', states: changed });
    }

    const changedResources: ResourceState[] = [];
    const nextResources = new Map<string, string>();
    for (const state of this.resourceProvider.currentStates(now)) {
      const serialized = JSON.stringify(state);
      nextResources.set(state.resourceId, serialized);
      if (this.lastSentResources.get(state.resourceId) !== serialized) changedResources.push(state);
    }
    this.lastSentResources = nextResources;
    if (changedResources.length > 0) {
      this.broadcast({ type: 'resourceStates', states: changedResources });
    }
  }

  private broadcast(message: ServerMessage): void {
    for (const sink of this.sinks) sink(message);
  }
}
