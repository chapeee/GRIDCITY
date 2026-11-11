import type { Container, HostServices, ListeningPort } from '@app/shared';
import {
  INVENTORY_END_MARKER,
  INVENTORY_SECTION_MARKER,
  INVENTORY_SECTIONS,
  UNAVAILABLE_MARKER,
  type InventorySectionName,
} from './inventory-script';

/** A TCP connection the host has open to somewhere, from `ss -tn state established`. */
export interface EstablishedConnection {
  localAddress: string;
  localPort: number;
  peerAddress: string;
  peerPort: number;
}

/** Everything one discovery round found. */
export interface HostInventory {
  services: HostServices;
  /** The host's own IP addresses (every interface), for matching connections to it. */
  addresses: string[];
  established: EstablishedConnection[];
}

/**
 * Pure parsers for the discovery script's output. A section that printed
 * `@@unavailable` becomes null ("could not tell"); a malformed line is
 * skipped, never invented. Returns null when the end marker is missing.
 */
export function parseInventoryOutput(output: string, collectedAt: number): HostInventory | null {
  const sections = splitInventorySections(output);
  if (!sections) return null;
  const section = (name: InventorySectionName): string | null => {
    const text = sections.get(name);
    if (text === undefined) return null;
    return text.trim() === UNAVAILABLE_MARKER ? null : text;
  };

  const listen = section('listen');
  const docker = section('docker');
  const failed = section('failed');
  const updates = parseUpdates(section('updates'));
  return {
    services: {
      collectedAt,
      listening: listen === null ? [] : parseListening(listen),
      containers: docker === null ? null : parseContainers(docker),
      failedUnits: failed === null ? null : parseFailedUnits(failed),
      rebootRequired: parseReboot(section('reboot')),
      pendingUpdates: updates.total,
      pendingSecurityUpdates: updates.security,
    },
    addresses: parseAddresses(section('addrs') ?? ''),
    established: parseEstablished(section('established') ?? ''),
  };
}

export function splitInventorySections(output: string): Map<InventorySectionName, string> | null {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  if (!lines.some((line) => line.trim() === INVENTORY_END_MARKER)) return null;
  const sections = new Map<InventorySectionName, string>();
  let current: InventorySectionName | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) sections.set(current, buffer.join('\n'));
    buffer = [];
  };
  for (const line of lines) {
    if (line.startsWith(INVENTORY_SECTION_MARKER)) {
      flush();
      const name = line.slice(INVENTORY_SECTION_MARKER.length).trim();
      current = (INVENTORY_SECTIONS as readonly string[]).includes(name)
        ? (name as InventorySectionName)
        : null;
    } else if (line.trim() === INVENTORY_END_MARKER) {
      flush();
      current = null;
    } else if (current) {
      buffer.push(line);
    }
  }
  return sections;
}

/** "0.0.0.0:22", "[::]:80", "127.0.0.53%lo:53", "*:443" -> address and port. */
export function splitAddressPort(text: string): { address: string; port: number } | null {
  const index = text.lastIndexOf(':');
  if (index < 0) return null;
  const port = Number(text.slice(index + 1));
  if (!Number.isInteger(port) || port < 0 || port > 65535) return null;
  let address = text.slice(0, index).replace(/^\[|\]$/g, '');
  const scope = address.indexOf('%');
  if (scope >= 0) address = address.slice(0, scope);
  if (address === '*' || address === '') address = '0.0.0.0';
  return { address, port };
}

const PROCESS_NAME = /users:\(\("([^"]+)"/;

/** Listening sockets from `ss -lntup` (with or without the header) or `netstat -lntu`. */
export function parseListening(text: string): ListeningPort[] {
  const seen = new Map<string, ListeningPort>();
  const ports: ListeningPort[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /^(Netid|State|Proto|Active|\()/.test(line)) continue;
    const fields = line.split(/\s+/);
    const proto = fields[0]?.toLowerCase();
    if (!proto || !/^(tcp|udp)/.test(proto)) continue;
    const protocol: ListeningPort['protocol'] = proto.startsWith('udp') ? 'udp' : 'tcp';
    // ss: netid state recv send local peer [process]; netstat: proto recv send local peer [state]
    const isSs = /^(LISTEN|UNCONN|ESTAB)/i.test(fields[1] ?? '');
    const local = splitAddressPort(fields[isSs ? 4 : 3] ?? '');
    if (!local) continue;
    if (protocol === 'tcp' && !isSs && !/LISTEN/.test(line)) continue;
    // One entry per port and protocol: the IPv4 and IPv6 sockets of sshd are one service.
    const key = `${protocol}:${local.port}`;
    const process = PROCESS_NAME.exec(line)?.[1] ?? null;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.process && process) existing.process = process;
      continue;
    }
    const entry: ListeningPort = { port: local.port, protocol, address: local.address, process };
    seen.set(key, entry);
    ports.push(entry);
  }
  return ports.sort((a, b) => a.port - b.port || a.protocol.localeCompare(b.protocol));
}

/** Established TCP connections from `ss -Htn state established` or `netstat -tn`. */
export function parseEstablished(text: string): EstablishedConnection[] {
  const connections: EstablishedConnection[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || /^(Recv-Q|Netid|State|Proto|Active)/.test(line)) continue;
    const fields = line.split(/\s+/);
    // ss (state filter drops the State column): recv send local peer; netstat: proto recv send local peer state
    const ssFormat = /^\d+$/.test(fields[0] ?? '');
    const local = splitAddressPort(fields[ssFormat ? 2 : 3] ?? '');
    const peer = splitAddressPort(fields[ssFormat ? 3 : 4] ?? '');
    if (!local || !peer) continue;
    connections.push({
      localAddress: local.address,
      localPort: local.port,
      peerAddress: peer.address,
      peerPort: peer.port,
    });
  }
  return connections;
}

/** IPs from `ip -o addr` ("10.0.0.5/24") or `hostname -I` ("10.0.0.5 172.17.0.1"). */
export function parseAddresses(text: string): string[] {
  const addresses = new Set<string>();
  for (const token of text.split(/\s+/)) {
    const address = token.split('/')[0]?.trim() ?? '';
    if (!address || address === '127.0.0.1' || address === '::1') continue;
    if (/^[0-9a-f.:]+$/i.test(address)) addresses.add(address);
  }
  return [...addresses];
}

/** `docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}'`. */
export function parseContainers(text: string): Container[] {
  const containers: Container[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const [name, image, state, status] = raw.split('\t');
    if (!name || !image) continue;
    containers.push({
      name: name.trim(),
      image: image.trim(),
      state: (state ?? 'unknown').trim(),
      status: (status ?? '').trim(),
    });
  }
  return containers.sort((a, b) => a.name.localeCompare(b.name));
}

/** `systemctl --failed --no-legend --plain`: first column is the unit. */
export function parseFailedUnits(text: string): string[] {
  const units: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim().replace(/^[●*]\s*/, '');
    if (!line || /^(UNIT|LOAD|\d+ loaded units)/.test(line)) continue;
    const unit = line.split(/\s+/)[0];
    if (unit && /\.[a-z]+$/.test(unit)) units.push(unit);
  }
  return units;
}

export function parseReboot(text: string | null): boolean | null {
  const value = text?.trim().toLowerCase();
  if (value === 'yes') return true;
  if (value === 'no') return false;
  return null;
}

/**
 * Ubuntu's update-notifier summary:
 *   "12 updates can be applied immediately." / "3 of these updates are standard security updates."
 * Anything else (another distribution, no notifier) means unknown.
 */
export function parseUpdates(text: string | null): {
  total: number | null;
  security: number | null;
} {
  if (text === null) return { total: null, security: null };
  const total = /(\d+)\s+updates?\s+can\s+be\s+applied/i.exec(text);
  if (!total) {
    return /0 updates can be applied|up to date/i.test(text)
      ? { total: 0, security: 0 }
      : { total: null, security: null };
  }
  const security =
    /(\d+)\s+of\s+these\s+updates?\s+(?:are|is)\s+(?:a\s+)?(?:standard\s+)?security/i.exec(text);
  return { total: Number(total[1]), security: security ? Number(security[1]) : 0 };
}
