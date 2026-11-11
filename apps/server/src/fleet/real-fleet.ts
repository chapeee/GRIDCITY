import { thresholdsForHost, type Host, type HostState, type StatusThresholds } from '@app/shared';
import { COLLECTOR_COMMAND, COLLECTOR_SCRIPT } from '../metrics/collector-script';
import { INVENTORY_COMMAND, INVENTORY_SCRIPT } from '../metrics/inventory-script';
import { parseInventoryOutput, type HostInventory } from '../metrics/parse-inventory';
import { parseCollectorOutput } from '../metrics/parse-collector-output';
import type { HostConnection, HostConnectionOptions, PhaseChange } from '../ssh/host-connection';
import type { AuditLog } from '../storage/audit-log';
import type { FleetListener, FleetProvider } from './fleet-provider';
import {
  applyInventory,
  applyPhaseChange,
  applyPollFailure,
  applyPollSuccess,
  buildHostState,
  createHostRuntime,
  type HostRuntime,
} from './host-runtime';

export interface RealFleetOptions {
  hosts: readonly Host[];
  thresholds: StatusThresholds;
  /** Creates the connection for a host; injected so tests can point at a fake server. */
  createConnection(
    host: Host,
    onPhaseChange: HostConnectionOptions['onPhaseChange'],
  ): HostConnection;
  audit?: AuditLog;
  now?: () => number;
}

/** A poll slower than this many intervals is abandoned (the data then goes stale). */
const POLL_TIMEOUT_INTERVALS = 3;

/**
 * Real SSH hosts: one persistent connection per host, one collector exec per
 * poll interval on that connection. Nothing runs on hosts that are not
 * connected, and a poll never overlaps the previous one.
 */
export class RealFleet implements FleetProvider {
  readonly dataMode = 'real' as const;
  private readonly runtimes = new Map<string, HostRuntime>();
  private readonly connections = new Map<string, HostConnection>();
  private readonly pollsInFlight = new Set<string>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private readonly discoveriesInFlight = new Set<string>();
  private listener: FleetListener = () => {};
  private readonly now: () => number;

  constructor(private readonly options: RealFleetOptions) {
    this.now = options.now ?? Date.now;
    for (const host of options.hosts) this.runtimes.set(host.id, createHostRuntime());
  }

  get hosts(): readonly Host[] {
    return this.options.hosts;
  }

  get thresholds(): StatusThresholds {
    return this.options.thresholds;
  }

  start(listener: FleetListener): void {
    this.listener = listener;
    for (const host of this.options.hosts) {
      const connection = this.options.createConnection(host, (change) =>
        this.handlePhaseChange(host, change),
      );
      this.connections.set(host.id, connection);
      connection.start();
    }
    this.pollTimer = setInterval(() => this.pollAll(), this.options.thresholds.pollIntervalMs);
    this.discoveryTimer = setInterval(
      () => this.discoverAll(),
      this.options.thresholds.discoveryIntervalMs,
    );
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (this.discoveryTimer) clearInterval(this.discoveryTimer);
    this.discoveryTimer = null;
    for (const connection of this.connections.values()) connection.stop();
    this.connections.clear();
  }

  currentStates(now: number): HostState[] {
    return this.options.hosts.map((host) =>
      buildHostState(host.id, this.runtime(host.id), now, this.thresholdsFor(host)),
    );
  }

  /** File-wide thresholds with this host's own warning overrides (Edit) on top. */
  thresholdsFor(host: Host): StatusThresholds {
    return thresholdsForHost(this.options.thresholds, host);
  }

  /** Latest discovery round per host, for the topology. */
  inventories(): ReadonlyMap<string, HostInventory> {
    const map = new Map<string, HostInventory>();
    for (const [hostId, runtime] of this.runtimes) {
      if (runtime.inventory && runtime.connection === 'connected')
        map.set(hostId, runtime.inventory);
    }
    return map;
  }

  /** The connection for a host (used by the terminal in Phase 4, and by tests). */
  connectionFor(hostId: string): HostConnection | undefined {
    return this.connections.get(hostId);
  }

  private runtime(hostId: string): HostRuntime {
    return this.runtimes.get(hostId) ?? createHostRuntime();
  }

  private handlePhaseChange(host: Host, change: PhaseChange): void {
    const before = this.runtime(host.id);
    const after = applyPhaseChange(before, change);
    this.runtimes.set(host.id, after);
    this.auditTransition(host, before, after, change);
    if (change.hostKeyRefusal) {
      this.listener({ type: 'hostKeyRefused', hostId: host.id, ...change.hostKeyRefusal });
    }
    this.listener({ type: 'changed' });
    // Poll right away on connect instead of waiting for the next tick.
    if (change.phase === 'connected') {
      void this.poll(host);
      void this.discover(host);
    }
  }

  /** Records connection transitions, not every retry, so the log stays readable. */
  private auditTransition(
    host: Host,
    before: HostRuntime,
    after: HostRuntime,
    change: PhaseChange,
  ): void {
    const audit = this.options.audit;
    if (!audit) return;
    if (after.connection === 'connected' && before.connection !== 'connected') {
      audit.append('connection_opened', host.id, `${host.user}@${host.address}:${host.port}`);
    } else if (after.connection === 'failed' && before.connection !== 'failed') {
      if (change.hostKeyRefusal) {
        audit.append(
          'host_key_refused',
          host.id,
          `${change.hostKeyRefusal.reason} ${change.hostKeyRefusal.fingerprint}`,
        );
      } else {
        audit.append(
          before.connection === 'connected' ? 'connection_lost' : 'connection_failed',
          host.id,
          change.error,
        );
      }
    }
  }

  private pollAll(): void {
    for (const host of this.options.hosts) void this.poll(host);
  }

  private discoverAll(): void {
    for (const host of this.options.hosts) void this.discover(host);
  }

  /** Runs the discovery script (services, containers, connections); slower and tolerant. */
  async discover(host: Host): Promise<void> {
    const connection = this.connections.get(host.id);
    if (!connection || connection.phase !== 'connected' || this.discoveriesInFlight.has(host.id))
      return;
    this.discoveriesInFlight.add(host.id);
    try {
      const result = await connection.exec(INVENTORY_COMMAND, INVENTORY_SCRIPT, 20_000);
      const inventory = parseInventoryOutput(result.stdout, this.now());
      if (inventory) {
        this.runtimes.set(host.id, applyInventory(this.runtime(host.id), inventory));
        this.listener({ type: 'discovered', hostId: host.id });
      }
    } catch {
      // Discovery is best effort: the previous inventory stays and ages visibly.
    } finally {
      this.discoveriesInFlight.delete(host.id);
    }
  }

  private async poll(host: Host): Promise<void> {
    const connection = this.connections.get(host.id);
    if (!connection || connection.phase !== 'connected' || this.pollsInFlight.has(host.id)) return;
    this.pollsInFlight.add(host.id);
    try {
      const timeoutMs = this.options.thresholds.pollIntervalMs * POLL_TIMEOUT_INTERVALS;
      const result = await connection.exec(COLLECTOR_COMMAND, COLLECTOR_SCRIPT, timeoutMs);
      const raw = parseCollectorOutput(result.stdout);
      const runtime = this.runtime(host.id);
      this.runtimes.set(
        host.id,
        raw
          ? applyPollSuccess(runtime, { collectedAt: this.now(), raw }, this.thresholdsFor(host))
          : applyPollFailure(runtime, 'metrics output was incomplete'),
      );
    } catch (error) {
      this.runtimes.set(
        host.id,
        applyPollFailure(this.runtime(host.id), `polling failed: ${(error as Error).message}`),
      );
    } finally {
      this.pollsInFlight.delete(host.id);
      this.listener({ type: 'changed' });
    }
  }
}
