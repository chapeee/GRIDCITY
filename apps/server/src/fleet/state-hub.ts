import {
  assignSlots,
  PROTOCOL_VERSION,
  resolveDistricts,
  type District,
  type HostState,
  type HostStatus,
  type Link,
  type ResourceState,
  type Runbook,
  type ServerMessage,
  type SlotAssignments,
} from '@app/shared';
import type { AlertEvent } from '../alerts/webhook';
import type { LayoutStore } from '../storage/layout-store';
import type { SampleHistory } from '../storage/sample-history';
import type { StatusEvents } from '../storage/status-events';
import type { FleetEvent, FleetProvider } from './fleet-provider';
import { EmptyResourceProvider, type ResourceEvent, type ResourceProvider } from './resource-fleet';
import { computeLinks, hostnamesToResolve } from './topology';

export type MessageSink = (message: ServerMessage) => void;

export interface StateHubOptions {
  provider: FleetProvider;
  /** Databases, RDS, buckets, probes and load balancers (optional; none by default). */
  resources?: ResourceProvider;
  projectName: string;
  layoutStore?: LayoutStore;
  history?: SampleHistory;
  /** Status transitions (incidents) for the history panel; real mode only. */
  statusEvents?: StatusEvents;
  /** Declared districts (districts.yaml); labels without an entry are inferred. */
  districts?: readonly District[];
  runbooks?: readonly Runbook[];
  /** Links the provider already knows (demo mode); real mode computes them. */
  fixedLinks?: (now: number) => Link[];
  /** Resolves a hostname to IPs for matching connections; never called when absent. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Called on every real status transition (webhook alerts). */
  onTransition?: (event: AlertEvent) => void;
  now?: () => number;
  /** How often staleness is re-evaluated even without new data, ms. */
  staleCheckIntervalMs?: number;
}

type HostKeyRefusedMessage = Extract<ServerMessage, { type: 'hostKeyRefused' }>;

/** Observed links disappear once they have not been seen for this many discovery rounds. */
const OBSERVED_LINK_TTL_ROUNDS = 4;
/** DNS results for matching are refreshed this often. */
const RESOLVE_INTERVAL_MS = 10 * 60_000;

/**
 * Fans fleet state out to WebSocket clients: `hello` and `snapshot` on
 * subscribe, then only the hosts and resources whose state actually changed,
 * plus the topology when a link appears or fades. Staleness is re-checked
 * every second so a silent host freezes on time.
 */
export class StateHub {
  private readonly sinks = new Set<MessageSink>();
  private lastSent = new Map<string, string>();
  private lastSentResources = new Map<string, string>();
  private lastStatus = new Map<string, HostStatus>();
  private readonly refusals = new Map<string, HostKeyRefusedMessage>();
  private layoutSlots: SlotAssignments;
  private provider: FleetProvider;
  private resourceProvider: ResourceProvider;
  private declaredDistricts: readonly District[];
  private runbooks: readonly Runbook[];
  /** Problems in hosts.yaml, replayed to every client until fixed. */
  private configErrors: string[] = [];
  /** Problems in resources.yaml, replayed the same way. */
  private resourceConfigErrors: string[] = [];
  /** Problems in districts.yaml / runbooks.yaml. */
  private otherConfigErrors: string[] = [];
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private resolveTimer: ReturnType<typeof setInterval> | null = null;
  private readonly resolved = new Map<string, string[]>();
  /** Observed links by id, kept across rounds so a missed `ss` does not blink them away. */
  private readonly observedLinks = new Map<string, Link>();
  private links: Link[] = [];
  private linksSignature = '';
  private readonly now: () => number;

  constructor(private readonly options: StateHubOptions) {
    this.now = options.now ?? Date.now;
    this.provider = options.provider;
    this.resourceProvider = options.resources ?? new EmptyResourceProvider(this.provider.dataMode);
    this.declaredDistricts = options.districts ?? [];
    this.runbooks = options.runbooks ?? [];
    this.layoutSlots = this.assignLayout();
    this.links = this.computeLinks();
    this.linksSignature = JSON.stringify(this.links);
  }

  /** The fleet currently being served (it changes when hosts.yaml reloads). */
  get currentProvider(): FleetProvider {
    return this.provider;
  }

  /** The resource source currently being served (it changes when resources.yaml reloads). */
  get currentResources(): ResourceProvider {
    return this.resourceProvider;
  }

  get currentRunbooks(): readonly Runbook[] {
    return this.runbooks;
  }

  get currentLinks(): readonly Link[] {
    return this.links;
  }

  /** Every district something lives in, declared ones first. */
  get currentDistricts(): District[] {
    return resolveDistricts(this.declaredDistricts, [
      ...this.provider.hosts.map((host) => host.district),
      ...this.resourceProvider.resources().map((resource) => resource.district),
    ]);
  }

  start(): void {
    this.startProvider(this.provider);
    this.startResources(this.resourceProvider);
    this.staleTimer = setInterval(
      () => this.publishChanges(),
      this.options.staleCheckIntervalMs ?? 1000,
    );
    if (this.options.resolve) {
      void this.resolveNames();
      this.resolveTimer = setInterval(() => void this.resolveNames(), RESOLVE_INTERVAL_MS);
    }
  }

  stop(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
    if (this.resolveTimer) clearInterval(this.resolveTimer);
    this.staleTimer = null;
    this.resolveTimer = null;
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
    this.observedLinks.clear();
    this.startProvider(provider);
    void this.resolveNames();
    this.refreshLinks(false);
    for (const sink of this.sinks) this.sendWelcome(sink);
  }

  /** Swaps the resource source (resources.yaml changed). */
  replaceResources(resources: ResourceProvider): void {
    this.resourceProvider.stop();
    this.resourceProvider = resources;
    void this.resolveNames();
    this.relayoutAndResnapshot();
    this.startResources(resources);
  }

  /** districts.yaml or runbooks.yaml changed. */
  replaceDeclarations(input: {
    districts?: readonly District[];
    runbooks?: readonly Runbook[];
  }): void {
    if (input.districts) this.declaredDistricts = input.districts;
    if (input.runbooks) this.runbooks = input.runbooks;
    for (const sink of this.sinks) this.sendSnapshot(sink);
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

  /** Reports districts.yaml / runbooks.yaml problems. */
  setOtherConfigErrors(errors: string[]): void {
    this.otherConfigErrors = errors;
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
      districts: this.currentDistricts,
      links: this.links,
      runbooks: [...this.runbooks],
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
    if (this.otherConfigErrors.length > 0) parts.push(this.otherConfigErrors.join('\n'));
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
      else {
        this.publishChanges();
        this.refreshLinks(true); // load balancer targets may have changed
      }
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
    this.refreshLinks(false);
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
    if (event.type === 'discovered') this.refreshLinks(true);
  }

  /** Resolves every hostname the topology may need to match (DNS, cached). */
  private async resolveNames(): Promise<void> {
    const resolve = this.options.resolve;
    if (!resolve) return;
    const names = hostnamesToResolve(this.provider.hosts, this.resourceProvider.resources());
    await Promise.all(
      names.map(async (name) => {
        try {
          const addresses = await resolve(name);
          if (addresses.length > 0) this.resolved.set(name, addresses);
        } catch {
          // Unresolvable names simply never match: no link is invented.
        }
      }),
    );
    this.refreshLinks(true);
  }

  private computeLinks(): Link[] {
    const now = this.now();
    if (this.options.fixedLinks) return this.options.fixedLinks(now);
    const inventories = this.provider.inventories?.() ?? new Map();
    const fresh = computeLinks({
      hosts: this.provider.hosts,
      resources: this.resourceProvider.resources(),
      inventories,
      peers: this.resourceProvider.peers?.() ?? [],
      resolved: this.resolved,
      now,
    });
    // Observed links fade instead of blinking: keep them until they age out.
    const ttlMs = this.provider.thresholds.discoveryIntervalMs * OBSERVED_LINK_TTL_ROUNDS;
    for (const link of fresh) {
      if (link.kind === 'observed' || link.kind === 'balances')
        this.observedLinks.set(link.id, link);
    }
    const ids = new Set([
      ...this.provider.hosts.map((h) => h.id),
      ...this.resourceProvider.resources().map((r) => r.id),
    ]);
    for (const [id, link] of this.observedLinks) {
      if ((link.lastSeenAt ?? 0) < now - ttlMs || !ids.has(link.from) || !ids.has(link.to)) {
        this.observedLinks.delete(id);
      }
    }
    const declared = fresh.filter((link) => link.kind === 'declared' || link.kind === 'probes');
    const merged = new Map<string, Link>();
    for (const link of this.observedLinks.values()) merged.set(link.id, link);
    for (const link of declared) merged.set(link.id, link); // declared wins for the same pair
    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** Recomputes the topology and tells clients only when it changed. */
  private refreshLinks(broadcast: boolean): void {
    this.links = this.computeLinks();
    const signature = JSON.stringify(
      this.links.map((link) => [link.id, link.kind, link.label]), // lastSeenAt alone is not a change
    );
    if (signature === this.linksSignature) return;
    this.linksSignature = signature;
    if (broadcast) this.broadcast({ type: 'links', links: this.links });
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
      for (const state of changed) {
        this.options.history?.record(state);
        this.options.statusEvents?.record(state.hostId, state.status, state.statusReason, now);
        this.noteTransition(state.hostId, state.status, state.statusReason, now);
      }
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
    for (const state of changedResources) {
      this.options.statusEvents?.record(state.resourceId, state.status, state.statusReason, now);
      this.noteTransition(state.resourceId, state.status, state.statusReason, now);
    }
    if (changedResources.length > 0) {
      this.broadcast({ type: 'resourceStates', states: changedResources });
    }
  }

  /** Hands real transitions between online, degraded and offline to the alert hook. */
  private noteTransition(targetId: string, status: HostStatus, reason: string | null, at: number) {
    if (status === 'unknown') return;
    const previous = this.lastStatus.get(targetId) ?? null;
    if (previous === status) return;
    this.lastStatus.set(targetId, status);
    if (!this.options.onTransition || previous === null) return; // the first status is not news
    const host = this.provider.hosts.find((h) => h.id === targetId);
    const resource = host
      ? undefined
      : this.resourceProvider.resources().find((r) => r.id === targetId);
    this.options.onTransition({
      targetId,
      targetName: host?.name ?? resource?.name ?? targetId,
      kind: host ? 'server' : (resource?.engine ?? 'resource'),
      district: host?.district ?? resource?.district ?? '',
      from: previous,
      to: status,
      reason,
      at,
    });
  }

  private broadcast(message: ServerMessage): void {
    for (const sink of this.sinks) sink(message);
  }
}
