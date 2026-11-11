import type { Host, Resource } from '@app/shared';
import { describe, expect, it } from 'vitest';
import type { HostInventory } from '../metrics/parse-inventory';
import { computeLinks, hostnamesToResolve, targetHostPort } from './topology';

const host = (id: string, address: string, extra: Partial<Host> = {}): Host => ({
  id,
  name: id,
  address,
  port: 22,
  user: 'ops',
  district: 'A',
  tags: [],
  auth: { method: 'agent' },
  ...extra,
});
const resource = (
  id: string,
  kind: Resource['kind'],
  target: string,
  extra: Partial<Resource> = {},
): Resource => ({
  id,
  name: id,
  kind,
  engine: kind,
  district: 'A',
  tags: [],
  target,
  sourceId: id,
  ...extra,
});
const inventory = (
  addresses: string[],
  listening: number[],
  established: [peer: string, port: number, localPort?: number][],
): HostInventory => ({
  addresses,
  services: {
    collectedAt: 500,
    listening: listening.map((port) => ({
      port,
      protocol: 'tcp',
      address: '0.0.0.0',
      process: null,
    })),
    containers: null,
    failedUnits: null,
    rebootRequired: null,
    pendingUpdates: null,
    pendingSecurityUpdates: null,
  },
  established: established.map(([peerAddress, peerPort, localPort]) => ({
    localAddress: addresses[0] ?? '0.0.0.0',
    localPort: localPort ?? 40000,
    peerAddress,
    peerPort,
  })),
});

describe('topology', () => {
  const hosts = [
    host('web', '203.0.113.10', { dependsOn: ['api', 'nowhere'] }),
    host('api', '203.0.113.11'),
    host('db', 'db.internal'),
  ];
  const resources = [
    resource('orders', 'postgres', '10.0.4.20:5432'),
    resource('lb', 'loadbalancer', 'lb.example.com', { dependsOn: ['web'] }),
    resource('probe', 'http', 'https://shop.example.com/healthz', { dependsOn: ['lb'] }),
  ];

  it('declares links from dependsOn, typed by what declares them, ignoring unknown ids', () => {
    const links = computeLinks({ hosts, resources, inventories: new Map(), peers: [], now: 1 });
    expect(links.map((l) => [l.from, l.to, l.kind])).toEqual([
      ['lb', 'web', 'balances'],
      ['probe', 'lb', 'probes'],
      ['web', 'api', 'declared'],
    ]);
  });

  it('observes connections to known addresses and ports only, outbound only', () => {
    const inventories = new Map<string, HostInventory>([
      // api talks to the database and to the db host's private IP on 5432; its own :4000 is inbound.
      [
        'api',
        inventory(
          ['10.0.1.11'],
          [22, 4000],
          [
            ['10.0.4.20', 5432],
            ['10.0.1.30', 5432],
            ['10.0.9.9', 443],
            ['10.0.1.10', 55000, 4000],
          ],
        ),
      ],
      ['db', inventory(['10.0.1.30'], [22, 5432], [])],
      ['web', inventory(['10.0.1.10'], [22, 443], [['10.0.1.11', 4000]])],
    ]);
    const links = computeLinks({ hosts, resources, inventories, peers: [], now: 1 });
    const observed = links.filter((l) => l.kind === 'observed').map((l) => [l.from, l.to, l.label]);
    expect(observed).toEqual([
      ['api', 'db', ':5432'],
      ['api', 'orders', ':5432'],
    ]);
    // web -> api is declared, which wins over the observation of the same pair.
    expect(links.find((l) => l.id === 'web>api')?.kind).toBe('declared');
  });

  it('matches load balancer targets by IP and by instance id tag, and uses DNS results', () => {
    const tagged = [
      ...hosts,
      host('i-abc', '10.0.1.40'),
      host('tagged', '10.0.1.41', { tags: ['i-def'] }),
    ];
    const links = computeLinks({
      hosts: tagged,
      resources,
      inventories: new Map([['db', inventory(['10.0.1.30'], [5432], [])]]),
      peers: [
        { resourceId: 'lb', address: '10.0.1.30', port: 5432, state: 'healthy' },
        { resourceId: 'lb', address: 'i-abc', port: 80, state: 'healthy' },
        { resourceId: 'lb', address: 'i-def', port: 80, state: 'unhealthy' },
        { resourceId: 'lb', address: '198.51.100.7', port: 80, state: 'healthy' },
      ],
      resolved: new Map([['db.internal', ['10.0.1.30']]]),
      now: 9,
    });
    expect(links.filter((l) => l.from === 'lb').map((l) => [l.to, l.label])).toEqual([
      ['db', 'healthy'],
      ['i-abc', 'healthy'],
      ['tagged', 'unhealthy'],
      ['web', null],
    ]);
  });

  it('parses targets and lists hostnames to resolve', () => {
    expect(targetHostPort('db.internal:5432')).toEqual({ host: 'db.internal', port: 5432 });
    expect(targetHostPort('https://shop.example.com/healthz')).toEqual({
      host: 'shop.example.com',
      port: 443,
    });
    expect(targetHostPort('mongodb://monitor@10.0.0.6:27017/?authSource=admin')).toEqual({
      host: '10.0.0.6',
      port: 27017,
    });
    expect(targetHostPort('/srv/app/data.db')).toBeNull();
    expect(targetHostPort('eu-west-1')).toEqual({ host: 'eu-west-1', port: null });
    expect(hostnamesToResolve(hosts, resources).sort()).toEqual([
      'db.internal',
      'lb.example.com',
      'shop.example.com',
    ]);
  });
});
