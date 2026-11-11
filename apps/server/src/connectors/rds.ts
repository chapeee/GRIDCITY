import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import { paginateDescribeDBInstances, RDSClient, type DBInstance } from '@aws-sdk/client-rds';
import type { Resource } from '@app/shared';
import type { ResourceConfigOf } from '../config/resources-file';
import {
  awsCredentials,
  errorMessage,
  healthSample,
  metric,
  pollIntervalOf,
  redactSecrets,
  textMetric,
  type Connector,
  type ConnectorContext,
  type PollOutcome,
} from './connector';

/** RDS states in which the database answers normally. */
const SERVING = new Set([
  'available',
  'backing-up',
  'storage-optimization',
  'configuring-enhanced-monitoring',
  'configuring-log-exports',
  'configuring-iam-database-auth',
]);
/** Transitional states: reachable soon, or partly; shown as degraded. */
const TRANSITIONAL = new Set([
  'modifying',
  'rebooting',
  'starting',
  'upgrading',
  'maintenance',
  'renaming',
  'resetting-master-credentials',
  'moving-to-vpc',
  'converting-to-vpc',
]);

const METRICS = [
  { key: 'cpu', name: 'CPUUtilization' },
  { key: 'freeStorage', name: 'FreeStorageSpace' },
  { key: 'connections', name: 'DatabaseConnections' },
  { key: 'readIops', name: 'ReadIOPS' },
  { key: 'writeIops', name: 'WriteIOPS' },
  { key: 'replicaLag', name: 'ReplicaLag' },
] as const;
type MetricKey = (typeof METRICS)[number]['key'];

/** Datapoints older than this count as no data (CloudWatch normally lags 1-2 minutes). */
const FRESH_DATAPOINT_MS = 5 * 60_000;
const PERIOD_SECONDS = 60;

export interface RdsClients {
  rds: RDSClient;
  cloudWatch: CloudWatchClient;
}

/**
 * AWS RDS: discovers instances with DescribeDBInstances and reads their
 * CloudWatch metrics with one GetMetricData call per poll. Credentials come
 * from the standard AWS chain (env, ~/.aws, SSO, instance role) or the named
 * `profile`; the app never sees or stores them. IAM: `rds:DescribeDBInstances`
 * and `cloudwatch:GetMetricData`.
 */
export function createRdsConnector(
  config: ResourceConfigOf<'rds'>,
  context: ConnectorContext,
  clients: RdsClients = createRdsClients(config, context),
): Connector {
  let known: Resource[] = [];
  let instances = new Map<string, DBInstance>();
  const district = config.district ?? `RDS · ${config.region}`;

  const placeholder = (): Resource => ({
    id: config.id,
    name: config.name ?? config.id,
    kind: 'rds',
    engine: 'RDS',
    district,
    tags: config.tags,
    target: config.region,
    sourceId: config.id,
    dependsOn: config.dependsOn,
  });

  const toResource = (instance: DBInstance): Resource => ({
    id: `${config.id}-${slug(instance.DBInstanceIdentifier ?? 'instance')}`,
    name: instance.DBInstanceIdentifier ?? 'instance',
    kind: 'rds',
    engine: `RDS · ${instance.Engine ?? 'unknown'}`,
    district,
    tags: config.tags,
    target: instance.Endpoint?.Address ?? config.region,
    sourceId: config.id,
    dependsOn: config.dependsOn,
  });

  const discover = async (): Promise<DBInstance[]> => {
    const found: DBInstance[] = [];
    const wanted = config.instances ? new Set(config.instances) : null;
    for await (const page of paginateDescribeDBInstances({ client: clients.rds }, {})) {
      for (const instance of page.DBInstances ?? []) {
        if (!wanted || wanted.has(instance.DBInstanceIdentifier ?? '')) found.push(instance);
      }
    }
    return found.sort((a, b) =>
      (a.DBInstanceIdentifier ?? '').localeCompare(b.DBInstanceIdentifier ?? ''),
    );
  };

  const poll = async (): Promise<PollOutcome[]> => {
    let discovered: DBInstance[];
    try {
      discovered = await discover();
    } catch (error) {
      // Discovery failed: keep showing what we knew (now offline), or one placeholder.
      if (known.length === 0) known = [placeholder()];
      const message = `cannot list RDS instances: ${redactSecrets(errorMessage(error))}`;
      return known.map((resource) => ({ resourceId: resource.id, ok: false, error: message }));
    }
    instances = new Map(discovered.map((instance) => [toResource(instance).id, instance]));
    known = [...instances.keys()].map((id) => toResource(instances.get(id)!));
    if (known.length === 0) return [];

    const now = context.now();
    let series: Map<string, { value: number; at: number } | null>;
    try {
      series = await readMetrics(clients.cloudWatch, discovered, now, pollIntervalOf(config));
    } catch (error) {
      const message = `cannot read CloudWatch metrics: ${redactSecrets(errorMessage(error))}`;
      return known.map((resource) => ({ resourceId: resource.id, ok: false, error: message }));
    }

    return known.map((resource, index): PollOutcome => {
      const instance = instances.get(resource.id)!;
      const state = instance.DBInstanceStatus ?? 'unknown';
      if (!SERVING.has(state) && !TRANSITIONAL.has(state)) {
        return { resourceId: resource.id, ok: false, error: `instance is ${state}` };
      }
      const value = (key: MetricKey) => series.get(`m${index}_${key}`) ?? null;
      const newest = Math.max(0, ...METRICS.map(({ key }) => value(key)?.at ?? 0));
      const fresh = newest > 0 && now - newest <= FRESH_DATAPOINT_MS;
      const cpu = value('cpu')?.value ?? null;
      const free = value('freeStorage')?.value ?? null;
      const allocated = instance.AllocatedStorage ? instance.AllocatedStorage * 1024 ** 3 : null;
      const connections = value('connections')?.value ?? null;
      const lag = value('replicaLag')?.value ?? null;
      const warnings = TRANSITIONAL.has(state) ? [`instance is ${state}`] : [];

      return {
        resourceId: resource.id,
        ok: true,
        // Old datapoints keep their own time, so the resource freezes as stale.
        observedAt: fresh ? now : newest || undefined,
        sample: healthSample(
          {
            cpuPercent: cpu === null ? null : Math.min(100, Math.max(0, cpu)),
            connections: connections === null ? null : { used: connections, max: null },
            storage:
              free !== null && allocated !== null
                ? { usedBytes: Math.max(0, allocated - free), totalBytes: allocated }
                : null,
          },
          { replicationLagSeconds: lag, warnings },
        ),
        metrics: [
          textMetric('status', 'Instance', `${state} · ${instance.DBInstanceClass ?? ''}`.trim()),
          textMetric(
            'engine',
            'Engine',
            `${instance.Engine ?? ''} ${instance.EngineVersion ?? ''}`.trim(),
          ),
          metric('cpu', 'CPU', 'percent', cpu),
          metric('connections', 'Connections', 'count', connections),
          metric('freeStorage', 'Free storage', 'bytes', free),
          metric('allocated', 'Allocated storage', 'bytes', allocated),
          metric('readIops', 'Read IOPS', 'perSec', value('readIops')?.value ?? null),
          metric('writeIops', 'Write IOPS', 'perSec', value('writeIops')?.value ?? null),
          metric('replicaLag', 'Replica lag', 'seconds', lag),
          metric(
            'dataAge',
            'CloudWatch data age',
            'seconds',
            newest > 0 ? Math.round((now - newest) / 1000) : null,
          ),
        ],
      };
    });
  };

  return {
    config,
    resources: () => (known.length > 0 ? known : [placeholder()]),
    poll,
    close: async () => {
      clients.rds.destroy();
      clients.cloudWatch.destroy();
    },
  };
}

export function createRdsClients(
  config: ResourceConfigOf<'rds'>,
  context?: Pick<ConnectorContext, 'env' | 'secrets'>,
): RdsClients {
  const credentials = context ? awsCredentials(config, context) : undefined;
  const common = {
    ...(credentials ? { credentials } : {}),
    region: config.region,
    ...(config.profile ? { profile: config.profile } : {}),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    maxAttempts: 2,
  };
  return { rds: new RDSClient(common), cloudWatch: new CloudWatchClient(common) };
}

/** Latest datapoint per query id (`m<instance index>_<metric key>`). */
async function readMetrics(
  client: CloudWatchClient,
  instances: DBInstance[],
  now: number,
  pollIntervalMs: number,
): Promise<Map<string, { value: number; at: number } | null>> {
  const queries: MetricDataQuery[] = instances.flatMap((instance, index) =>
    METRICS.map(({ key, name }) => ({
      Id: `m${index}_${key}`,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/RDS',
          MetricName: name,
          Dimensions: [
            { Name: 'DBInstanceIdentifier', Value: instance.DBInstanceIdentifier ?? '' },
          ],
        },
        Period: PERIOD_SECONDS,
        Stat: 'Average',
      },
      ReturnData: true,
    })),
  );
  const windowMs = Math.max(10 * 60_000, pollIntervalMs * 3);
  const result = new Map<string, { value: number; at: number } | null>();
  // GetMetricData takes at most 500 queries per call.
  for (let start = 0; start < queries.length; start += 500) {
    let nextToken: string | undefined;
    do {
      const response = await client.send(
        new GetMetricDataCommand({
          MetricDataQueries: queries.slice(start, start + 500),
          StartTime: new Date(now - windowMs),
          EndTime: new Date(now),
          ScanBy: 'TimestampDescending',
          NextToken: nextToken,
        }),
      );
      for (const item of response.MetricDataResults ?? []) {
        if (!item.Id || result.get(item.Id)) continue;
        const times = item.Timestamps ?? [];
        const values = item.Values ?? [];
        let best: { value: number; at: number } | null = null;
        times.forEach((time, i) => {
          const at = new Date(time).getTime();
          const value = values[i];
          if (value !== undefined && (!best || at > best.at)) best = { value, at };
        });
        result.set(item.Id, best);
      }
      nextToken = response.NextToken;
    } while (nextToken);
  }
  return result;
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+/, '') || 'x'
  );
}
