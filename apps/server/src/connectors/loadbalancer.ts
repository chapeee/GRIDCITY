import {
  CloudWatchClient,
  GetMetricDataCommand,
  type MetricDataQuery,
} from '@aws-sdk/client-cloudwatch';
import {
  DescribeTargetGroupsCommand,
  DescribeTargetHealthCommand,
  ElasticLoadBalancingV2Client,
  paginateDescribeLoadBalancers,
  type LoadBalancer,
  type TargetHealthDescription,
} from '@aws-sdk/client-elastic-load-balancing-v2';
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
  type ResourcePeer,
} from './connector';

export interface LoadBalancerClients {
  elb: ElasticLoadBalancingV2Client;
  cloudWatch: CloudWatchClient;
}

/** Per load balancer type: CloudWatch namespace and the metrics worth a glance. */
const METRICS = {
  application: {
    namespace: 'AWS/ApplicationELB',
    list: [
      { key: 'requests', name: 'RequestCount', stat: 'Sum' },
      { key: 'latency', name: 'TargetResponseTime', stat: 'Average' },
      { key: 'elb5xx', name: 'HTTPCode_ELB_5XX_Count', stat: 'Sum' },
      { key: 'target5xx', name: 'HTTPCode_Target_5XX_Count', stat: 'Sum' },
      { key: 'target4xx', name: 'HTTPCode_Target_4XX_Count', stat: 'Sum' },
      { key: 'active', name: 'ActiveConnectionCount', stat: 'Sum' },
    ],
  },
  network: {
    namespace: 'AWS/NetworkELB',
    list: [
      { key: 'active', name: 'ActiveFlowCount', stat: 'Average' },
      { key: 'newFlows', name: 'NewFlowCount', stat: 'Sum' },
      { key: 'resets', name: 'TCP_Client_Reset_Count', stat: 'Sum' },
      { key: 'processed', name: 'ProcessedBytes', stat: 'Sum' },
    ],
  },
} as const;

const PERIOD_SECONDS = 60;
const FRESH_DATAPOINT_MS = 5 * 60_000;

/**
 * AWS Application and Network Load Balancers: discovery with
 * DescribeLoadBalancers, target health per target group, traffic from
 * CloudWatch in one GetMetricData call. Credentials from the standard AWS
 * chain or a named profile; IAM: elasticloadbalancing:Describe*,
 * cloudwatch:GetMetricData. Targets by IP become topology peers so the city
 * can draw the balancer's links to the servers behind it.
 */
export function createLoadBalancerConnector(
  config: ResourceConfigOf<'loadbalancer'>,
  context: ConnectorContext,
  clients: LoadBalancerClients = createLoadBalancerClients(config, context),
): Connector {
  let known: Resource[] = [];
  let peers: ResourcePeer[] = [];
  const district = config.district ?? `AWS · ${config.region}`;

  const placeholder = (): Resource => ({
    id: config.id,
    name: config.name ?? config.id,
    kind: 'loadbalancer',
    engine: 'ELB',
    district,
    tags: config.tags,
    target: config.region,
    sourceId: config.id,
    dependsOn: config.dependsOn,
  });

  const toResource = (balancer: LoadBalancer): Resource => ({
    id: `${config.id}-${slug(balancer.LoadBalancerName ?? 'lb')}`,
    name: balancer.LoadBalancerName ?? 'load balancer',
    kind: 'loadbalancer',
    engine: balancer.Type === 'network' ? 'NLB' : balancer.Type === 'gateway' ? 'GWLB' : 'ALB',
    district,
    tags: config.tags,
    target: balancer.DNSName ?? config.region,
    sourceId: config.id,
    dependsOn: config.dependsOn,
  });

  const discover = async (): Promise<LoadBalancer[]> => {
    const found: LoadBalancer[] = [];
    const wanted = config.names ? new Set(config.names) : null;
    for await (const page of paginateDescribeLoadBalancers({ client: clients.elb }, {})) {
      for (const balancer of page.LoadBalancers ?? []) {
        if (!wanted || wanted.has(balancer.LoadBalancerName ?? '')) found.push(balancer);
      }
    }
    return found.sort((a, b) => (a.LoadBalancerName ?? '').localeCompare(b.LoadBalancerName ?? ''));
  };

  const targetHealth = async (balancer: LoadBalancer): Promise<TargetHealthDescription[]> => {
    let groups;
    try {
      groups = await clients.elb.send(
        new DescribeTargetGroupsCommand({ LoadBalancerArn: balancer.LoadBalancerArn }),
      );
    } catch (error) {
      // A new balancer with no listener yet has no target groups: some APIs answer
      // TargetGroupNotFound instead of an empty list. That is zero targets, not a fault.
      const name = (error as { name?: string }).name;
      if (name === 'TargetGroupNotFoundException' || name === 'TargetGroupNotFound') return [];
      throw error;
    }
    const all: TargetHealthDescription[] = [];
    for (const group of groups.TargetGroups ?? []) {
      const health = await clients.elb.send(
        new DescribeTargetHealthCommand({ TargetGroupArn: group.TargetGroupArn }),
      );
      all.push(...(health.TargetHealthDescriptions ?? []));
    }
    return all;
  };

  const poll = async (): Promise<PollOutcome[]> => {
    let balancers: LoadBalancer[];
    try {
      balancers = await discover();
    } catch (error) {
      if (known.length === 0) known = [placeholder()];
      const message = `cannot list load balancers: ${redactSecrets(errorMessage(error))}`;
      return known.map((resource) => ({ resourceId: resource.id, ok: false, error: message }));
    }
    known = balancers.map(toResource);
    if (known.length === 0) return [];

    const now = context.now();
    let series: Map<string, { value: number; at: number } | null>;
    try {
      series = await readMetrics(clients.cloudWatch, balancers, now, pollIntervalOf(config));
    } catch (error) {
      const message = `cannot read CloudWatch metrics: ${redactSecrets(errorMessage(error))}`;
      return known.map((resource) => ({ resourceId: resource.id, ok: false, error: message }));
    }

    const nextPeers: ResourcePeer[] = [];
    const outcomes: PollOutcome[] = [];
    for (const [index, balancer] of balancers.entries()) {
      const resource = known[index]!;
      const state = balancer.State?.Code ?? 'unknown';
      if (state === 'failed') {
        outcomes.push({ resourceId: resource.id, ok: false, error: 'load balancer is failed' });
        continue;
      }
      let targets: TargetHealthDescription[] = [];
      let targetError: string | null = null;
      try {
        targets = await targetHealth(balancer);
      } catch (error) {
        targetError = `cannot read target health: ${redactSecrets(errorMessage(error))}`;
      }
      for (const target of targets) {
        if (!target.Target?.Id) continue;
        nextPeers.push({
          resourceId: resource.id,
          address: target.Target.Id,
          port: target.Target.Port ?? null,
          state: target.TargetHealth?.State ?? 'unknown',
        });
      }
      const healthy = targets.filter((t) => t.TargetHealth?.State === 'healthy').length;
      const value = (key: string) => series.get(`m${index}_${key}`) ?? null;
      const metricList =
        balancer.Type === 'network' ? METRICS.network.list : METRICS.application.list;
      const newest = Math.max(0, ...metricList.map(({ key }) => value(key)?.at ?? 0));
      const fresh = newest > 0 && now - newest <= FRESH_DATAPOINT_MS;
      const requests = value('requests')?.value ?? null;
      const latencySeconds = value('latency')?.value ?? null;
      const active = value('active')?.value ?? null;
      const warnings = [
        ...(state === 'provisioning' || state === 'active_impaired' ? [`state is ${state}`] : []),
        ...(targetError ? [targetError] : []),
        ...((value('elb5xx')?.value ?? 0) > 0 ? [`${value('elb5xx')!.value} ELB 5xx/min`] : []),
      ];
      outcomes.push({
        resourceId: resource.id,
        ok: true,
        observedAt: fresh ? now : newest || undefined,
        sample: healthSample(
          {
            opsPerSec: requests === null ? null : requests / PERIOD_SECONDS,
            latencyMs: latencySeconds === null ? null : latencySeconds * 1000,
            targets: targetError ? null : { healthy, total: targets.length },
            connections: active === null ? null : { used: active, max: null },
          },
          { warnings },
        ),
        metrics: [
          textMetric(
            'scheme',
            'Scheme',
            [balancer.Scheme, balancer.Type, state].filter(Boolean).join(' · '),
          ),
          metric('targets', 'Healthy targets', 'count', targetError ? null : healthy),
          metric('targetsTotal', 'Targets', 'count', targetError ? null : targets.length),
          ...(targets.length > 0
            ? [
                textMetric(
                  'targetList',
                  'Target health',
                  targets
                    .map(
                      (t) =>
                        `${t.Target?.Id}${t.Target?.Port ? `:${t.Target.Port}` : ''} ${t.TargetHealth?.State ?? '?'}`,
                    )
                    .join(', '),
                ),
              ]
            : []),
          metric('requests', 'Requests', 'perSec', requests === null ? null : requests / 60),
          metric(
            'latency',
            'Target response time',
            'ms',
            latencySeconds === null ? null : latencySeconds * 1000,
          ),
          metric('elb5xx', 'ELB 5xx per minute', 'count', value('elb5xx')?.value ?? null),
          metric('target5xx', 'Target 5xx per minute', 'count', value('target5xx')?.value ?? null),
          metric('target4xx', 'Target 4xx per minute', 'count', value('target4xx')?.value ?? null),
          metric('active', 'Active connections', 'count', active),
          metric('newFlows', 'New flows per minute', 'count', value('newFlows')?.value ?? null),
          metric('processed', 'Processed per minute', 'bytes', value('processed')?.value ?? null),
          metric(
            'dataAge',
            'CloudWatch data age',
            'seconds',
            newest > 0 ? Math.round((now - newest) / 1000) : null,
          ),
        ].filter(
          (entry) => entry.unit === 'text' || entry.value !== null || entry.key === 'targets',
        ),
      });
    }
    peers = nextPeers;
    return outcomes;
  };

  return {
    config,
    resources: () => (known.length > 0 ? known : [placeholder()]),
    poll,
    peers: () => peers,
    close: async () => {
      clients.elb.destroy();
      clients.cloudWatch.destroy();
    },
  };
}

export function createLoadBalancerClients(
  config: ResourceConfigOf<'loadbalancer'>,
  context?: Pick<ConnectorContext, 'env' | 'secrets'>,
): LoadBalancerClients {
  const credentials = context ? awsCredentials(config, context) : undefined;
  const common = {
    ...(credentials ? { credentials } : {}),
    region: config.region,
    ...(config.profile ? { profile: config.profile } : {}),
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    maxAttempts: 2,
  };
  return {
    elb: new ElasticLoadBalancingV2Client(common),
    cloudWatch: new CloudWatchClient(common),
  };
}

/** The CloudWatch dimension value: everything after "loadbalancer/" in the ARN. */
export function dimensionOf(balancer: LoadBalancer): string {
  const arn = balancer.LoadBalancerArn ?? '';
  const index = arn.indexOf('loadbalancer/');
  return index >= 0 ? arn.slice(index + 'loadbalancer/'.length) : arn;
}

async function readMetrics(
  client: CloudWatchClient,
  balancers: LoadBalancer[],
  now: number,
  pollIntervalMs: number,
): Promise<Map<string, { value: number; at: number } | null>> {
  const queries: MetricDataQuery[] = balancers.flatMap((balancer, index) => {
    const set = balancer.Type === 'network' ? METRICS.network : METRICS.application;
    return set.list.map(({ key, name, stat }) => ({
      Id: `m${index}_${key}`,
      MetricStat: {
        Metric: {
          Namespace: set.namespace,
          MetricName: name,
          Dimensions: [{ Name: 'LoadBalancer', Value: dimensionOf(balancer) }],
        },
        Period: PERIOD_SECONDS,
        Stat: stat,
      },
      ReturnData: true,
    }));
  });
  const windowMs = Math.max(10 * 60_000, pollIntervalMs * 3);
  const result = new Map<string, { value: number; at: number } | null>();
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
