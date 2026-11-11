import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseInventoryOutput,
  parseListening,
  parseUpdates,
  splitAddressPort,
} from './parse-inventory';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');

describe('discovery output on Ubuntu (ss, docker, systemd)', () => {
  const inventory = parseInventoryOutput(fixture('inventory-ubuntu'), 1000)!;

  it('lists listening ports once, with the process when visible', () => {
    expect(inventory.services.listening.map((p) => [p.port, p.protocol, p.process])).toEqual([
      [22, 'tcp', 'sshd'],
      [53, 'udp', 'systemd-resolve'],
      [80, 'tcp', 'nginx'],
      [443, 'tcp', 'nginx'],
      [4000, 'tcp', null],
      [5432, 'tcp', 'postgres'],
    ]);
    expect(inventory.services.listening.find((p) => p.port === 5432)?.address).toBe('127.0.0.1');
  });

  it('keeps established connections with both ends', () => {
    expect(inventory.established).toContainEqual({
      localAddress: '10.0.1.12',
      localPort: 48812,
      peerAddress: '10.0.4.20',
      peerPort: 5432,
    });
    expect(inventory.established).toHaveLength(5);
  });

  it('reports the own addresses without loopback', () => {
    expect(inventory.addresses).toEqual(['10.0.1.12', 'fe80::216:3eff:fe12:3456', '172.17.0.1']);
  });

  it('parses containers, failed units, reboot flag and pending updates', () => {
    expect(inventory.services.containers).toEqual([
      {
        name: 'lekhix-api',
        image: 'ghcr.io/lekhix/api:2.14.0',
        state: 'running',
        status: 'Up 3 days (healthy)',
      },
      {
        name: 'lekhix-worker',
        image: 'ghcr.io/lekhix/worker:2.14.0',
        state: 'restarting',
        status: 'Restarting (137) 12 seconds ago',
      },
      {
        name: 'otel-collector',
        image: 'otel/opentelemetry-collector:0.108.0',
        state: 'exited',
        status: 'Exited (0) 2 weeks ago',
      },
    ]);
    expect(inventory.services.failedUnits).toEqual(['certbot.service']);
    expect(inventory.services.rebootRequired).toBe(true);
    expect(inventory.services.pendingUpdates).toBe(12);
    expect(inventory.services.pendingSecurityUpdates).toBe(3);
    expect(inventory.services.collectedAt).toBe(1000);
  });
});

describe('discovery output on a minimal box (netstat, no docker, no systemd)', () => {
  const inventory = parseInventoryOutput(fixture('inventory-alpine'), 5)!;

  it('reads the netstat format and reports unknowns as null, not none', () => {
    expect(inventory.services.listening.map((p) => [p.port, p.protocol])).toEqual([
      [22, 'tcp'],
      [68, 'udp'],
    ]);
    expect(inventory.services.containers).toBeNull();
    expect(inventory.services.failedUnits).toBeNull();
    expect(inventory.services.rebootRequired).toBeNull();
    expect(inventory.services.pendingUpdates).toBeNull();
    expect(inventory.established).toEqual([
      { localAddress: '192.168.1.2', localPort: 22, peerAddress: '192.168.1.50', peerPort: 60122 },
    ]);
  });
});

describe('inventory helpers', () => {
  it('splits every address form ss prints', () => {
    expect(splitAddressPort('0.0.0.0:22')).toEqual({ address: '0.0.0.0', port: 22 });
    expect(splitAddressPort('[::1]:5432')).toEqual({ address: '::1', port: 5432 });
    expect(splitAddressPort('127.0.0.53%lo:53')).toEqual({ address: '127.0.0.53', port: 53 });
    expect(splitAddressPort('*:443')).toEqual({ address: '0.0.0.0', port: 443 });
    expect(splitAddressPort('nonsense')).toBeNull();
  });

  it('reads update summaries and treats other text as unknown', () => {
    expect(parseUpdates('0 updates can be applied immediately.')).toEqual({
      total: 0,
      security: 0,
    });
    expect(
      parseUpdates(
        '1 update can be applied immediately.\n1 of these updates is a standard security update.',
      ),
    ).toEqual({ total: 1, security: 1 });
    expect(parseUpdates('something else')).toEqual({ total: null, security: null });
  });

  it('returns null for truncated output', () => {
    expect(
      parseInventoryOutput('@@section listen\ntcp LISTEN 0 1 0.0.0.0:22 0.0.0.0:*', 0),
    ).toBeNull();
    expect(parseListening('')).toEqual([]);
  });
});
