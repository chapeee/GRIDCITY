import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { DescribeDBInstancesCommand, RDSClient } from '@aws-sdk/client-rds';
import { mockClient } from 'aws-sdk-client-mock';
import { afterEach, describe, expect, it } from 'vitest';
import { ResourceConfigSchema, type ResourceConfigOf } from '../config/resources-file';
import { createRdsConnector } from './rds';

/** RDS + CloudWatch with mocked AWS clients (no AWS account needed). */
const rdsMock = mockClient(RDSClient);
const cwMock = mockClient(CloudWatchClient);
afterEach(() => {
  rdsMock.reset();
  cwMock.reset();
});

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const config = ResourceConfigSchema.parse({
  kind: 'rds',
  id: 'aws',
  region: 'eu-west-1',
}) as ResourceConfigOf<'rds'>;
const context = { env: {}, homeDir: '/', appName: 'test', now: () => NOW };
const clients = () => ({
  rds: new RDSClient({ region: 'eu-west-1' }),
  cloudWatch: new CloudWatchClient({ region: 'eu-west-1' }),
});

const instance = (id: string, status = 'available', engine = 'postgres') => ({
  DBInstanceIdentifier: id,
  DBInstanceStatus: status,
  Engine: engine,
  EngineVersion: '16.4',
  DBInstanceClass: 'db.t4g.medium',
  AllocatedStorage: 100,
  Endpoint: { Address: `${id}.abc.eu-west-1.rds.amazonaws.com`, Port: 5432 },
});

function metrics(index: number, ageMs: number, values: Partial<Record<string, number>>) {
  const at = new Date(NOW - ageMs);
  return Object.entries(values).map(([key, value]) => ({
    Id: `m${index}_${key}`,
    Timestamps: [at, new Date(at.getTime() - 60_000)],
    Values: [value!, 0],
  }));
}

describe('RDS connector (mocked AWS)', () => {
  it('discovers instances and maps CloudWatch metrics to gauges', async () => {
    rdsMock
      .on(DescribeDBInstancesCommand)
      .resolves({ DBInstances: [instance('orders'), instance('reports', 'available', 'mysql')] });
    cwMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        ...metrics(0, 90_000, {
          cpu: 42,
          freeStorage: 25 * 1024 ** 3,
          connections: 17,
          readIops: 300,
          writeIops: 120,
        }),
        ...metrics(1, 90_000, {
          cpu: 95,
          freeStorage: 5 * 1024 ** 3,
          connections: 3,
          replicaLag: 45,
        }),
      ],
    });
    const connector = createRdsConnector(config, context, clients());
    const outcomes = await connector.poll();
    expect(connector.resources().map((r) => [r.id, r.engine, r.district])).toEqual([
      ['aws-orders', 'RDS · postgres', 'RDS · eu-west-1'],
      ['aws-reports', 'RDS · mysql', 'RDS · eu-west-1'],
    ]);
    const [orders, reports] = outcomes;
    if (!orders!.ok || !reports!.ok) throw new Error('expected ok');
    expect(orders!.observedAt).toBe(NOW);
    expect(orders!.sample.gauges).toMatchObject({
      cpuPercent: 42,
      connections: { used: 17, max: null },
      storage: { usedBytes: 75 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
    });
    expect(reports!.sample.replicationLagSeconds).toBe(45);
    // One GetMetricData call for every instance and metric.
    const calls = cwMock.commandCalls(GetMetricDataCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.MetricDataQueries).toHaveLength(12);
  });

  it('keeps the datapoint time when CloudWatch data is old, so it goes stale', async () => {
    rdsMock.on(DescribeDBInstancesCommand).resolves({ DBInstances: [instance('orders')] });
    cwMock
      .on(GetMetricDataCommand)
      .resolves({ MetricDataResults: metrics(0, 20 * 60_000, { cpu: 10 }) });
    const [outcome] = await createRdsConnector(config, context, clients()).poll();
    if (!outcome!.ok) throw new Error('expected ok');
    expect(outcome!.observedAt).toBe(NOW - 20 * 60_000);
  });

  it('reports stopped instances as unreachable and transitional ones as warnings', async () => {
    rdsMock
      .on(DescribeDBInstancesCommand)
      .resolves({ DBInstances: [instance('a', 'stopped'), instance('b', 'rebooting')] });
    cwMock.on(GetMetricDataCommand).resolves({ MetricDataResults: metrics(1, 60_000, { cpu: 5 }) });
    const [a, b] = await createRdsConnector(config, context, clients()).poll();
    expect(a).toMatchObject({ ok: false, error: 'instance is stopped' });
    if (!b!.ok) throw new Error('expected ok');
    expect(b!.sample.warnings).toEqual(['instance is rebooting']);
  });

  it('filters to the configured instances', async () => {
    rdsMock
      .on(DescribeDBInstancesCommand)
      .resolves({ DBInstances: [instance('a'), instance('b')] });
    cwMock.on(GetMetricDataCommand).resolves({ MetricDataResults: [] });
    const filtered = { ...config, instances: ['b'] };
    const connector = createRdsConnector(filtered, context, clients());
    await connector.poll();
    expect(connector.resources().map((r) => r.name)).toEqual(['b']);
  });

  it('shows one offline placeholder when it cannot list instances', async () => {
    rdsMock.on(DescribeDBInstancesCommand).rejects(
      Object.assign(new Error('The security token included in the request is invalid.'), {
        name: 'InvalidClientTokenId',
      }),
    );
    const connector = createRdsConnector(config, context, clients());
    const outcomes = await connector.poll();
    expect(connector.resources().map((r) => r.id)).toEqual(['aws']);
    expect(outcomes[0]).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cannot list RDS instances/),
    });
  });
});
