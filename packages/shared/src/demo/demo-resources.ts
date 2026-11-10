import {
  createUnknownResourceState,
  DEFAULT_RESOURCE_THRESHOLDS,
  type Resource,
  type ResourceGauges,
  type ResourceMetric,
  type ResourceState,
  type ResourceThresholds,
} from '../resource';
import {
  computeResourceStatus,
  nextResourceStreaks,
  type ResourceHealthSample,
  type ResourceStreaks,
} from '../resource-status';
import { isStale } from '../staleness';
import { createSeededRandom } from './seeded-random';

/**
 * Demo resources: databases, an RDS instance and buckets, each exercising a
 * truth state. Like the demo fleet, every sample runs through the real
 * status rules, and whoever serves them must announce demo mode.
 */
type DemoResourceBehavior = 'steady' | 'lagging-replica' | 'offline' | 'goes-stale' | 'growing';

interface DemoResourceSpec {
  resource: Resource;
  behavior: DemoResourceBehavior;
  pollIntervalMs: number;
}

const GiB = 1024 ** 3;

const spec = (
  resource: Omit<Resource, 'tags' | 'sourceId'> & { tags?: string[] },
  behavior: DemoResourceBehavior,
  pollIntervalMs = 2000,
): DemoResourceSpec => ({
  resource: { tags: [], sourceId: resource.id, ...resource },
  behavior,
  pollIntervalMs,
});

const DEMO_RESOURCE_SPECS: DemoResourceSpec[] = [
  spec(
    {
      id: 'orders-db',
      name: 'orders-db',
      kind: 'postgres',
      engine: 'PostgreSQL',
      district: 'Databases',
      target: '10.0.4.20:5432',
    },
    'steady',
  ),
  spec(
    {
      id: 'orders-replica',
      name: 'orders-replica',
      kind: 'postgres',
      engine: 'PostgreSQL',
      district: 'Databases',
      target: '10.0.4.21:5432',
    },
    'lagging-replica',
  ),
  spec(
    {
      id: 'shop-mysql',
      name: 'shop-mysql',
      kind: 'mysql',
      engine: 'MariaDB',
      district: 'Databases',
      target: '10.0.4.30:3306',
    },
    'steady',
  ),
  spec(
    {
      id: 'events-mongo',
      name: 'events-mongo',
      kind: 'mongodb',
      engine: 'MongoDB',
      district: 'Databases',
      target: '10.0.4.40:27017',
    },
    'steady',
  ),
  spec(
    {
      id: 'session-cache',
      name: 'session-cache',
      kind: 'redis',
      engine: 'Redis',
      district: 'Databases',
      target: '10.0.4.50:6379',
    },
    'offline',
  ),
  spec(
    {
      id: 'rate-limit-cache',
      name: 'rate-limit',
      kind: 'redis',
      engine: 'Redis',
      district: 'Databases',
      target: '10.0.4.51:6379',
    },
    'steady',
  ),
  spec(
    {
      id: 'billing-rds',
      name: 'billing-prod',
      kind: 'rds',
      engine: 'RDS · postgres',
      district: 'RDS · ap-south-1',
      target: 'billing-prod.example.ap-south-1.rds.amazonaws.com',
    },
    'steady',
    5000,
  ),
  spec(
    {
      id: 'reports-rds',
      name: 'reports-ro',
      kind: 'rds',
      engine: 'RDS · mysql',
      district: 'RDS · ap-south-1',
      target: 'reports-ro.example.ap-south-1.rds.amazonaws.com',
    },
    'goes-stale',
    5000,
  ),
  spec(
    {
      id: 'media-bucket',
      name: 'media-uploads',
      kind: 's3',
      engine: 'S3 · Spaces',
      district: 'Object storage',
      target: 'blr1.digitaloceanspaces.com',
    },
    'growing',
    5000,
  ),
  spec(
    {
      id: 'backups-bucket',
      name: 'nightly-backups',
      kind: 's3',
      engine: 'S3 · R2',
      district: 'Object storage',
      target: 'example.r2.cloudflarestorage.com',
    },
    'steady',
    5000,
  ),
];

export interface DemoResources {
  resources: Resource[];
  thresholds: ResourceThresholds;
  tick(now: number): ResourceState[];
}

export function createDemoResources(
  options: { seed?: number; startedAt?: number } = {},
): DemoResources {
  const random = createSeededRandom((options.seed ?? 7) + 101);
  const startedAt = options.startedAt ?? Date.now();
  const thresholds = DEFAULT_RESOURCE_THRESHOLDS;
  const streaks = new Map<string, ResourceStreaks>();
  const states = new Map<string, ResourceState>(
    DEMO_RESOURCE_SPECS.map((s) => [
      s.resource.id,
      createUnknownResourceState(s.resource.id, s.pollIntervalMs),
    ]),
  );
  const lastPolledAt = new Map<string, number>();

  const tick = (now: number): ResourceState[] => {
    const elapsed = now - startedAt;
    for (const { resource, behavior, pollIntervalMs } of DEMO_RESOURCE_SPECS) {
      const previous = states.get(resource.id)!;
      const due = now - (lastPolledAt.get(resource.id) ?? -Infinity) >= pollIntervalMs;
      // First poll after a short "connecting" moment so the unknown state is visible.
      if (!due || elapsed < 1500) {
        states.set(resource.id, withStaleness(previous, now, thresholds));
        continue;
      }
      // Goes stale: polls a few times, then the poller "hangs".
      if (
        behavior === 'goes-stale' &&
        elapsed > 4 * pollIntervalMs &&
        previous.lastSeenAt !== null
      ) {
        states.set(resource.id, withStaleness(previous, now, thresholds));
        continue;
      }
      lastPolledAt.set(resource.id, now);

      if (behavior === 'offline') {
        const { status, reason } = computeResourceStatus(
          {
            failed: true,
            failureReason: 'connect ECONNREFUSED 10.0.4.50:6379',
            hasPolled: false,
            sample: null,
            streaks: { slowQueries: 0, cpu: 0 },
          },
          thresholds,
        );
        states.set(resource.id, {
          ...createUnknownResourceState(resource.id, pollIntervalMs),
          status,
          statusReason: reason,
          error: reason,
        });
        continue;
      }

      const sample = sampleFor(resource, behavior, elapsed, random.noise);
      const nextStreaks = nextResourceStreaks(
        streaks.get(resource.id) ?? { slowQueries: 0, cpu: 0 },
        sample.health,
        thresholds,
      );
      streaks.set(resource.id, nextStreaks);
      const { status, reason } = computeResourceStatus(
        { failed: false, hasPolled: true, sample: sample.health, streaks: nextStreaks },
        thresholds,
      );
      states.set(resource.id, {
        resourceId: resource.id,
        status,
        statusReason: reason,
        lastSeenAt: now,
        stale: false,
        pollIntervalMs,
        gauges: sample.health.gauges,
        metrics: sample.metrics,
        error: null,
      });
    }
    return [...states.values()];
  };

  return { resources: DEMO_RESOURCE_SPECS.map((s) => s.resource), thresholds, tick };
}

function withStaleness(
  state: ResourceState,
  now: number,
  thresholds: ResourceThresholds,
): ResourceState {
  const stale = isStale(state.lastSeenAt, now, {
    pollIntervalMs: state.pollIntervalMs,
    staleAfterPolls: thresholds.staleAfterPolls,
  });
  return stale === state.stale ? state : { ...state, stale };
}

interface DemoSample {
  health: ResourceHealthSample;
  metrics: ResourceMetric[];
}

const metric = (
  key: string,
  label: string,
  unit: ResourceMetric['unit'],
  value: number | null,
): ResourceMetric => ({
  key,
  label,
  unit,
  value,
  text: null,
  atLeast: false,
});
const textMetric = (key: string, label: string, text: string): ResourceMetric => ({
  key,
  label,
  unit: 'text',
  value: null,
  text,
  atLeast: false,
});

function sampleFor(
  resource: Resource,
  behavior: DemoResourceBehavior,
  elapsedMs: number,
  noise: (spread: number) => number,
): DemoSample {
  const wave = Math.sin(elapsedMs / 9000 + resource.id.length);
  const gauges: ResourceGauges = {
    opsPerSec: null,
    cpuPercent: null,
    connections: null,
    storage: null,
    growthBytesPerHour: null,
  };
  let lag: number | null = null;
  let slow: number | null = 0;
  let cacheHit: number | null = null;
  const metrics: ResourceMetric[] = [];

  switch (resource.kind) {
    case 'postgres':
    case 'mysql':
    case 'mongodb': {
      const ops =
        Math.max(0, 420 + 260 * wave + noise(60)) * (behavior === 'lagging-replica' ? 0.3 : 1);
      const used = Math.round(38 + 12 * wave + noise(3));
      gauges.opsPerSec = ops;
      gauges.connections = { used, max: 100 };
      gauges.storage = { usedBytes: 18.4 * GiB + elapsedMs * 10, totalBytes: null };
      cacheHit = 99.2 + noise(0.4);
      lag = behavior === 'lagging-replica' ? 45 + elapsedMs / 1000 : null;
      metrics.push(
        textMetric('role', 'Role', behavior === 'lagging-replica' ? 'replica' : 'primary'),
        metric(
          'ops',
          resource.kind === 'postgres'
            ? 'Transactions'
            : resource.kind === 'mongodb'
              ? 'Operations'
              : 'Queries',
          'perSec',
          ops,
        ),
        metric('connections', 'Connections', 'count', used),
        metric('maxConnections', 'Max connections', 'count', 100),
        metric('slow', 'Slow queries', 'count', 0),
        metric('cacheHit', 'Cache hit', 'percent', cacheHit),
        metric('lag', 'Replica lag', 'seconds', lag),
        metric('size', 'Size', 'bytes', gauges.storage.usedBytes),
      );
      break;
    }
    case 'redis': {
      const ops = Math.max(0, 2400 + 900 * wave + noise(200));
      const usedMemory = 1.1 * GiB + 0.2 * GiB * wave;
      gauges.opsPerSec = ops;
      gauges.connections = { used: Math.round(140 + 30 * wave), max: 10000 };
      gauges.storage = { usedBytes: usedMemory, totalBytes: 2 * GiB };
      cacheHit = 94 + noise(2);
      metrics.push(
        textMetric('role', 'Role', 'master'),
        metric('ops', 'Commands', 'perSec', ops),
        metric('connections', 'Clients', 'count', gauges.connections.used),
        metric('memory', 'Memory used', 'bytes', usedMemory),
        metric('maxMemory', 'maxmemory', 'bytes', 2 * GiB),
        metric('cacheHit', 'Hit ratio', 'percent', cacheHit),
      );
      break;
    }
    case 'rds': {
      const cpu = Math.min(100, Math.max(0, 34 + 18 * wave + noise(5)));
      const total = 200 * GiB;
      const free = 61 * GiB - elapsedMs * 50;
      gauges.cpuPercent = cpu;
      gauges.connections = { used: Math.round(52 + 10 * wave), max: null };
      gauges.storage = { usedBytes: total - free, totalBytes: total };
      metrics.push(
        textMetric('status', 'Instance', 'available · db.r6g.large'),
        metric('cpu', 'CPU', 'percent', cpu),
        metric('connections', 'Connections', 'count', gauges.connections.used),
        metric('freeStorage', 'Free storage', 'bytes', free),
        metric('readIops', 'Read IOPS', 'perSec', 310 + 80 * wave),
        metric('writeIops', 'Write IOPS', 'perSec', 140 + 40 * wave),
        metric('replicaLag', 'Replica lag', 'seconds', null),
      );
      slow = null;
      break;
    }
    case 's3': {
      const growing = behavior === 'growing';
      const size = (growing ? 412 : 1830) * GiB + (growing ? elapsedMs * 2e4 : 0);
      const objects = growing ? 1_284_000 + Math.floor(elapsedMs / 50) : 100_000;
      gauges.storage = { usedBytes: size, totalBytes: null };
      gauges.growthBytesPerHour = growing ? 2e4 * 3_600_000 : 0;
      metrics.push(
        metric('objects', 'Objects', 'count', objects),
        metric('size', 'Size', 'bytes', size),
        metric('growth', 'Growth', 'bytesPerHour', gauges.growthBytesPerHour),
        metric('latency', 'Reachability', 'ms', 38 + noise(8)),
      );
      if (!growing) metrics[0] = { ...metrics[0]!, atLeast: true };
      slow = null;
      break;
    }
    case 'mssql':
    case 'sqlite':
      break;
  }

  return {
    health: {
      gauges,
      replicationLagSeconds: lag,
      slowQueries: slow,
      cacheHitPercent: cacheHit,
      warnings: [],
    },
    metrics,
  };
}
