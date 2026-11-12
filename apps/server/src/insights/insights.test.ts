import type { Resource, ResourceState } from '@app/shared';
import { describe, expect, it } from 'vitest';
import type { ResourceConfig } from '../config/resources-file';
import {
  createExpiryProducer,
  expirySeverity,
  lookupDomain,
  registrableDomain,
  resetRdapBootstrap,
} from './expiry';

const BOOTSTRAP = { services: [[['com', 'net'], ['https://rdap.example-registry.test/']]] };
/** A fake fetch: the IANA map first, then the registry's answer. */
const withBootstrap = (answer: () => Response) =>
  (async (url: string | URL) =>
    String(url).includes('data.iana.org')
      ? new Response(JSON.stringify(BOOTSTRAP))
      : answer()) as unknown as typeof fetch;

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-12T00:00:00Z');

const memoryCache = () => {
  const values = new Map<string, unknown>();
  return {
    getJson: <T>(key: string) => (values.get(key) as T) ?? null,
    setJson: (key: string, value: unknown) => void values.set(key, value),
  };
};

describe('expiry', () => {
  it('alerts at 30, 7 and 1 days', () => {
    expect([45, 30, 8, 7, 2, 1, 0, -3].map(expirySeverity)).toEqual([
      null,
      'medium',
      'medium',
      'high',
      'high',
      'critical',
      'critical',
      'critical',
    ]);
  });

  it('finds the registrable domain, and nothing for IPs and local names', () => {
    expect(registrableDomain('api.shop.example.com')).toBe('example.com');
    expect(registrableDomain('www.bbc.co.uk')).toBe('bbc.co.uk');
    expect(registrableDomain('10.0.0.5')).toBeNull();
    expect(registrableDomain('db.internal')).toBeNull();
    expect(registrableDomain('localhost')).toBeNull();
  });

  it('reads the expiry date and registrar from an RDAP answer', async () => {
    resetRdapBootstrap();
    const send = withBootstrap(
      () =>
        new Response(
          JSON.stringify({
            events: [
              { eventAction: 'registration', eventDate: '2000-01-01T00:00:00Z' },
              { eventAction: 'expiration', eventDate: '2026-11-18T00:00:00Z' },
            ],
            entities: [
              {
                roles: ['registrar'],
                vcardArray: [
                  'vcard',
                  [
                    ['version', {}, 'text', '4.0'],
                    ['fn', {}, 'text', 'Example Registrar'],
                  ],
                ],
              },
            ],
          }),
        ),
    );
    expect(await lookupDomain('example.com', send, NOW)).toMatchObject({
      expiresAt: Date.parse('2026-11-18T00:00:00Z'),
      registrar: 'Example Registrar',
      error: null,
    });
    const missing = withBootstrap(() => new Response('', { status: 404 }));
    expect((await lookupDomain('example.com', missing, NOW)).error).toMatch(/does not publish/);
  });

  it('turns certificate readings and domain dates into findings and calendar entries', async () => {
    const resources: Resource[] = [
      {
        id: 'shop',
        name: 'Shop',
        kind: 'http',
        engine: 'HTTP',
        district: 'Edge',
        tags: [],
        target: 'shop.example.com',
        sourceId: 'shop',
      },
      {
        id: 'mail',
        name: 'Mail',
        kind: 'tcp',
        engine: 'TCP',
        district: 'Edge',
        tags: [],
        target: 'mail.example.com:25',
        sourceId: 'mail',
      },
    ];
    const states = [
      {
        resourceId: 'shop',
        metrics: [
          { key: 'certDays', label: 'c', unit: 'days', value: 5, text: null },
          { key: 'issuer', label: 'i', unit: 'text', value: null, text: "Let's Encrypt" },
        ],
      },
      { resourceId: 'mail', metrics: [] },
    ] as unknown as ResourceState[];
    const configs = new Map<string, ResourceConfig>([
      [
        'shop',
        {
          kind: 'http',
          id: 'shop',
          url: 'https://shop.example.com/health',
        } as unknown as ResourceConfig,
      ],
      [
        'mail',
        {
          kind: 'tcp',
          id: 'mail',
          host: 'mail.example.com',
          port: 25,
        } as unknown as ResourceConfig,
      ],
    ]);
    let lookups = 0;
    const send = (async () => {
      lookups += 1;
      return new Response(
        JSON.stringify({
          events: [
            { eventAction: 'expiration', eventDate: new Date(NOW + 20 * DAY).toISOString() },
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const cache = memoryCache();
    const producer = createExpiryProducer({
      resources: () => resources,
      states: () => states,
      configs: async () => configs,
      fetch: send,
      cache,
    });
    const results = await producer.run(NOW);
    const drafts = results.flatMap((r) =>
      r.drafts.map((d) => `${r.targetId}:${d.key}=${d.severity}`),
    );
    expect(drafts).toEqual(['shop:certificate=high', 'shop:domain:example.com=medium']);
    expect(
      results.flatMap((r) => r.upcoming ?? []).map((u) => `${u.kind}:${u.label}:${u.status}`),
    ).toEqual(['certificate:shop.example.com:urgent', 'domain:example.com:soon']);
    // One RDAP lookup for both resources, then cached.
    await producer.run(NOW + 60_000);
    expect(lookups).toBe(1);
  });
});

import { diskTrend } from './disk-forecast';

describe('disk forecast', () => {
  const HOUR = 3_600_000;
  const series = (points: [number, number][]) =>
    points.map(([hoursAgo, value]) => ({
      at: NOW - hoursAgo * HOUR,
      cpuPercent: null,
      memoryPercent: null,
      networkBytesPerSec: null,
      loadOne: null,
      maxDiskPercent: value,
    }));

  it('fits the growth and says when the disk is full', () => {
    // +1 point every 12 hours: 2 a day, 80 % now -> full in 10 days.
    const trend = diskTrend(
      series([
        [48, 76],
        [36, 77],
        [24, 78],
        [12, 79],
        [0, 80],
      ]),
      NOW,
    )!;
    expect(trend.perDay).toBeCloseTo(2, 5);
    expect(Math.round((trend.fullAt! - NOW) / DAY)).toBe(10);
  });

  it('starts over after a cleanup, and does not forecast a flat disk', () => {
    const cleaned = diskTrend(
      series([
        [60, 90],
        [50, 92],
        [40, 60],
        [30, 60.1],
        [20, 60.2],
        [10, 60.2],
        [0, 60.3],
      ]),
      NOW,
    )!;
    expect(cleaned.current).toBe(60.3);
    expect(cleaned.perDay).toBeLessThan(0.5);
    expect(
      diskTrend(
        series([
          [30, 50],
          [20, 50],
          [10, 50],
          [0, 50],
        ]),
        NOW,
      )!.fullAt,
    ).toBeNull();
  });

  it('needs enough history', () => {
    expect(
      diskTrend(
        series([
          [2, 50],
          [1, 60],
          [0, 70],
        ]),
        NOW,
      ),
    ).toBeNull();
  });
});
