import type { Host } from '../host';
import type { DiskUsage, HostState, NetworkRate } from '../host-state';
import { computeHostStatus, nextCpuBusyStreak, type ConnectionPhase } from '../host-status';
import { isStale } from '../staleness';
import { DEFAULT_STATUS_THRESHOLDS, type StatusThresholds } from '../thresholds';
import { createSeededRandom, type SeededRandom } from './seeded-random';

/**
 * Demo mode: a fake fleet so the world can be developed and screenshotted
 * without real servers. It runs every sample through the *real* status rules,
 * so demo hosts show the same truth states real hosts will (unknown, online,
 * degraded, offline, stale).
 *
 * Demo data is never mixed with real data: whoever uses this fleet must
 * announce `dataMode: 'demo'` so the UI shows the "DEMO DATA" badge.
 */

/** How a demo host behaves over time. Each one exercises a visual truth state. */
export type DemoBehavior =
  /** Healthy, gently fluctuating metrics. */
  | 'steady'
  /** CPU stays above 90%: becomes `degraded` after the required streak. */
  | 'busy-cpu'
  /** Memory above 90%. */
  | 'memory-heavy'
  /** Root disk above 90%. */
  | 'disk-full'
  /** Never connects: `offline` with an error. */
  | 'offline'
  /** Alternates between connected and heartbeat lost. */
  | 'flapping'
  /** Polled once, then the poller got stuck: data goes `stale`. */
  | 'goes-stale'
  /** Still connecting: stays `unknown`. */
  | 'never-polled';

interface DemoHostSpec {
  id: string;
  district: string;
  behavior: DemoBehavior;
  address: string;
  os: string;
  cpuCores: number;
  memoryGiB: number;
  disks: { mount: string; sizeGiB: number; usedRatio: number }[];
  /** Typical combined throughput per interface, bytes/second. */
  networkBytesPerSec: number;
}

const DISTRICTS = ['Hetzner', 'DigitalOcean', 'Home lab', 'Client X'] as const;

const UBUNTU = 'Ubuntu 24.04.1 LTS · 6.8.0-45-generic';
const DEBIAN = 'Debian GNU/Linux 12 · 6.1.0-26-amd64';
const ALPINE = 'Alpine Linux 3.20 · 6.6.54-0-lts';
const RASPBIAN = 'Raspberry Pi OS 12 · 6.6.51+rpt-rpi-v8';

const root = (sizeGiB: number, usedRatio: number) => ({ mount: '/', sizeGiB, usedRatio });

/**
 * The hand-written demo fleet. Addresses use documentation ranges
 * (RFC 5737) and private ranges, so they never point at real machines.
 */
const DEMO_HOST_SPECS: DemoHostSpec[] = [
  // Hetzner
  {
    id: 'edge-proxy',
    district: 'Hetzner',
    behavior: 'steady',
    address: '203.0.113.10',
    os: DEBIAN,
    cpuCores: 2,
    memoryGiB: 4,
    disks: [root(40, 0.31)],
    networkBytesPerSec: 6e6,
  },
  {
    id: 'web-01',
    district: 'Hetzner',
    behavior: 'steady',
    address: '203.0.113.11',
    os: UBUNTU,
    cpuCores: 4,
    memoryGiB: 8,
    disks: [root(80, 0.46)],
    networkBytesPerSec: 2.5e6,
  },
  {
    id: 'api-01',
    district: 'Hetzner',
    behavior: 'busy-cpu',
    address: '203.0.113.12',
    os: UBUNTU,
    cpuCores: 8,
    memoryGiB: 16,
    disks: [root(160, 0.52)],
    networkBytesPerSec: 4e6,
  },
  {
    id: 'web-02',
    district: 'Hetzner',
    behavior: 'steady',
    address: '203.0.113.13',
    os: UBUNTU,
    cpuCores: 4,
    memoryGiB: 8,
    disks: [root(80, 0.44)],
    networkBytesPerSec: 2.2e6,
  },
  {
    id: 'db-primary',
    district: 'Hetzner',
    behavior: 'memory-heavy',
    address: '203.0.113.20',
    os: DEBIAN,
    cpuCores: 8,
    memoryGiB: 64,
    disks: [root(60, 0.4), { mount: '/var/lib/postgresql', sizeGiB: 900, usedRatio: 0.71 }],
    networkBytesPerSec: 9e5,
  },
  {
    id: 'backup-store',
    district: 'Hetzner',
    behavior: 'disk-full',
    address: '203.0.113.30',
    os: DEBIAN,
    cpuCores: 2,
    memoryGiB: 4,
    disks: [root(2000, 0.94)],
    networkBytesPerSec: 3e5,
  },
  {
    id: 'worker-01',
    district: 'Hetzner',
    behavior: 'steady',
    address: '203.0.113.14',
    os: UBUNTU,
    cpuCores: 4,
    memoryGiB: 8,
    disks: [root(80, 0.37)],
    networkBytesPerSec: 4e5,
  },
  // DigitalOcean
  {
    id: 'app-01',
    district: 'DigitalOcean',
    behavior: 'steady',
    address: '198.51.100.21',
    os: UBUNTU,
    cpuCores: 2,
    memoryGiB: 4,
    disks: [root(80, 0.58)],
    networkBytesPerSec: 1.2e6,
  },
  {
    id: 'app-02',
    district: 'DigitalOcean',
    behavior: 'flapping',
    address: '198.51.100.22',
    os: UBUNTU,
    cpuCores: 2,
    memoryGiB: 4,
    disks: [root(80, 0.55)],
    networkBytesPerSec: 1.1e6,
  },
  {
    id: 'redis',
    district: 'DigitalOcean',
    behavior: 'steady',
    address: '198.51.100.30',
    os: ALPINE,
    cpuCores: 1,
    memoryGiB: 2,
    disks: [root(25, 0.22)],
    networkBytesPerSec: 3e6,
  },
  {
    id: 'legacy-vps',
    district: 'DigitalOcean',
    behavior: 'offline',
    address: '198.51.100.99',
    os: DEBIAN,
    cpuCores: 1,
    memoryGiB: 1,
    disks: [root(25, 0.8)],
    networkBytesPerSec: 1e4,
  },
  {
    id: 'queue',
    district: 'DigitalOcean',
    behavior: 'steady',
    address: '198.51.100.31',
    os: ALPINE,
    cpuCores: 1,
    memoryGiB: 2,
    disks: [root(25, 0.18)],
    networkBytesPerSec: 6e5,
  },
  {
    id: 'metrics',
    district: 'DigitalOcean',
    behavior: 'steady',
    address: '198.51.100.40',
    os: UBUNTU,
    cpuCores: 2,
    memoryGiB: 4,
    disks: [root(160, 0.63)],
    networkBytesPerSec: 8e5,
  },
  // Home lab
  {
    id: 'nas',
    district: 'Home lab',
    behavior: 'steady',
    address: '192.168.1.10',
    os: DEBIAN,
    cpuCores: 4,
    memoryGiB: 16,
    disks: [
      root(120, 0.3),
      { mount: '/tank', sizeGiB: 8000, usedRatio: 0.68 },
      { mount: '/backup', sizeGiB: 4000, usedRatio: 0.41 },
    ],
    networkBytesPerSec: 1.5e7,
  },
  {
    id: 'pihole',
    district: 'Home lab',
    behavior: 'steady',
    address: '192.168.1.2',
    os: RASPBIAN,
    cpuCores: 4,
    memoryGiB: 1,
    disks: [root(32, 0.27)],
    networkBytesPerSec: 4e4,
  },
  {
    id: 'lab-01',
    district: 'Home lab',
    behavior: 'goes-stale',
    address: '192.168.1.20',
    os: UBUNTU,
    cpuCores: 8,
    memoryGiB: 32,
    disks: [root(500, 0.49)],
    networkBytesPerSec: 2e5,
  },
  {
    id: 'media',
    district: 'Home lab',
    behavior: 'steady',
    address: '192.168.1.15',
    os: UBUNTU,
    cpuCores: 4,
    memoryGiB: 8,
    disks: [root(240, 0.35), { mount: '/media', sizeGiB: 4000, usedRatio: 0.83 }],
    networkBytesPerSec: 2.4e7,
  },
  {
    id: 'garage-pi',
    district: 'Home lab',
    behavior: 'never-polled',
    address: '192.168.1.42',
    os: RASPBIAN,
    cpuCores: 4,
    memoryGiB: 2,
    disks: [root(64, 0.2)],
    networkBytesPerSec: 1e4,
  },
  // Client X
  {
    id: 'cx-web',
    district: 'Client X',
    behavior: 'steady',
    address: '10.40.0.11',
    os: UBUNTU,
    cpuCores: 2,
    memoryGiB: 4,
    disks: [root(80, 0.4)],
    networkBytesPerSec: 9e5,
  },
  {
    id: 'cx-api',
    district: 'Client X',
    behavior: 'steady',
    address: '10.40.0.12',
    os: UBUNTU,
    cpuCores: 4,
    memoryGiB: 8,
    disks: [root(80, 0.48)],
    networkBytesPerSec: 1.4e6,
  },
  {
    id: 'cx-db',
    district: 'Client X',
    behavior: 'steady',
    address: '10.40.0.20',
    os: DEBIAN,
    cpuCores: 4,
    memoryGiB: 16,
    disks: [root(40, 0.33), { mount: '/var/lib/mysql', sizeGiB: 400, usedRatio: 0.57 }],
    networkBytesPerSec: 5e5,
  },
  {
    id: 'cx-cron',
    district: 'Client X',
    behavior: 'steady',
    address: '10.40.0.30',
    os: ALPINE,
    cpuCores: 1,
    memoryGiB: 1,
    disks: [root(20, 0.25)],
    networkBytesPerSec: 2e4,
  },
  {
    id: 'cx-staging',
    district: 'Client X',
    behavior: 'steady',
    address: '10.40.0.40',
    os: UBUNTU,
    cpuCores: 2,
    memoryGiB: 4,
    disks: [root(80, 0.61)],
    networkBytesPerSec: 3e5,
  },
];

const GiB = 1024 ** 3;

/** Seconds the stuck poller has been silent when the demo starts. */
const STALE_HOST_SILENT_FOR_MS = 45_000;
/** A flapping host is connected for this many polls, then lost for the rest of the cycle. */
const FLAP_CYCLE_POLLS = 15;
const FLAP_CONNECTED_POLLS = 10;

export interface DemoFleetOptions {
  /** Seed for reproducible data. */
  seed?: number;
  /** Number of hosts. Extra hosts beyond the hand-written fleet are generated as steady. */
  hostCount?: number;
  /** Status thresholds; `pollIntervalMs` also sets how often callers should tick. */
  thresholds?: StatusThresholds;
  /** Epoch ms when the demo starts (used for uptime and the stale host). */
  startedAt?: number;
}

export interface DemoFleet {
  readonly hosts: readonly Host[];
  readonly thresholds: StatusThresholds;
  /** Advances the simulation by one poll and returns the state of every host. */
  tick(now: number): HostState[];
}

/** Mutable per-host simulation state. */
interface SimulatedHost {
  spec: DemoHostSpec;
  cpuPercent: number;
  cpuBusyStreak: number;
  load: { one: number; five: number; fifteen: number };
  memoryRatio: number;
  diskRatios: number[];
  pollCount: number;
  bootedAt: number;
  /** Last state handed out; reused when the host stops producing data. */
  lastState: HostState | null;
}

export function createDemoFleet(options: DemoFleetOptions = {}): DemoFleet {
  const random = createSeededRandom(options.seed ?? 7);
  const thresholds = options.thresholds ?? DEFAULT_STATUS_THRESHOLDS;
  const startedAt = options.startedAt ?? Date.now();
  const specs = buildSpecs(options.hostCount ?? DEMO_HOST_SPECS.length);

  const simulated: SimulatedHost[] = specs.map((spec) => ({
    spec,
    cpuPercent: baselineCpu(spec, random),
    cpuBusyStreak: 0,
    load: { one: 0, five: 0, fifteen: 0 },
    memoryRatio: baselineMemoryRatio(spec, random),
    diskRatios: spec.disks.map((disk) => disk.usedRatio),
    pollCount: 0,
    bootedAt: startedAt - random.between(2, 120) * 86_400_000,
    lastState: null,
  }));

  const hosts: Host[] = specs.map((spec) => ({
    id: spec.id,
    name: spec.id,
    address: spec.address,
    port: 22,
    user: 'ops',
    district: spec.district,
    tags: [spec.behavior === 'steady' ? 'demo' : `demo:${spec.behavior}`],
    auth: { method: 'agent' },
  }));

  return {
    hosts,
    thresholds,
    tick: (now) => simulated.map((host) => tickHost(host, now, random, thresholds, startedAt)),
  };
}

function buildSpecs(hostCount: number): DemoHostSpec[] {
  const specs = DEMO_HOST_SPECS.slice(0, hostCount);
  for (let index = specs.length; index < hostCount; index++) {
    const number = String(index + 1).padStart(2, '0');
    specs.push({
      id: `node-${number}`,
      district: DISTRICTS[index % DISTRICTS.length] ?? 'Hetzner',
      behavior: 'steady',
      address: `10.99.${Math.floor(index / 250)}.${(index % 250) + 1}`,
      os: UBUNTU,
      cpuCores: 2,
      memoryGiB: 4,
      disks: [root(80, 0.3 + (index % 5) * 0.08)],
      networkBytesPerSec: 2e5 * ((index % 7) + 1),
    });
  }
  return specs;
}

function baselineCpu(spec: DemoHostSpec, random: SeededRandom): number {
  return spec.behavior === 'busy-cpu' ? 96 : random.between(4, 45);
}

function baselineMemoryRatio(spec: DemoHostSpec, random: SeededRandom): number {
  return spec.behavior === 'memory-heavy' ? 0.93 : random.between(0.25, 0.7);
}

function connectionPhaseAt(host: SimulatedHost): ConnectionPhase {
  switch (host.spec.behavior) {
    case 'offline':
      return 'failed';
    case 'never-polled':
      return 'connecting';
    case 'flapping':
      return host.pollCount % FLAP_CYCLE_POLLS < FLAP_CONNECTED_POLLS ? 'connected' : 'failed';
    default:
      return 'connected';
  }
}

function tickHost(
  host: SimulatedHost,
  now: number,
  random: SeededRandom,
  thresholds: StatusThresholds,
  startedAt: number,
): HostState {
  const { spec } = host;

  // A stuck poller: one sample from the past, then silence. Only staleness changes.
  if (spec.behavior === 'goes-stale') {
    if (!host.lastState) {
      host.lastState = sampleHost(host, startedAt - STALE_HOST_SILENT_FOR_MS, random, thresholds);
    }
    return { ...host.lastState, stale: isStale(host.lastState.lastSeenAt, now, thresholds) };
  }

  const connection = connectionPhaseAt(host);
  host.pollCount += 1;

  if (connection === 'connecting') {
    return withStatus(emptyState(spec.id, null), connection, false, host, thresholds, now);
  }

  if (connection === 'failed') {
    const lastSeenAt = host.lastState?.lastSeenAt ?? null;
    const error =
      spec.behavior === 'flapping'
        ? 'heartbeat lost (keepalive timeout)'
        : `connect ECONNREFUSED ${spec.address}:22`;
    // Offline means we do not know current metrics, so they are all unknown.
    const state = { ...emptyState(spec.id, lastSeenAt), error };
    host.cpuBusyStreak = 0;
    return withStatus(state, connection, host.lastState !== null, host, thresholds, now, error);
  }

  const state = sampleHost(host, now, random, thresholds);
  host.lastState = state;
  return state;
}

/** Produces one successful poll: metrics plus status. */
function sampleHost(
  host: SimulatedHost,
  now: number,
  random: SeededRandom,
  thresholds: StatusThresholds,
): HostState {
  const { spec } = host;
  const isFirstPoll = host.lastState === null;

  // CPU: mean-reverting random walk around the baseline.
  const target = baselineCpu(spec, random);
  host.cpuPercent = clamp(
    host.cpuPercent + (target - host.cpuPercent) * 0.25 + random.noise(7),
    0.5,
    100,
  );
  if (spec.behavior === 'busy-cpu') host.cpuPercent = clamp(host.cpuPercent, 91, 100);
  // Rates need two samples, exactly like the real poller: unknown on the first poll.
  const cpuPercent = isFirstPoll ? null : round(host.cpuPercent, 1);
  host.cpuBusyStreak = nextCpuBusyStreak(host.cpuBusyStreak, cpuPercent, thresholds);

  const runQueue = (host.cpuPercent / 100) * spec.cpuCores;
  host.load = {
    one: round(runQueue + Math.abs(random.noise(0.3)), 2),
    five: round(host.load.five * 0.9 + runQueue * 0.1, 2),
    fifteen: round(host.load.fifteen * 0.97 + runQueue * 0.03, 2),
  };

  host.memoryRatio = clamp(host.memoryRatio + random.noise(0.01), 0.05, 0.99);
  if (spec.behavior === 'memory-heavy') host.memoryRatio = clamp(host.memoryRatio, 0.91, 0.97);
  const memoryTotal = spec.memoryGiB * GiB;

  const disks: DiskUsage[] = spec.disks.map((disk, index) => {
    const ratio = clamp((host.diskRatios[index] ?? disk.usedRatio) + random.noise(0.0005), 0, 1);
    host.diskRatios[index] = ratio;
    const totalBytes = disk.sizeGiB * GiB;
    return { mount: disk.mount, usedBytes: Math.round(totalBytes * ratio), totalBytes };
  });

  const network: NetworkRate[] = isFirstPoll ? [] : [simulateInterface('eth0', spec, random)];

  const state: HostState = {
    ...emptyState(spec.id, now),
    cpuPercent,
    load: host.load,
    memory: { usedBytes: Math.round(memoryTotal * host.memoryRatio), totalBytes: memoryTotal },
    swap: { usedBytes: Math.round(0.05 * GiB * random.next()), totalBytes: 2 * GiB },
    disks,
    network,
    uptimeSeconds: Math.round((now - host.bootedAt) / 1000),
    os: spec.os,
  };
  return withStatus(state, 'connected', true, host, thresholds, now);
}

function simulateInterface(iface: string, spec: DemoHostSpec, random: SeededRandom): NetworkRate {
  // Occasional bursts make the particle encoding visibly respond.
  const burst = random.next() < 0.06 ? random.between(3, 8) : 1;
  const total = spec.networkBytesPerSec * random.between(0.5, 1.4) * burst;
  const rxShare = random.between(0.55, 0.8);
  return {
    iface,
    rxBytesPerSec: Math.round(total * rxShare),
    txBytesPerSec: Math.round(total * (1 - rxShare)),
  };
}

function withStatus(
  state: HostState,
  connection: ConnectionPhase,
  hasPolled: boolean,
  host: SimulatedHost,
  thresholds: StatusThresholds,
  now: number,
  connectionError: string | null = null,
): HostState {
  const { status, reason } = computeHostStatus(
    {
      connection,
      hasPolled,
      cpuBusyStreak: host.cpuBusyStreak,
      sample: { cpuPercent: state.cpuPercent, memory: state.memory, disks: state.disks },
      connectionError,
    },
    thresholds,
  );
  return {
    ...state,
    status,
    statusReason: reason,
    stale: isStale(state.lastSeenAt, now, thresholds),
  };
}

/** A state with every metric unknown. */
function emptyState(hostId: string, lastSeenAt: number | null): HostState {
  return {
    hostId,
    status: 'unknown',
    statusReason: null,
    lastSeenAt,
    stale: false,
    cpuPercent: null,
    load: null,
    memory: null,
    swap: null,
    disks: [],
    network: [],
    uptimeSeconds: null,
    os: null,
    error: null,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
