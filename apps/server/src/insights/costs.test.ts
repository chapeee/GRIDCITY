import { describe, expect, it } from 'vitest';
import type { ResourceConfig } from '../config/resources-file';
import { costAccounts, costSpike, createCostsProducer, readCosts, type CostClient } from './costs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const day = (offset: number) => new Date(NOW - offset * 86_400_000).toISOString().slice(0, 10);

/** 30 days: 10/day, then yesterday 40, today 3 so far. */
const fakeClient = (calls: string[]): CostClient => ({
  async costAndUsage({ start }) {
    calls.push(`usage from ${start}`);
    return Array.from({ length: 31 }, (_, i) => {
      const offset = 30 - i;
      const total = offset === 0 ? 3 : offset === 1 ? 40 : 10;
      return {
        date: day(offset),
        currency: 'USD',
        total,
        groups: [
          { key: 'Amazon EC2', amount: total * 0.7 },
          { key: 'Amazon RDS', amount: total * 0.3 },
        ],
      };
    });
  },
  async forecast() {
    calls.push('forecast');
    return 180;
  },
});

describe('cloud costs', () => {
  it('uses only real AWS accounts, once each', () => {
    const configs = [
      { kind: 'rds', id: 'prod-db', region: 'eu-west-1' },
      { kind: 's3', id: 'media', provider: 'aws', region: 'eu-west-1' },
      { kind: 'rds', id: 'moto', region: 'us-east-1', endpoint: 'http://127.0.0.1:5000' },
      { kind: 's3', id: 'minio', provider: 'minio' },
      { kind: 'postgres', id: 'pg' },
    ] as unknown as ResourceConfig[];
    expect(costAccounts(configs).map((c) => c.id)).toEqual(['prod-db', 'media']);
  });

  it('adds up the month, the forecast and the top services', async () => {
    const report = await readCosts(fakeClient([]), 'prod', NOW);
    expect(report.monthToDate).toBeCloseTo(10 * 10 + 40 + 3, 5); // Nov 1-10, 11th, 12th
    expect(report.forecast).toBeCloseTo(report.monthToDate + 180, 5);
    expect(report.byService[0]!.service).toBe('Amazon EC2');
    expect(report.daily).toHaveLength(31);
  });

  it('spots a spike, not normal days or small change', () => {
    const normal = Array.from({ length: 10 }, (_, i) => ({ date: String(i), amount: 10 }));
    expect(costSpike(normal)).toBeNull();
    expect(
      costSpike([...normal.slice(0, 8), { date: 'y', amount: 40 }, { date: 't', amount: 2 }]),
    ).toEqual({ yesterday: 40, average: 10 });
    expect(
      costSpike([
        ...normal.slice(0, 8).map((d) => ({ ...d, amount: 1 })),
        { date: 'y', amount: 3 },
        { date: 't', amount: 0 },
      ]),
    ).toBeNull();
  });

  it('does nothing until turned on, then asks at most every 6 hours', async () => {
    const calls: string[] = [];
    const values = new Map<string, unknown>();
    let enabled = false;
    const producer = createCostsProducer({
      enabled: () => enabled,
      configs: async () => [
        {
          kind: 'rds',
          id: 'prod-db',
          name: 'Production',
          region: 'eu-west-1',
        } as unknown as ResourceConfig,
      ],
      resources: () => [
        {
          id: 'prod-db-orders',
          name: 'orders',
          kind: 'rds',
          engine: 'RDS',
          district: 'D',
          tags: [],
          target: 't',
          sourceId: 'prod-db',
        },
      ],
      context: { env: {}, homeDir: '/', appName: 't', now: () => NOW },
      clientFor: () => fakeClient(calls),
      cache: {
        getJson: <T>(k: string) => (values.get(k) as T) ?? null,
        setJson: (k, v) => void values.set(k, v),
      },
    });
    expect(await producer.run(NOW)).toEqual([]);
    expect(calls).toEqual([]);
    enabled = true;
    const [result] = await producer.run(NOW);
    expect(result!.drafts[0]).toMatchObject({
      severity: 'high',
      title: 'AWS costs jumped: 40.00 USD yesterday',
    });
    await producer.run(NOW + 3_600_000);
    expect(calls.filter((c) => c === 'forecast')).toHaveLength(1);
    expect(producer.reports()[0]!.account).toBe('Production');
  });
});
