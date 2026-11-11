import { DEFAULT_RESOURCE_THRESHOLDS } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { parseResourcesYaml } from '../config/resources-file';
import { applyOutcome, runtimeToState } from '../fleet/resource-fleet';
import {
  CounterTracker,
  healthSample,
  hitPercent,
  metric,
  readPassword,
  redactSecrets,
} from './connector';
import { parseRedisInfo } from './redis';
import { recordGrowth } from './s3';

describe('resources.yaml', () => {
  it('accepts every kind with defaults', () => {
    const result = parseResourcesYaml(`
resources:
  - { kind: postgres, id: pg, host: db, user: monitor, passwordEnv: PG_PASS }
  - { kind: mysql, id: my, host: db, user: monitor }
  - { kind: mongodb, id: mo, url: "mongodb://monitor@db:27017" }
  - { kind: redis, id: re, host: cache }
  - { kind: mssql, id: ms, host: sql, user: monitor }
  - { kind: sqlite, id: li, path: /srv/app.db }
  - { kind: rds, id: aws, region: eu-west-1 }
  - { kind: s3, id: media, provider: r2, endpoint: "https://x.r2.cloudflarestorage.com" }
`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.resources.map((r) => r.kind)).toEqual([
        'postgres',
        'mysql',
        'mongodb',
        'redis',
        'mssql',
        'sqlite',
        'rds',
        's3',
      ]);
      expect(result.config.resources[0]).toMatchObject({
        port: 5432,
        database: 'postgres',
        slowQueryMs: 1000,
      });
    }
  });

  it('refuses inline passwords and passwords in URLs, explaining what to do instead', () => {
    const inline = parseResourcesYaml(
      'resources:\n  - { kind: postgres, id: pg, host: db, user: u, password: hunter2 }\n',
    );
    expect(inline.ok).toBe(false);
    if (!inline.ok) {
      expect(inline.errors[0]).toMatch(/secrets are never stored/);
      expect(inline.errors.join()).not.toContain('hunter2');
    }
    const url = parseResourcesYaml(
      'resources:\n  - { kind: mongodb, id: mo, url: "mongodb://u:hunter2@db:27017" }\n',
    );
    expect(url.ok).toBe(false);
    if (!url.ok) expect(url.errors[0]).toMatch(/password in the URL/);
    const s3 = parseResourcesYaml('resources:\n  - { kind: s3, id: b, secretAccessKey: abc }\n');
    expect(s3.ok).toBe(false);
  });

  it('reports duplicate ids, unknown kinds and unknown fields', () => {
    const result = parseResourcesYaml(`
resources:
  - { kind: redis, id: a, host: x }
  - { kind: redis, id: a, host: y }
  - { kind: oracle, id: b }
  - { kind: redis, id: c, host: z, colour: blue }
`);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toMatch(/duplicate id "a"/);
      expect(result.errors.join('\n')).toMatch(/kind must be one of/);
      expect(result.errors.join('\n')).toMatch(/colour/);
    }
  });
});

describe('secrets', () => {
  it('reads passwords by reference only', async () => {
    await expect(
      readPassword({ passwordEnv: 'X' }, { env: { X: 's3cret' }, homeDir: '/' }),
    ).resolves.toBe('s3cret');
    await expect(
      readPassword({ passwordEnv: 'MISSING' }, { env: {}, homeDir: '/' }),
    ).rejects.toThrow(/MISSING is not set/);
    await expect(readPassword({}, { env: {}, homeDir: '/' })).resolves.toBeUndefined();
  });

  it('redacts known secrets, URL passwords and password= pairs', () => {
    expect(redactSecrets('auth failed for s3cret', ['s3cret'])).toBe('auth failed for ***');
    expect(redactSecrets('cannot reach postgres://bob:hunter2@db/x')).toBe(
      'cannot reach postgres://bob:***@db/x',
    );
    expect(redactSecrets('Server=x;Password=abc;User=y')).toBe('Server=x;Password=***;User=y');
  });
});

describe('counters', () => {
  it('gives no rate on the first poll or after a reset, a real one otherwise', () => {
    const counters = new CounterTracker();
    expect(counters.rate('q', 100, 0)).toBeNull();
    counters.commit();
    expect(counters.rate('q', 300, 2000)).toBe(100);
    counters.commit();
    expect(counters.rate('q', 5, 3000)).toBeNull(); // server restarted
  });

  it('judges cache hits only with enough reads', () => {
    expect(hitPercent(99, 1)).toBe(99);
    expect(hitPercent(5, 1)).toBeNull();
    expect(hitPercent(null, 1)).toBeNull();
  });

  it('parses INFO and measures growth over the window', () => {
    const info = parseRedisInfo(
      '# Server\r\nredis_version:7.4.1\r\nrole:master\r\n\r\n# Clients\r\nconnected_clients:3\r\n',
    );
    expect(info.get('redis_version')).toBe('7.4.1');
    expect(info.get('connected_clients')).toBe('3');
    const history = new Map();
    expect(recordGrowth(history, 'b', 0, 1000)).toBeNull();
    expect(recordGrowth(history, 'b', 1_800_000, 2000)).toBe(2000);
  });
});

describe('resource runtime (truth rules)', () => {
  const base = {
    resourceId: 'pg',
    pollIntervalMs: 10_000,
    thresholds: { ...DEFAULT_RESOURCE_THRESHOLDS },
    hasPolled: false,
    failed: false,
    error: null,
    lastSeenAt: null,
    sample: null,
    metrics: [],
    streaks: { slowQueries: 0, cpu: 0 },
  };
  const okOutcome = (connections: number) => ({
    resourceId: 'pg',
    ok: true as const,
    sample: healthSample({ connections: { used: connections, max: 100 } }),
    metrics: [metric('connections', 'Connections', 'count', connections)],
  });

  it('is unknown before the first poll, online after, degraded over a threshold', () => {
    expect(runtimeToState(base, 0).status).toBe('unknown');
    const up = applyOutcome(base, okOutcome(10), 1000);
    expect(runtimeToState(up, 1000)).toMatchObject({
      status: 'online',
      lastSeenAt: 1000,
      stale: false,
    });
    const busy = applyOutcome(up, okOutcome(95), 2000);
    expect(runtimeToState(busy, 2000)).toMatchObject({
      status: 'degraded',
      statusReason: 'connections 95/100',
    });
  });

  it('goes offline with dashes (never stale values) when a poll fails', () => {
    const up = applyOutcome(base, okOutcome(10), 1000);
    const down = applyOutcome(up, { resourceId: 'pg', ok: false, error: 'ECONNREFUSED' }, 2000);
    const state = runtimeToState(down, 2000);
    expect(state).toMatchObject({
      status: 'offline',
      statusReason: 'ECONNREFUSED',
      lastSeenAt: 1000,
      stale: false,
    });
    expect(state.gauges.connections).toBeNull();
    expect(state.metrics[0]!.value).toBeNull();
  });

  it('turns stale after 3 poll intervals without data', () => {
    const up = applyOutcome(base, okOutcome(10), 1000);
    expect(runtimeToState(up, 1000 + 30_000).stale).toBe(false);
    expect(runtimeToState(up, 1000 + 30_001).stale).toBe(true);
  });
});
