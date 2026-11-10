import {
  computeResourceStatus,
  createDemoResources,
  createUnknownResourceState,
  EMPTY_GAUGES,
  isStale,
  nextResourceStreaks,
  type DataMode,
  type DemoResources,
  type Resource,
  type ResourceHealthSample,
  type ResourceMetric,
  type ResourceState,
  type ResourceStreaks,
  type ResourceThresholds,
} from '@app/shared';
import type { ResourceConfig } from '../config/resources-file';
import {
  pollIntervalOf,
  withTimeout,
  type Connector,
  type PollOutcome,
} from '../connectors/connector';
import type { AuditLog } from '../storage/audit-log';

export type ResourceEvent = { type: 'changed' } | { type: 'resourcesChanged' };
export type ResourceListener = (event: ResourceEvent) => void;

/** A source of resource state: real connectors or the demo set. Mirrors FleetProvider. */
export interface ResourceProvider {
  readonly dataMode: DataMode;
  resources(): Resource[];
  start(listener: ResourceListener): void;
  stop(): void;
  currentStates(now: number): ResourceState[];
}

interface Runtime {
  resourceId: string;
  pollIntervalMs: number;
  thresholds: ResourceThresholds;
  hasPolled: boolean;
  failed: boolean;
  error: string | null;
  lastSeenAt: number | null;
  sample: ResourceHealthSample | null;
  metrics: ResourceMetric[];
  streaks: ResourceStreaks;
}

/**
 * Applies one poll outcome to a runtime. Pure, so the truth rules are easy
 * to test: a failure keeps `lastSeenAt` but drops every value (offline
 * shows dashes), and nothing is ever invented.
 */
export function applyOutcome(runtime: Runtime, outcome: PollOutcome, now: number): Runtime {
  if (!outcome.ok) {
    return {
      ...runtime,
      failed: true,
      error: outcome.error,
      sample: null,
      metrics: runtime.metrics.map((entry) => ({ ...entry, value: null, text: null })),
      streaks: { slowQueries: 0, cpu: 0 },
    };
  }
  return {
    ...runtime,
    hasPolled: true,
    failed: false,
    error: null,
    lastSeenAt: outcome.observedAt ?? now,
    sample: outcome.sample,
    metrics: outcome.metrics,
    streaks: nextResourceStreaks(runtime.streaks, outcome.sample, runtime.thresholds),
  };
}

export function runtimeToState(runtime: Runtime, now: number): ResourceState {
  const { status, reason } = computeResourceStatus(
    {
      failed: runtime.failed,
      failureReason: runtime.error,
      hasPolled: runtime.hasPolled,
      sample: runtime.sample,
      streaks: runtime.streaks,
    },
    runtime.thresholds,
  );
  return {
    resourceId: runtime.resourceId,
    status,
    statusReason: reason,
    lastSeenAt: runtime.lastSeenAt,
    stale:
      status !== 'offline' &&
      isStale(runtime.lastSeenAt, now, {
        pollIntervalMs: runtime.pollIntervalMs,
        staleAfterPolls: runtime.thresholds.staleAfterPolls,
      }),
    pollIntervalMs: runtime.pollIntervalMs,
    gauges: status === 'offline' ? EMPTY_GAUGES : (runtime.sample?.gauges ?? EMPTY_GAUGES),
    metrics: runtime.metrics,
    error: runtime.error,
  };
}

export interface ResourceFleetOptions {
  configs: readonly ResourceConfig[];
  thresholds: ResourceThresholds;
  createConnector(config: ResourceConfig): Connector;
  audit?: AuditLog;
  now?: () => number;
}

/** Polls every configured connector on its own interval. */
export class ResourceFleet implements ResourceProvider {
  readonly dataMode = 'real' as const;
  private readonly connectors: {
    connector: Connector;
    config: ResourceConfig;
    timer: ReturnType<typeof setTimeout> | null;
    busy: boolean;
  }[];
  private readonly runtimes = new Map<string, Runtime>();
  private listener: ResourceListener | null = null;
  private stopped = false;
  private readonly now: () => number;
  private resourceSignature = '';

  constructor(private readonly options: ResourceFleetOptions) {
    this.now = options.now ?? Date.now;
    this.connectors = options.configs.map((config) => ({
      config,
      connector: options.createConnector(config),
      timer: null,
      busy: false,
    }));
    this.resourceSignature = signature(this.resources());
  }

  resources(): Resource[] {
    return this.connectors.flatMap(({ connector }) => connector.resources());
  }

  start(listener: ResourceListener): void {
    this.listener = listener;
    for (const entry of this.connectors) void this.pollLoop(entry);
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.connectors) {
      if (entry.timer) clearTimeout(entry.timer);
      void entry.connector.close().catch(() => undefined);
    }
  }

  /** Polls every connector once (tests). */
  async pollAll(): Promise<void> {
    await Promise.all(this.connectors.map((entry) => this.pollOnce(entry)));
  }

  currentStates(now: number): ResourceState[] {
    return this.resources().map((resource) => {
      const runtime = this.runtimes.get(resource.id);
      if (!runtime) {
        const config = this.connectors.find(
          (entry) => entry.config.id === resource.sourceId,
        )?.config;
        return createUnknownResourceState(resource.id, config ? pollIntervalOf(config) : 10_000);
      }
      return runtimeToState(runtime, now);
    });
  }

  private async pollLoop(entry: (typeof this.connectors)[number]): Promise<void> {
    if (this.stopped) return;
    await this.pollOnce(entry);
    if (this.stopped) return;
    entry.timer = setTimeout(() => void this.pollLoop(entry), pollIntervalOf(entry.config));
  }

  private async pollOnce(entry: (typeof this.connectors)[number]): Promise<void> {
    if (entry.busy) return;
    entry.busy = true;
    const interval = pollIntervalOf(entry.config);
    try {
      const outcomes = await withTimeout(
        entry.connector.poll(),
        Math.max(20_000, interval * 3),
        'poll',
      );
      if (this.stopped) return;
      const now = this.now();
      const thresholds = { ...this.options.thresholds, ...entry.config.thresholds };
      for (const outcome of outcomes) {
        const previous =
          this.runtimes.get(outcome.resourceId) ??
          ({
            resourceId: outcome.resourceId,
            pollIntervalMs: interval,
            thresholds,
            hasPolled: false,
            failed: false,
            error: null,
            lastSeenAt: null,
            sample: null,
            metrics: [],
            streaks: { slowQueries: 0, cpu: 0 },
          } satisfies Runtime);
        const next = applyOutcome({ ...previous, thresholds }, outcome, now);
        this.audit(entry.config, previous, next, outcome);
        this.runtimes.set(outcome.resourceId, next);
      }
    } catch {
      // A poll that times out is a failed poll: values are kept and go stale.
    } finally {
      entry.busy = false;
    }
    const nextSignature = signature(this.resources());
    if (nextSignature !== this.resourceSignature) {
      this.resourceSignature = nextSignature;
      this.listener?.({ type: 'resourcesChanged' });
    } else {
      this.listener?.({ type: 'changed' });
    }
  }

  /** Transitions only: reachable / unreachable, never every retry. */
  private audit(
    config: ResourceConfig,
    previous: Runtime,
    next: Runtime,
    outcome: PollOutcome,
  ): void {
    const audit = this.options.audit;
    if (!audit) return;
    const wasUp = previous.hasPolled && !previous.failed;
    if (outcome.ok && !wasUp) {
      audit.append('resource_reachable', outcome.resourceId, `${config.kind}`);
    } else if (!outcome.ok && (wasUp || !previous.failed)) {
      audit.append(
        'resource_unreachable',
        outcome.resourceId,
        `${config.kind}: ${next.error ?? ''}`,
      );
    }
  }
}

function signature(resources: Resource[]): string {
  return JSON.stringify(resources.map((r) => [r.id, r.name, r.district, r.engine, r.target]));
}

/** The demo resources, always announced as demo data. */
export class DemoResourceProvider implements ResourceProvider {
  readonly dataMode = 'demo' as const;
  private readonly demo: DemoResources;
  private states: ResourceState[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { seed?: number } = {}) {
    this.demo = createDemoResources({ ...options, startedAt: Date.now() });
    this.states = this.demo.tick(Date.now());
  }

  resources(): Resource[] {
    return this.demo.resources;
  }

  start(listener: ResourceListener): void {
    this.timer = setInterval(() => {
      this.states = this.demo.tick(Date.now());
      listener({ type: 'changed' });
    }, 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  currentStates(now: number): ResourceState[] {
    return this.states.map((state) => ({
      ...state,
      stale:
        state.status !== 'offline' &&
        isStale(state.lastSeenAt, now, {
          pollIntervalMs: state.pollIntervalMs,
          staleAfterPolls: this.demo.thresholds.staleAfterPolls,
        }),
    }));
  }
}

/** No resources configured (or the file is invalid). */
export class EmptyResourceProvider implements ResourceProvider {
  constructor(readonly dataMode: DataMode = 'real') {}
  resources(): Resource[] {
    return [];
  }
  start(): void {}
  stop(): void {}
  currentStates(): ResourceState[] {
    return [];
  }
}
