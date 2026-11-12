import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
} from '@aws-sdk/client-cost-explorer';
import type { Resource } from '@app/shared';
import type { ResourceConfig } from '../config/resources-file';
import { awsCredentials, type ConnectorContext } from '../connectors/connector';
import type { InsightProducer, ProducerResult } from '../threats/threat-hub';
import { insightDraft } from './expiry';

const DAY = 86_400_000;
/** Cost Explorer charges per request, so it is asked at most this often. */
export const COST_REFRESH_MS = 6 * 3_600_000;
/** A day costing this much more than the week before is a spike… */
const SPIKE_RATIO = 1.5;
/** …when it is also at least this much money (no alerts about cents). */
const SPIKE_MIN_AMOUNT = 5;

export interface CostReport {
  account: string;
  currency: string;
  monthToDate: number;
  forecast: number | null;
  byService: { service: string; amount: number }[];
  daily: { date: string; amount: number }[];
  updatedAt: number;
  error: string | null;
}

export interface CostClient {
  costAndUsage(input: {
    start: string;
    end: string;
    byService: boolean;
  }): Promise<
    { date: string; groups: { key: string; amount: number }[]; total: number; currency: string }[]
  >;
  forecast(input: { start: string; end: string }): Promise<number | null>;
}

/** The AWS Cost Explorer API (us-east-1 only), with the credentials GRIDCITY has. */
export function costClient(config: ResourceConfig, context: ConnectorContext): CostClient {
  const credentials =
    'region' in config
      ? awsCredentials(config as Parameters<typeof awsCredentials>[0], context)
      : undefined;
  const client = new CostExplorerClient({
    region: 'us-east-1',
    ...(credentials ? { credentials } : {}),
    ...('profile' in config && config.profile ? { profile: config.profile as string } : {}),
    maxAttempts: 2,
  });
  return {
    async costAndUsage({ start, end, byService }) {
      const response = await client.send(
        new GetCostAndUsageCommand({
          TimePeriod: { Start: start, End: end },
          Granularity: 'DAILY',
          Metrics: ['UnblendedCost'],
          ...(byService ? { GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }] } : {}),
        }),
      );
      return (response.ResultsByTime ?? []).map((day) => {
        const groups = (day.Groups ?? []).map((group) => ({
          key: group.Keys?.[0] ?? 'Other',
          amount: Number(group.Metrics?.UnblendedCost?.Amount ?? 0),
        }));
        const total = day.Total?.UnblendedCost?.Amount
          ? Number(day.Total.UnblendedCost.Amount)
          : groups.reduce((sum, g) => sum + g.amount, 0);
        const currency =
          day.Total?.UnblendedCost?.Unit ?? day.Groups?.[0]?.Metrics?.UnblendedCost?.Unit ?? 'USD';
        return { date: day.TimePeriod?.Start ?? '', groups, total, currency };
      });
    },
    async forecast({ start, end }) {
      try {
        const response = await client.send(
          new GetCostForecastCommand({
            TimePeriod: { Start: start, End: end },
            Granularity: 'MONTHLY',
            Metric: 'UNBLENDED_COST',
          }),
        );
        return response.Total?.Amount ? Number(response.Total.Amount) : null;
      } catch {
        return null; // not enough history yet, or the last day of the month
      }
    },
  };
}

const isoDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The configs whose credentials can see an AWS account (local emulators have no billing). */
export function costAccounts(configs: readonly ResourceConfig[]): ResourceConfig[] {
  const seen = new Set<string>();
  return configs.filter((config) => {
    const aws =
      config.kind === 'rds' ||
      config.kind === 'loadbalancer' ||
      (config.kind === 's3' && config.provider === 'aws');
    if (!aws || ('endpoint' in config && config.endpoint)) return false;
    const key = JSON.stringify([
      'accessKeyIdEnv' in config ? config.accessKeyIdEnv : null,
      'profile' in config ? config.profile : null,
      config.id.split('.')[0],
    ]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Month to date, forecast, top services and the last 30 days, from one account. */
export async function readCosts(
  client: CostClient,
  account: string,
  now: number,
): Promise<CostReport> {
  const today = isoDay(now);
  const monthStart = `${today.slice(0, 8)}01`;
  const thirtyAgo = isoDay(now - 30 * DAY);
  const start = thirtyAgo < monthStart ? thirtyAgo : monthStart;
  try {
    const days = await client.costAndUsage({ start, end: today, byService: true });
    const thisMonth = days.filter((day) => day.date >= monthStart);
    const services = new Map<string, number>();
    for (const day of thisMonth)
      for (const group of day.groups)
        services.set(group.key, (services.get(group.key) ?? 0) + group.amount);
    const nextMonth = new Date(
      Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1, 1),
    );
    const forecastRest = await client.forecast({ start: today, end: isoDay(nextMonth.getTime()) });
    const monthToDate = thisMonth.reduce((sum, day) => sum + day.total, 0);
    return {
      account,
      currency: days[0]?.currency ?? 'USD',
      monthToDate,
      forecast: forecastRest === null ? null : monthToDate + forecastRest,
      byService: [...services]
        .map(([service, amount]) => ({ service, amount }))
        .filter((s) => s.amount >= 0.005)
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10),
      daily: days
        .filter((day) => day.date >= thirtyAgo)
        .map((day) => ({ date: day.date, amount: day.total })),
      updatedAt: now,
      error: null,
    };
  } catch (error) {
    const message = (error as Error).message;
    return {
      account,
      currency: 'USD',
      monthToDate: 0,
      forecast: null,
      byService: [],
      daily: [],
      updatedAt: now,
      error: /AccessDenied|not authorized/i.test(message)
        ? 'the saved credentials may not read Cost Explorer (needs ce:GetCostAndUsage and ce:GetCostForecast)'
        : /not enabled|DataUnavailable|opt.?in/i.test(message)
          ? 'Cost Explorer is not enabled for this account yet (turn it on in the AWS Billing console; data appears within a day)'
          : message.slice(0, 200),
    };
  }
}

/** Yesterday against the seven days before it. */
export function costSpike(
  daily: CostReport['daily'],
): { yesterday: number; average: number } | null {
  if (daily.length < 8) return null;
  // The last entry is today (partial); yesterday is the one before.
  const yesterday = daily[daily.length - 2]!.amount;
  const week = daily.slice(-9, -2).map((d) => d.amount);
  const average = week.reduce((sum, v) => sum + v, 0) / week.length;
  if (yesterday < SPIKE_MIN_AMOUNT || yesterday < average * SPIKE_RATIO) return null;
  return { yesterday, average };
}

export interface CostDeps {
  enabled(): boolean;
  configs(): Promise<readonly ResourceConfig[]>;
  resources(): readonly Resource[];
  context: ConnectorContext;
  clientFor?(config: ResourceConfig): CostClient;
  cache: {
    getJson<T>(key: string): T | null;
    setJson(key: string, value: unknown, now: number): void;
  };
}

/**
 * Cloud costs per AWS account: month to date, the month's forecast, the
 * services that cost most, the last 30 days, and a finding when a day costs
 * much more than the week before. Off until the user turns it on, because
 * Cost Explorer charges for every request.
 */
export function createCostsProducer(deps: CostDeps): InsightProducer & { reports(): CostReport[] } {
  return {
    name: 'costs',
    intervalMs: 60 * 60_000,
    reports: () => deps.cache.getJson<CostReport[]>('costs:reports') ?? [],
    async run(now) {
      if (!deps.enabled()) return [];
      const cached = deps.cache.getJson<CostReport[]>('costs:reports');
      const fresh = cached && cached.length > 0 && now - cached[0]!.updatedAt < COST_REFRESH_MS;
      const configs = costAccounts(await deps.configs());
      const reports = fresh
        ? cached
        : await Promise.all(
            configs.map((config) =>
              readCosts(
                deps.clientFor ? deps.clientFor(config) : costClient(config, deps.context),
                config.name ?? config.id,
                now,
              ),
            ),
          );
      if (!fresh) deps.cache.setJson('costs:reports', reports, now);
      const results: ProducerResult[] = [];
      configs.forEach((config, index) => {
        const report = reports[index];
        // Costs belong to the account; they are shown on its first building.
        const owner = deps.resources().find((r) => r.sourceId === config.id);
        if (!report || !owner) return;
        const spike = report.error ? null : costSpike(report.daily);
        const money = (amount: number) => `${amount.toFixed(2)} ${report.currency}`;
        results.push({
          targetId: owner.id,
          targetName: owner.name,
          drafts: spike
            ? [
                insightDraft({
                  key: 'cost-spike',
                  scope: 'costs',
                  category: 'cost',
                  severity: spike.yesterday >= spike.average * 2 ? 'high' : 'medium',
                  title: `AWS costs jumped: ${money(spike.yesterday)} yesterday`,
                  detail: `${report.account} cost ${money(spike.yesterday)} yesterday, against ${money(spike.average)} a day over the week before. Top services this month: ${report.byService
                    .slice(0, 3)
                    .map((s) => `${s.service} ${money(s.amount)}`)
                    .join(', ')}.`,
                  advice:
                    'Open Cost Explorer for yesterday grouped by service and usage type; a forgotten instance, a NAT gateway or data transfer is the usual cause.',
                  now,
                }),
              ]
            : [],
          checkedScopes: report.error ? [] : ['costs'],
          coverage: [{ name: 'Cloud costs', ok: !report.error, note: report.error }],
        });
      });
      return results;
    },
  };
}
