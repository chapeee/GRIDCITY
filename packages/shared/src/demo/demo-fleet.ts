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

const DISTRICTS = ['AWS Mumbai', 'DigitalOcean', 'Home lab', 'Hetzner'] as const;

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
  // AWS Mumbai: Lekhix and Ausia
  {
    id: 'ausia-edge',
    district: 'AWS Mumbai',
    behavior: 'steady',
    address: '203.0.113.10',
    os: DEBIAN,
    cpuCores: 2,
    memoryGiB: 4,
    disks: [root(40, 0.31)],
    networkBytesPerSec: 6e6,
  },
  {
    id: 'ausia-web',
    district: 'AWS Mumbai',
    behavior: 'steady',
    address: '203.0.113.11',
    os: UBUNTU,
    cpuCores: 4,
    memoryGiB: 8,
    disks: [root(80, 0.46)],
    networkBytesPerSec: 2.5e6,
  },
  {
    id: 'lekhix-api',
    district: 'AWS Mumbai',
    behavior: 'busy-cpu',
    address: '203.0.113.12',
    os: UBUNTU,
    cpuCores: 8,
    memoryGiB: 16,
    disks: [root(160, 0.52)],
    networkBytesPerSec: 4e6,
  },
  {
    id: 'lekhix-web',
    district: 'AWS Mumbai',
    behavior: 'steady',
    address: '203.0.113.13',
    os: UBUNTU,
    cpuCores: 4,
    memoryGiB: 8,
    disks: [root(80, 0.44)],
    networkBytesPerSec: 2.2e6,
  },
  {
    id: 'lekhix-db',
    district: 'AWS Mumbai',
    behavior: 'memory-heavy',
    address: '203.0.113.20',
    os: DEBIAN,
    cpuCores: 8,
    memoryGiB: 64,
    disks: [root(60, 0.4), { mount: '/var/lib/postgresql', sizeGiB: 900, usedRatio: 0.71 }],
    networkBytesPerSec: 9e5,
  },
  {
    id: 'lekhix-backups',
    district: 'AWS Mumbai',
    behavior: 'disk-full',
    address: '203.0.113.30',
    os: DEBIAN,
    cpuCores: 2,
    memoryGiB: 4,
    disks: [root(2000, 0.94)],
    networkBytesPerSec: 3e5,
  },
  {
    id: 'lekhix-scraper',
    district: 'AWS Mumbai',
    behavior: 'steady',
    address: '203.0.113.14',
    os: UBUNTU,
    cpuCores: 4,
    memoryGiB: 8,
    disks: [root(80, 0.37)],
    networkBytesPerSec: 4e5,
  },
  // DigitalOcean: portfolio, SkillGen and side projects
  {
    id: 'myselfraj-web',
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
    id: 'skillgen-app',
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
    id: 'skillgen-redis',
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
    id: 'bugspoon-legacy',
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
    id: 'leadgent-queue',
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
    id: 'reverse-seo',
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
    id: 'home-nas',
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
    id: 'gridcity-lab',
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
    id: 'jellyfin',
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
  // Hetzner: open-source tools
  {
    id: 'gitsmith-docs',
    district: 'Hetzner',
    behavior: 'steady',
    address: '10.40.0.11',
    os: UBUNTU,
    cpuCores: 2,
    memoryGiB: 4,
    disks: [root(80, 0.4)],
    networkBytesPerSec: 9e5,
  },
  {
    id: 'bizmail-api',
    district: 'Hetzner',
    behavior: 'steady',
    address: '10.40.0.12',
    os: UBUNTU,
    cpuCores: 4,
    memoryGiB: 8,
    disks: [root(80, 0.48)],
    networkBytesPerSec: 1.4e6,
  },
  {
    id: 'whatson-db',
    district: 'Hetzner',
    behavior: 'steady',
    address: '10.40.0.20',
    os: DEBIAN,
    cpuCores: 4,
    memoryGiB: 16,
    disks: [root(40, 0.33), { mount: '/var/lib/mysql', sizeGiB: 400, usedRatio: 0.57 }],
    networkBytesPerSec: 5e5,
  },
  {
    id: 'formtest-cron',
    district: 'Hetzner',
    behavior: 'steady',
    address: '10.40.0.30',
    os: ALPINE,
    cpuCores: 1,
    memoryGiB: 1,
    disks: [root(20, 0.25)],
    networkBytesPerSec: 2e4,
  },
  {
    id: 'yuruper-staging',
    district: 'Hetzner',
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

/**
 * Life on steady hosts, so the city feels like a real fleet instead of a
 * still picture: a slow daily rhythm, plus incidents that come and go
 * (a busy job, a traffic surge, a memory leak, a reboot). All seeded, so a
 * given seed always plays the same story.
 */
export type DemoIncidentKind = 'cpu-spike' | 'traffic-surge' | 'memory-leak' | 'reboot';

interface DemoIncident {
  kind: DemoIncidentKind;
  /** Polls left; the leak ignores it and ends with a restart instead. */
  pollsLeft: number;
}

/** Polls of calm at the start, so the first view shows the scripted truth states. */
const INCIDENT_WARMUP_POLLS = 15;
/** Chance per poll that a new incident starts somewhere (when below the cap). */
const INCIDENT_CHANCE_PER_POLL = 0.08;
const MAX_ACTIVE_INCIDENTS = 2;
/** A host rests this many polls after an incident before it can have another. */
const INCIDENT_COOLDOWN_POLLS = 40;
/** One "day" of load rhythm, in polls (8 minutes at the default 2 s). */
const DAY_POLLS = 240;

const INCIDENT_DURATION: Record<DemoIncidentKind, [number, number]> = {
  'cpu-spike': [8, 22],
  'traffic-surge': [10, 28],
  'memory-leak': [0, 0],
  reboot: [4, 9],
};
const INCIDENT_KINDS = Object.keys(INCIDENT_DURATION) as DemoIncidentKind[];
/** Memory a leaking process adds each poll, and how long it sits near full before a restart. */
const LEAK_PER_POLL = 0.012;
const LEAK_RESTART_AT = 0.95;

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
  /** Incidents playing right now (for tests and curious readers; never shown as data). */
  activeIncidents(): { hostId: string; kind: DemoIncidentKind }[];
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
  /** Where in its daily rhythm this host is (0..1), so hosts don't move in lockstep. */
  dayPhase: number;
  /** Memory level it settles at when nothing is leaking. */
  memoryBaseline: number;
  incident: DemoIncident | null;
  /** Poll count before which no new incident may start here. */
  restUntilPoll: number;
  /** Set after a reconnect: the next poll has no previous sample, so rates are unknown. */
  freshConnection: boolean;
}

export function createDemoFleet(options: DemoFleetOptions = {}): DemoFleet {
  const random = createSeededRandom(options.seed ?? 7);
  const thresholds = options.thresholds ?? DEFAULT_STATUS_THRESHOLDS;
  const startedAt = options.startedAt ?? Date.now();
  const specs = buildSpecs(options.hostCount ?? DEMO_HOST_SPECS.length);

  const simulated: SimulatedHost[] = specs.map((spec) => {
    const memoryRatio = baselineMemoryRatio(spec, random);
    return {
      spec,
      cpuPercent: baselineCpu(spec, random),
      cpuBusyStreak: 0,
      load: { one: 0, five: 0, fifteen: 0 },
      memoryRatio,
      diskRatios: spec.disks.map((disk) => disk.usedRatio),
      pollCount: 0,
      bootedAt: startedAt - random.between(2, 120) * 86_400_000,
      lastState: null,
      dayPhase: random.next(),
      memoryBaseline: memoryRatio,
      incident: null,
      restUntilPoll: INCIDENT_WARMUP_POLLS,
      freshConnection: false,
    };
  });
  let fleetPolls = 0;

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
    activeIncidents: () =>
      simulated.flatMap((host) =>
        host.incident ? [{ hostId: host.spec.id, kind: host.incident.kind }] : [],
      ),
    tick: (now) => {
      fleetPolls += 1;
      if (fleetPolls > INCIDENT_WARMUP_POLLS) maybeStartIncident(simulated, random);
      return simulated.map((host) => tickHost(host, now, random, thresholds, startedAt));
    },
  };
}

/** Now and then, starts an incident on a rested steady host (at most a couple at once). */
function maybeStartIncident(hosts: SimulatedHost[], random: SeededRandom): void {
  const active = hosts.filter((host) => host.incident).length;
  if (active >= MAX_ACTIVE_INCIDENTS || random.next() >= INCIDENT_CHANCE_PER_POLL) return;
  const candidates = hosts.filter(
    (host) =>
      host.spec.behavior === 'steady' && !host.incident && host.pollCount >= host.restUntilPoll,
  );
  if (candidates.length === 0) return;
  const host = candidates[Math.floor(random.next() * candidates.length)];
  const kind = INCIDENT_KINDS[Math.floor(random.next() * INCIDENT_KINDS.length)];
  if (!host || !kind) return;
  const [min, max] = INCIDENT_DURATION[kind];
  host.incident = { kind, pollsLeft: Math.round(random.between(min, max)) };
}

/** Counts an incident down and ends it, letting the host rest afterwards. */
function advanceIncident(host: SimulatedHost, now: number): void {
  const { incident } = host;
  if (!incident) return;
  const finished =
    incident.kind === 'memory-leak'
      ? host.memoryRatio >= LEAK_RESTART_AT
      : --incident.pollsLeft <= 0;
  if (!finished) return;
  if (incident.kind === 'memory-leak') host.memoryRatio = host.memoryBaseline; // service restarted
  if (incident.kind === 'reboot') {
    host.bootedAt = now;
    host.freshConnection = true;
    host.memoryRatio = host.memoryBaseline;
  }
  host.incident = null;
  host.restUntilPoll = host.pollCount + INCIDENT_COOLDOWN_POLLS;
}

function buildSpecs(hostCount: number): DemoHostSpec[] {
  const specs = DEMO_HOST_SPECS.slice(0, hostCount);
  for (let index = specs.length; index < hostCount; index++) {
    const number = String(index + 1).padStart(2, '0');
    specs.push({
      id: `node-${number}`,
      district: DISTRICTS[index % DISTRICTS.length] ?? 'AWS Mumbai',
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

/** Where a host's CPU is heading this poll: its daily rhythm, or an incident's pull. */
function cpuTarget(host: SimulatedHost, random: SeededRandom): number {
  const { spec, incident } = host;
  if (spec.behavior !== 'steady') return baselineCpu(spec, random);
  if (incident?.kind === 'cpu-spike') return 97;
  // Busy afternoons, quiet nights: a slow wave, different for every host.
  const rhythm = 0.5 + 0.5 * Math.sin(2 * Math.PI * (host.pollCount / DAY_POLLS + host.dayPhase));
  const daily = 6 + 38 * rhythm + random.noise(6);
  return incident?.kind === 'traffic-surge' ? Math.min(daily + 30, 82) : daily;
}

function baselineMemoryRatio(spec: DemoHostSpec, random: SeededRandom): number {
  return spec.behavior === 'memory-heavy' ? 0.93 : random.between(0.25, 0.7);
}

function connectionPhaseAt(host: SimulatedHost): ConnectionPhase {
  if (host.incident?.kind === 'reboot') return 'failed';
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
      host.incident?.kind === 'reboot'
        ? `connect ECONNREFUSED ${spec.address}:22 (rebooting)`
        : spec.behavior === 'flapping'
          ? 'heartbeat lost (keepalive timeout)'
          : `connect ECONNREFUSED ${spec.address}:22`;
    // Offline means we do not know current metrics, so they are all unknown.
    const state = { ...emptyState(spec.id, lastSeenAt), error };
    host.cpuBusyStreak = 0;
    const offline = withStatus(
      state,
      connection,
      host.lastState !== null,
      host,
      thresholds,
      now,
      error,
    );
    advanceIncident(host, now);
    return offline;
  }

  const state = sampleHost(host, now, random, thresholds);
  host.lastState = state;
  advanceIncident(host, now);
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
  // Rates need two samples: unknown on the very first poll and right after a reconnect.
  const isFirstPoll = host.lastState === null || host.freshConnection;
  host.freshConnection = false;

  // CPU: mean-reverting random walk toward the target.
  const target = cpuTarget(host, random);
  host.cpuPercent = clamp(
    host.cpuPercent + (target - host.cpuPercent) * 0.25 + random.noise(7),
    0.5,
    100,
  );
  if (spec.behavior === 'busy-cpu') host.cpuPercent = clamp(host.cpuPercent, 91, 100);
  // A busy job ramps up over a few polls, then holds above the degraded line.
  if (host.incident?.kind === 'cpu-spike' && host.cpuPercent > 80) {
    host.cpuPercent = clamp(host.cpuPercent, 91, 100);
  }
  // Rates need two samples, exactly like the real poller: unknown on the first poll.
  const cpuPercent = isFirstPoll ? null : round(host.cpuPercent, 1);
  host.cpuBusyStreak = nextCpuBusyStreak(host.cpuBusyStreak, cpuPercent, thresholds);

  const runQueue = (host.cpuPercent / 100) * spec.cpuCores;
  host.load = {
    one: round(runQueue + Math.abs(random.noise(0.3)), 2),
    five: round(host.load.five * 0.9 + runQueue * 0.1, 2),
    fifteen: round(host.load.fifteen * 0.97 + runQueue * 0.03, 2),
  };

  const leak = host.incident?.kind === 'memory-leak' ? LEAK_PER_POLL : 0;
  host.memoryRatio = clamp(host.memoryRatio + leak + random.noise(0.01), 0.05, 0.99);
  if (spec.behavior === 'memory-heavy') host.memoryRatio = clamp(host.memoryRatio, 0.91, 0.97);
  const memoryTotal = spec.memoryGiB * GiB;

  const disks: DiskUsage[] = spec.disks.map((disk, index) => {
    const ratio = clamp((host.diskRatios[index] ?? disk.usedRatio) + random.noise(0.0005), 0, 1);
    host.diskRatios[index] = ratio;
    const totalBytes = disk.sizeGiB * GiB;
    return { mount: disk.mount, usedBytes: Math.round(totalBytes * ratio), totalBytes };
  });

  const network: NetworkRate[] = isFirstPoll
    ? []
    : [simulateInterface('eth0', spec, random, host.incident?.kind === 'traffic-surge')];

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

function simulateInterface(
  iface: string,
  spec: DemoHostSpec,
  random: SeededRandom,
  surging = false,
): NetworkRate {
  // Occasional bursts make the particle encoding visibly respond; a surge holds one.
  const burst = surging ? random.between(4, 7) : random.next() < 0.06 ? random.between(3, 8) : 1;
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
