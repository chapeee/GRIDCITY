import {
  createUnknownResourceState,
  DEFAULT_RESOURCE_THRESHOLDS,
  EMPTY_GAUGES,
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
 * Demo resources: databases, RDS instances, buckets, load balancers and
 * probes, each exercising a truth state, living in the same districts as the
 * demo servers (AWS Mumbai holds EC2 and RDS and the ALB, like a real VPC).
 * Like the demo fleet, every sample runs through the real status rules, and
 * whoever serves them must announce demo mode.
 */
type DemoResourceBehavior =
  | 'steady'
  | 'lagging-replica'
  | 'offline'
  | 'goes-stale'
  | 'growing'
  /** Probe: answers, but slowly (above the latency threshold). */
  | 'slow'
  /** Probe: healthy, but its certificate expires in a few days. */
  | 'cert-expiring'
  /** Load balancer with one target failing its health check. */
  | 'unhealthy-target';

interface DemoResourceSpec {
  resource: Resource;
  behavior: DemoResourceBehavior;
  pollIntervalMs: number;
}

const GiB = 1024 ** 3;

const spec = (
  resource: Omit<Resource, 'tags' | 'sourceId' | 'dependsOn'> & {
    tags?: string[];
    dependsOn?: string[];
  },
  behavior: DemoResourceBehavior,
  pollIntervalMs = 2000,
): DemoResourceSpec => ({
  resource: { tags: [], dependsOn: [], sourceId: resource.id, ...resource },
  behavior,
  pollIntervalMs,
});

const DEMO_RESOURCE_SPECS: DemoResourceSpec[] = [
  // AWS Mumbai: the databases next to the servers that use them
  spec(
    {
      id: 'orders-db',
      name: 'orders-db',
      kind: 'postgres',
      engine: 'PostgreSQL',
      district: 'AWS Mumbai',
      target: '10.0.4.20:5432',
      tags: ['prod', 'db'],
    },
    'steady',
  ),
  spec(
    {
      id: 'orders-replica',
      name: 'orders-replica',
      kind: 'postgres',
      engine: 'PostgreSQL',
      district: 'AWS Mumbai',
      target: '10.0.4.21:5432',
      tags: ['prod', 'db'],
      dependsOn: ['orders-db'],
    },
    'lagging-replica',
  ),
  spec(
    {
      id: 'billing-rds',
      name: 'billing-prod',
      kind: 'rds',
      engine: 'RDS · postgres',
      district: 'AWS Mumbai',
      target: 'billing-prod.example.ap-south-1.rds.amazonaws.com',
      tags: ['prod', 'managed'],
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
      district: 'AWS Mumbai',
      target: 'reports-ro.example.ap-south-1.rds.amazonaws.com',
      tags: ['managed'],
    },
    'goes-stale',
    5000,
  ),
  spec(
    {
      id: 'media-bucket',
      name: 'media-uploads',
      kind: 's3',
      engine: 'S3 · AWS',
      district: 'AWS Mumbai',
      target: 's3.ap-south-1.amazonaws.com',
      tags: ['prod'],
    },
    'growing',
    5000,
  ),
  spec(
    {
      id: 'lekhix-alb',
      name: 'lekhix-alb',
      kind: 'loadbalancer',
      engine: 'ALB',
      district: 'AWS Mumbai',
      target: 'lekhix-alb-1234.ap-south-1.elb.amazonaws.com',
      tags: ['prod', 'edge'],
    },
    'steady',
    5000,
  ),
  // DigitalOcean: caches and object storage beside the droplets
  spec(
    {
      id: 'session-cache',
      name: 'session-cache',
      kind: 'redis',
      engine: 'Redis',
      district: 'DigitalOcean',
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
      district: 'DigitalOcean',
      target: '10.0.4.51:6379',
    },
    'steady',
  ),
  spec(
    {
      id: 'backups-bucket',
      name: 'nightly-backups',
      kind: 's3',
      engine: 'S3 · Spaces',
      district: 'DigitalOcean',
      target: 'blr1.digitaloceanspaces.com',
      tags: ['backup'],
    },
    'steady',
    5000,
  ),
  spec(
    {
      id: 'skillgen-lb',
      name: 'skillgen-lb',
      kind: 'loadbalancer',
      engine: 'DO LB',
      district: 'DigitalOcean',
      target: '139.59.0.42',
      tags: ['prod', 'edge'],
    },
    'unhealthy-target',
    5000,
  ),
  // Hetzner: self-managed databases on the dedicated boxes
  spec(
    {
      id: 'shop-mysql',
      name: 'shop-mysql',
      kind: 'mysql',
      engine: 'MariaDB',
      district: 'Hetzner',
      target: '10.40.0.20:3306',
      tags: ['db'],
    },
    'steady',
  ),
  spec(
    {
      id: 'events-mongo',
      name: 'events-mongo',
      kind: 'mongodb',
      engine: 'MongoDB',
      district: 'Hetzner',
      target: '10.40.0.20:27017',
      tags: ['db'],
    },
    'steady',
  ),
  // Edge: the public face, probed from this machine
  spec(
    {
      id: 'probe-lekhix',
      name: 'lekhix.com',
      kind: 'http',
      engine: 'HTTPS',
      district: 'Edge',
      target: 'https://lekhix.com/healthz',
      tags: ['prod'],
    },
    'steady',
    5000,
  ),
  spec(
    {
      id: 'probe-myselfraj',
      name: 'myselfraj.com',
      kind: 'http',
      engine: 'HTTPS',
      district: 'Edge',
      target: 'https://myselfraj.com/',
      tags: ['prod'],
    },
    'cert-expiring',
    5000,
  ),
  spec(
    {
      id: 'probe-skillgen',
      name: 'skillgen.app',
      kind: 'http',
      engine: 'HTTPS',
      district: 'Edge',
      target: 'https://skillgen.app/api/health',
      tags: ['prod'],
    },
    'slow',
    5000,
  ),
  spec(
    {
      id: 'probe-gitsmith',
      name: 'gitsmith docs',
      kind: 'http',
      engine: 'HTTPS',
      district: 'Edge',
      target: 'https://gitsmith.dev/',
    },
    'steady',
    5000,
  ),
  // Home lab: probes for the things without SSH metrics of their own
  spec(
    {
      id: 'probe-jellyfin',
      name: 'jellyfin web',
      kind: 'http',
      engine: 'HTTP',
      district: 'Home lab',
      target: 'http://192.168.1.15:8096/health',
    },
    'steady',
    5000,
  ),
  spec(
    {
      id: 'probe-nas-smb',
      name: 'nas smb',
      kind: 'tcp',
      engine: 'TCP',
      district: 'Home lab',
      target: '192.168.1.10:445',
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
            failureReason: `connect ECONNREFUSED ${resource.target}`,
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
          // What the Doctor's rules say about this error (demo: precomputed, same wording).
          hint: {
            id: 'net.refused',
            title: `Nothing accepts connections on port ${resource.target.split(':').pop()}`,
            action: 'Check the service and its bind address',
          },
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
  const gauges: ResourceGauges = { ...EMPTY_GAUGES };
  let lag: number | null = null;
  let slow: number | null = 0;
  let cacheHit: number | null = null;
  let certificateDaysLeft: number | null = null;
  const warnings: string[] = [];
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
    case 'http': {
      const base = behavior === 'slow' ? 2100 : resource.target.startsWith('http://') ? 9 : 140;
      const latency = Math.max(2, base + base * 0.25 * wave + noise(base * 0.1));
      const tls = resource.target.startsWith('https://');
      gauges.latencyMs = latency;
      certificateDaysLeft = tls ? (behavior === 'cert-expiring' ? 5 : 61) : null;
      metrics.push(
        metric('status', 'HTTP status', 'count', 200),
        metric('latency', 'Round trip', 'ms', latency),
        metric('ttfb', 'Time to first byte', 'ms', latency * 0.7),
        metric('size', 'Body', 'bytes', 1842),
        metric('certDays', 'Certificate expires in', 'days', certificateDaysLeft),
        textMetric('issuer', 'Certificate issuer', tls ? "Let's Encrypt" : 'no TLS'),
      );
      slow = null;
      break;
    }
    case 'tcp': {
      const latency = Math.max(1, 3 + 2 * wave + noise(1));
      gauges.latencyMs = latency;
      metrics.push(
        metric('latency', 'Connect time', 'ms', latency),
        textMetric('banner', 'Banner', 'none (port open)'),
      );
      slow = null;
      break;
    }
    case 'loadbalancer': {
      const total = 2;
      const healthy = behavior === 'unhealthy-target' ? 1 : 2;
      const requests = Math.max(0, 180 + 90 * wave + noise(20));
      const latency = Math.max(5, 62 + 20 * wave + noise(8));
      gauges.opsPerSec = requests;
      gauges.latencyMs = latency;
      gauges.targets = { healthy, total };
      gauges.connections = { used: Math.round(640 + 180 * wave), max: null };
      certificateDaysLeft = 74;
      metrics.push(
        textMetric('scheme', 'Scheme', 'internet-facing · HTTPS:443 → HTTP:3000'),
        metric('targets', 'Healthy targets', 'count', healthy),
        metric('targetsTotal', 'Targets', 'count', total),
        metric('requests', 'Requests', 'perSec', requests),
        metric('latency', 'Target response time', 'ms', latency),
        metric('5xx', '5xx per minute', 'count', behavior === 'unhealthy-target' ? 12 : 0),
        metric('4xx', '4xx per minute', 'count', Math.round(8 + 4 * wave)),
        metric('active', 'Active connections', 'count', gauges.connections.used),
        metric('certDays', 'Certificate expires in', 'days', certificateDaysLeft),
      );
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
      certificateDaysLeft,
      warnings,
    },
    metrics,
  };
}
