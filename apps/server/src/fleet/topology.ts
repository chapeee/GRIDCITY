import { linkId, mergeLinks, type Host, type Link, type Resource } from '@app/shared';
import type { ResourcePeer } from '../connectors/connector';
import type { HostInventory } from '../metrics/parse-inventory';

/**
 * Builds the city's topology from three honest sources:
 * - `dependsOn` on hosts and resources (declared);
 * - established TCP connections seen on a host, matched to another building
 *   by address and port (observed);
 * - load balancer targets reported by the provider (balances), and the
 *   endpoint a probe hits (probes, from `dependsOn` on the probe).
 *
 * Addresses are matched literally and, for hostnames, through a resolver
 * cache the caller fills (DNS). Nothing is matched by guessing: a connection
 * to an address no building owns draws no link.
 */
export interface TopologyInputs {
  hosts: readonly Host[];
  resources: readonly Resource[];
  /** Latest inventory per host id. */
  inventories: ReadonlyMap<string, HostInventory>;
  /** Addresses load balancers report as targets. */
  peers: readonly ResourcePeer[];
  /** hostname -> IPs it resolved to. */
  resolved?: ReadonlyMap<string, readonly string[]>;
  now: number;
}

/** A building's known addresses and the ports a connection to it may use. */
interface Endpoint {
  id: string;
  addresses: Set<string>;
  /** Null: any port counts (a host whose listening ports are unknown). */
  ports: Set<number> | null;
}

/** Hostnames to resolve for matching (hosts' addresses, resources' targets). */
export function hostnamesToResolve(
  hosts: readonly Host[],
  resources: readonly Resource[],
): string[] {
  const names = new Set<string>();
  for (const host of hosts) if (!isIpAddress(host.address)) names.add(host.address);
  for (const resource of resources) {
    const target = targetHostPort(resource.target);
    if (target && !isIpAddress(target.host)) names.add(target.host);
  }
  return [...names];
}

export function computeLinks(inputs: TopologyInputs): Link[] {
  const { hosts, resources, inventories, peers, now } = inputs;
  const resolved = inputs.resolved ?? new Map<string, readonly string[]>();
  const ids = new Set([...hosts.map((h) => h.id), ...resources.map((r) => r.id)]);
  const byKind = new Map(resources.map((r) => [r.id, r.kind]));

  const declared: Link[] = [];
  const addDeclared = (from: string, to: string, kind: Link['kind']) => {
    if (!ids.has(to) || from === to) return;
    declared.push({ id: linkId(from, to), from, to, kind, label: null, lastSeenAt: null });
  };
  for (const host of hosts)
    for (const to of host.dependsOn ?? []) addDeclared(host.id, to, 'declared');
  for (const resource of resources) {
    const kind =
      resource.kind === 'loadbalancer'
        ? 'balances'
        : resource.kind === 'http' || resource.kind === 'tcp'
          ? 'probes'
          : 'declared';
    for (const to of resource.dependsOn ?? []) addDeclared(resource.id, to, kind);
  }

  // Every building's addresses, so connections and targets can be matched.
  const endpoints: Endpoint[] = [];
  for (const host of hosts) {
    const inventory = inventories.get(host.id);
    const addresses = new Set<string>([
      host.address,
      ...(resolved.get(host.address) ?? []),
      ...(inventory?.addresses ?? []),
    ]);
    const ports = inventory ? new Set(inventory.services.listening.map((p) => p.port)) : null;
    endpoints.push({ id: host.id, addresses, ports });
  }
  for (const resource of resources) {
    const target = targetHostPort(resource.target);
    if (!target) continue;
    const addresses = new Set<string>([target.host, ...(resolved.get(target.host) ?? [])]);
    endpoints.push({
      id: resource.id,
      addresses,
      ports: target.port === null ? null : new Set([target.port]),
    });
  }
  const find = (address: string, port: number | null, exclude: string): Endpoint | undefined =>
    endpoints.find(
      (endpoint) =>
        endpoint.id !== exclude &&
        endpoint.addresses.has(address) &&
        (port === null || endpoint.ports === null || endpoint.ports.has(port)),
    );

  const observed: Link[] = [];
  for (const host of hosts) {
    const inventory = inventories.get(host.id);
    if (!inventory) continue;
    const listening = new Set(inventory.services.listening.map((p) => p.port));
    for (const connection of inventory.established) {
      // A connection on one of our own listening ports is inbound: the other side reports it.
      if (listening.has(connection.localPort)) continue;
      const target = find(connection.peerAddress, connection.peerPort, host.id);
      if (!target) continue;
      observed.push({
        id: linkId(host.id, target.id),
        from: host.id,
        to: target.id,
        kind: 'observed',
        label: `:${connection.peerPort}`,
        lastSeenAt: inventory.services.collectedAt,
      });
    }
  }

  const balances: Link[] = [];
  for (const peer of peers) {
    if (!ids.has(peer.resourceId)) continue;
    const target =
      find(peer.address, peer.port, peer.resourceId) ??
      // Instance targets name the instance id: match a host that is named or tagged with it.
      endpoints.find((e) =>
        hosts.some(
          (h) => h.id === e.id && (h.id === peer.address || h.tags.includes(peer.address)),
        ),
      );
    if (!target) continue;
    balances.push({
      id: linkId(peer.resourceId, target.id),
      from: peer.resourceId,
      to: target.id,
      kind: byKind.get(peer.resourceId) === 'loadbalancer' ? 'balances' : 'observed',
      label: peer.state,
      lastSeenAt: now,
    });
  }

  return mergeLinks(declared, observed, balances);
}

/** "db.internal:5432" | "https://x/y" | "mongodb://u@h:27017/db" | "/path" -> host and port. */
export function targetHostPort(target: string): { host: string; port: number | null } | null {
  if (!target || target.startsWith('/') || /^[a-z]:\\/i.test(target)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (!url.hostname) return null;
      const port = url.port ? Number(url.port) : defaultPortOf(url.protocol);
      return { host: url.hostname, port };
    } catch {
      return null;
    }
  }
  const match = /^\[?([^\]/\s]+?)\]?(?::(\d{1,5}))?$/.exec(target.trim());
  if (!match?.[1]) return null;
  if (match[1].includes(':') && !match[2]) return { host: match[1], port: null }; // bare IPv6
  return { host: match[1], port: match[2] ? Number(match[2]) : null };
}

function defaultPortOf(protocol: string): number | null {
  switch (protocol) {
    case 'http:':
      return 80;
    case 'https:':
      return 443;
    case 'mongodb:':
      return 27017;
    case 'redis:':
      return 6379;
    case 'postgres:':
    case 'postgresql:':
      return 5432;
    case 'mysql:':
      return 3306;
    default:
      return null;
  }
}

export function isIpAddress(value: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(value) || /^[0-9a-f:]+$/i.test(value);
}
