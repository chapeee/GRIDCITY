import {
  assignSlots,
  PROTOCOL_VERSION,
  type HostState,
  type ServerMessage,
  type SlotAssignments,
} from '@app/shared';
import type { LayoutStore } from '../storage/layout-store';
import type { SampleHistory } from '../storage/sample-history';
import type { FleetEvent, FleetProvider } from './fleet-provider';

export type MessageSink = (message: ServerMessage) => void;

export interface StateHubOptions {
  provider: FleetProvider;
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
 * subscribe, then only the hosts whose state actually changed. Staleness is
 * re-checked every second so a silent host freezes on time.
 */
export class StateHub {
  private readonly sinks = new Set<MessageSink>();
  private lastSent = new Map<string, string>();
  private readonly refusals = new Map<string, HostKeyRefusedMessage>();
  private layoutSlots: SlotAssignments;
  private provider: FleetProvider;
  /** Problems in hosts.yaml, replayed to every client until fixed. */
  private configErrors: string[] = [];
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;

  constructor(private readonly options: StateHubOptions) {
    this.now = options.now ?? Date.now;
    this.provider = options.provider;
    this.layoutSlots = this.assignLayout(this.provider);
  }

  start(): void {
    this.startProvider(this.provider);
    this.staleTimer = setInterval(
      () => this.publishChanges(),
      this.options.staleCheckIntervalMs ?? 1000,
    );
  }

  stop(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.staleTimer = null;
    this.provider.stop();
    this.options.history?.flush(this.now());
  }

  /**
   * Swaps in a new fleet (hosts.yaml changed). Every client receives a fresh
   * hello and snapshot, so nothing from the old fleet lingers.
   */
  replaceProvider(provider: FleetProvider): void {
    this.provider.stop();
    this.provider = provider;
    this.layoutSlots = this.assignLayout(provider);
    this.lastSent = new Map();
    this.refusals.clear();
    this.startProvider(provider);
    for (const sink of this.sinks) this.sendWelcome(sink);
  }

  /** Reports hosts.yaml problems to every client (empty list clears them). */
  setConfigErrors(errors: string[]): void {
    this.configErrors = errors;
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
    sink({
      type: 'snapshot',
      hosts: [...this.provider.hosts],
      states: this.provider.currentStates(this.now()),
      layoutSlots: this.layoutSlots,
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
    if (this.configErrors.length === 0) return;
    sink({
      type: 'error',
      message: `hosts.yaml has errors; showing the last valid fleet:\n${this.configErrors.join('\n')}`,
    });
  }

  private startProvider(provider: FleetProvider): void {
    provider.start((event) => {
      // Ignore late events from a provider that was just replaced.
      if (provider === this.provider) this.handleFleetEvent(event);
    });
  }

  private assignLayout(provider: FleetProvider): SlotAssignments {
    const { layoutStore } = this.options;
    const slots = assignSlots(provider.hosts, layoutStore?.load(provider.dataMode) ?? {});
    layoutStore?.save(provider.dataMode, slots);
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

  /** Sends only hosts whose state differs from what clients last received. */
  private publishChanges(): void {
    const changed: HostState[] = [];
    const next = new Map<string, string>();
    for (const state of this.provider.currentStates(this.now())) {
      const serialized = JSON.stringify(state);
      next.set(state.hostId, serialized);
      if (this.lastSent.get(state.hostId) !== serialized) changed.push(state);
      if (state.status !== 'offline' && state.lastSeenAt !== null)
        this.refusals.delete(state.hostId);
    }
    this.lastSent = next;
    if (changed.length === 0) return;
    for (const state of changed) this.options.history?.record(state);
    this.broadcast({ type: 'hostStates', states: changed });
  }

  private broadcast(message: ServerMessage): void {
    for (const sink of this.sinks) sink(message);
  }
}
