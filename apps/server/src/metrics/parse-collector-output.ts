import type { ByteUsage, DiskUsage, LoadAverage } from '@app/shared';
import { END_MARKER, SECTION_MARKER, SECTIONS, type SectionName } from './collector-script';

/**
 * Pure parsers for the collector script's output. Every parser returns null
 * (or an empty list) when its input is missing or malformed: a broken
 * section makes that metric unknown, it never invents a value.
 */

/** Cumulative CPU time counters from the aggregate `cpu` line of /proc/stat (jiffies). */
export interface CpuTimes {
  /** idle + iowait */
  idle: number;
  /** user + nice + system + idle + iowait + irq + softirq + steal */
  total: number;
}

/** Cumulative byte counters for one interface from /proc/net/dev. */
export interface InterfaceCounters {
  iface: string;
  rxBytes: number;
  txBytes: number;
}

/** Everything one poll returned, before rates are computed. */
export interface RawSample {
  cpu: CpuTimes | null;
  memory: ByteUsage | null;
  swap: ByteUsage | null;
  load: LoadAverage | null;
  interfaces: InterfaceCounters[];
  uptimeSeconds: number | null;
  disks: DiskUsage[];
  os: string | null;
}

/** Splits the output into sections. Returns null if the end marker is missing (truncated output). */
export function splitSections(output: string): Map<SectionName, string> | null {
  const lines = output.replace(/\r\n/g, '\n').split('\n');
  if (!lines.some((line) => line.trim() === END_MARKER)) return null;

  const sections = new Map<SectionName, string>();
  let current: SectionName | null = null;
  let buffer: string[] = [];
  const flush = () => {
    if (current) sections.set(current, buffer.join('\n').trim());
    buffer = [];
  };

  for (const line of lines) {
    if (line.startsWith(SECTION_MARKER)) {
      flush();
      const name = line.slice(SECTION_MARKER.length).trim();
      current = (SECTIONS as readonly string[]).includes(name) ? (name as SectionName) : null;
    } else if (line.trim() === END_MARKER) {
      flush();
      current = null;
    } else if (current) {
      buffer.push(line);
    }
  }
  return sections;
}

export function parseCollectorOutput(output: string): RawSample | null {
  const sections = splitSections(output);
  if (!sections) return null;
  const section = (name: SectionName) => sections.get(name) ?? '';
  const memory = parseMeminfo(section('meminfo'));
  return {
    cpu: parseProcStat(section('stat')),
    memory: memory.memory,
    swap: memory.swap,
    load: parseLoadavg(section('loadavg')),
    interfaces: parseNetDev(section('netdev')),
    uptimeSeconds: parseUptime(section('uptime')),
    disks: parseDf(section('df')),
    os: parseOs(section('os')),
  };
}

const isCount = (value: number) => Number.isFinite(value) && value >= 0;

/** Parses the aggregate `cpu` line of /proc/stat. */
export function parseProcStat(text: string): CpuTimes | null {
  const line = text.split('\n').find((l) => /^cpu\s/.test(l));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1).map(Number);
  // user nice system idle iowait irq softirq steal [guest guest_nice]
  // guest time is already included in user/nice, so it is not added again.
  if (values.length < 4 || !values.every(isCount)) return null;
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] =
    values;
  return {
    idle: idle + iowait,
    total: user + nice + system + idle + iowait + irq + softirq + steal,
  };
}

/**
 * Memory from /proc/meminfo. Used = MemTotal − MemAvailable (what `free`
 * reports as used); kernels without MemAvailable (< 3.14) fall back to
 * MemFree + Buffers + Cached.
 */
export function parseMeminfo(text: string): { memory: ByteUsage | null; swap: ByteUsage | null } {
  const kib = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^(\w+(?:\(\w+\))?):\s+(\d+)\s*kB/.exec(line.trim());
    if (match?.[1] && match[2]) kib.set(match[1], Number(match[2]));
  }
  const bytes = (key: string) => {
    const value = kib.get(key);
    return value === undefined ? undefined : value * 1024;
  };

  const total = bytes('MemTotal');
  const available =
    bytes('MemAvailable') ??
    (bytes('MemFree') ?? 0) + (bytes('Buffers') ?? 0) + (bytes('Cached') ?? 0);
  const memory =
    total !== undefined && total > 0
      ? { usedBytes: Math.max(0, total - available), totalBytes: total }
      : null;

  const swapTotal = bytes('SwapTotal');
  const swapFree = bytes('SwapFree');
  const swap =
    swapTotal !== undefined && swapFree !== undefined
      ? { usedBytes: Math.max(0, swapTotal - swapFree), totalBytes: swapTotal }
      : null;

  return { memory, swap };
}

/** Parses /proc/loadavg. */
export function parseLoadavg(text: string): LoadAverage | null {
  const [one, five, fifteen] = text.trim().split(/\s+/).map(Number);
  if (one === undefined || five === undefined || fifteen === undefined) return null;
  if (![one, five, fifteen].every(isCount)) return null;
  return { one, five, fifteen };
}

/**
 * Interfaces excluded from throughput: loopback, plus virtual container and
 * bridge interfaces whose traffic also crosses a physical interface, so
 * counting them would double-count it.
 */
const IGNORED_INTERFACE = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|vxlan)/;

/** Parses /proc/net/dev byte counters, skipping ignored interfaces. */
export function parseNetDev(text: string): InterfaceCounters[] {
  const counters: InterfaceCounters[] = [];
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const iface = line.slice(0, separator).trim();
    if (!iface || iface.includes('|') || IGNORED_INTERFACE.test(iface)) continue;
    const fields = line
      .slice(separator + 1)
      .trim()
      .split(/\s+/)
      .map(Number);
    // Receive: bytes packets errs drop fifo frame compressed multicast | Transmit: bytes …
    const rxBytes = fields[0];
    const txBytes = fields[8];
    if (rxBytes === undefined || txBytes === undefined || !isCount(rxBytes) || !isCount(txBytes)) {
      continue;
    }
    counters.push({ iface, rxBytes, txBytes });
  }
  return counters;
}

/** Parses /proc/uptime (seconds since boot). */
export function parseUptime(text: string): number | null {
  const seconds = Number(text.trim().split(/\s+/)[0]);
  return text.trim() && isCount(seconds) ? Math.floor(seconds) : null;
}

/** Filesystems that hold no user data. */
const PSEUDO_FILESYSTEMS = new Set([
  'tmpfs',
  'devtmpfs',
  'shm',
  'udev',
  'none',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'efivarfs',
]);
/** Mount points that are virtual or managed by the system. */
const PSEUDO_MOUNT_PREFIXES = ['/proc', '/sys', '/dev', '/run', '/snap'];

/**
 * Parses `df -P -k`. Rules (documented in docs/ARCHITECTURE.md):
 * - pseudo filesystems, loop devices (snaps) and system mounts are skipped;
 * - `overlay` is kept only as `/` (the root of a container);
 * - mounts with identical size/used/available are one filesystem seen
 *   through bind mounts: only the shortest mount path is kept;
 * - total = used + available, which excludes root-reserved blocks and
 *   matches df's own "Capacity" percentage.
 */
export function parseDf(text: string): DiskUsage[] {
  const lines = text.split('\n').filter((line) => line.trim());
  const byIdentity = new Map<string, DiskUsage>();

  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 6) continue;
    const [filesystem = '', , usedKib, availableKib] = fields;
    // Mount points may contain spaces: everything after the capacity column.
    const mount = fields.slice(5).join(' ');
    const used = Number(usedKib);
    const available = Number(availableKib);
    if (!isCount(used) || !isCount(available) || used + available === 0) continue;
    if (PSEUDO_FILESYSTEMS.has(filesystem) || filesystem.startsWith('/dev/loop')) continue;
    if (filesystem === 'overlay' && mount !== '/') continue;
    if (
      PSEUDO_MOUNT_PREFIXES.some((prefix) => mount === prefix || mount.startsWith(`${prefix}/`))
    ) {
      continue;
    }

    const identity = `${used}:${available}`;
    const existing = byIdentity.get(identity);
    if (existing && existing.mount.length <= mount.length) continue;
    byIdentity.set(identity, {
      mount,
      usedBytes: used * 1024,
      totalBytes: (used + available) * 1024,
    });
  }

  return [...byIdentity.values()].sort((a, b) => a.mount.localeCompare(b.mount));
}

/** "PRETTY_NAME" and kernel release -> "Ubuntu 24.04.1 LTS · 6.8.0-45-generic". */
export function parseOs(text: string): string | null {
  const parts = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}
