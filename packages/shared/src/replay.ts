import { z } from 'zod';
import { createDemoHistory } from './demo/demo-history';
import { HostStatusSchema, type HostState } from './host-state';
import { EMPTY_GAUGES, type ResourceState } from './resource';

/**
 * Time travel: the city as it was at one moment, rebuilt from what was
 * really recorded (30-second metric buckets and status transitions). It is
 * never mixed with live data: the client swaps the whole picture while a
 * REPLAY badge is on screen, and anything not recorded at that moment is
 * shown as unknown, never guessed.
 */
export const ReplayTargetSchema = z.object({
  status: HostStatusSchema,
  reason: z.string().nullable(),
  cpuPercent: z.number().nullable(),
  memoryPercent: z.number().nullable(),
  maxDiskPercent: z.number().nullable(),
  networkBytesPerSec: z.number().nullable(),
  loadOne: z.number().nullable(),
});
export type ReplayTarget = z.infer<typeof ReplayTargetSchema>;

export const ReplayFrameSchema = z.object({
  at: z.number().int(),
  /** Hosts with a recorded bucket or status at that moment. Others were not measured. */
  hosts: z.record(z.string(), ReplayTargetSchema),
  /** Resources: their status then (only status transitions are recorded for them). */
  resources: z.record(
    z.string(),
    z.object({ status: HostStatusSchema, reason: z.string().nullable() }),
  ),
});
export type ReplayFrame = z.infer<typeof ReplayFrameSchema>;

const PERCENT_SCALE = 100;

/**
 * A host state for the 3D city from a replay target. Percentages become
 * used/total pairs on a 0..100 scale (the encodings only use the ratio), the
 * fullest disk becomes one disk, and total traffic one interface. Data is
 * stamped at the frame time, so nothing looks stale or live by accident.
 */
export function replayHostState(
  hostId: string,
  target: ReplayTarget | undefined,
  at: number,
): HostState {
  if (!target) {
    return {
      hostId,
      status: 'unknown',
      statusReason: 'no data recorded at this moment',
      lastSeenAt: null,
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
  const offline = target.status === 'offline';
  return {
    hostId,
    status: target.status,
    statusReason: target.reason,
    lastSeenAt: offline ? null : at,
    stale: false,
    cpuPercent: offline ? null : target.cpuPercent,
    load:
      target.loadOne === null || offline
        ? null
        : { one: target.loadOne, five: target.loadOne, fifteen: target.loadOne },
    memory:
      target.memoryPercent === null || offline
        ? null
        : { usedBytes: target.memoryPercent, totalBytes: PERCENT_SCALE },
    swap: null,
    disks:
      target.maxDiskPercent === null || offline
        ? []
        : [{ mount: 'fullest disk', usedBytes: target.maxDiskPercent, totalBytes: PERCENT_SCALE }],
    network:
      target.networkBytesPerSec === null || offline
        ? []
        : [
            {
              iface: 'all',
              rxBytesPerSec: target.networkBytesPerSec / 2,
              txBytesPerSec: target.networkBytesPerSec / 2,
            },
          ],
    uptimeSeconds: null,
    os: null,
    error: offline ? target.reason : null,
  };
}

export function replayResourceState(
  resourceId: string,
  target: ReplayFrame['resources'][string] | undefined,
  at: number,
): ResourceState {
  return {
    resourceId,
    status: target?.status ?? 'unknown',
    statusReason: target ? target.reason : 'no data recorded at this moment',
    lastSeenAt: target && target.status !== 'offline' ? at : null,
    stale: false,
    pollIntervalMs: 60_000,
    gauges: EMPTY_GAUGES,
    metrics: [],
    error: target?.status === 'offline' ? target.reason : null,
  };
}

/**
 * The demo city's past, generated the same way as its history panel (and
 * labelled DEMO DATA like everything in the demo): daily load waves and the
 * same incidents, so scrubbing shows the outages the history lists.
 */
export function createDemoReplayFrame(
  hostIds: readonly string[],
  resourceIds: readonly string[],
  at: number,
  now: number,
): ReplayFrame {
  const all = [...hostIds, ...resourceIds];
  const incidents = createDemoHistory(all, null, now, 7).incidents;
  const statusAt = (id: string) => {
    const active = incidents.find(
      (i) => i.targetId === id && at >= i.startedAt && at <= (i.endedAt ?? now),
    );
    return active
      ? { status: active.status, reason: active.reason }
      : { status: 'online' as const, reason: null };
  };
  const hosts: ReplayFrame['hosts'] = {};
  for (const id of hostIds) {
    const { status, reason } = statusAt(id);
    const seed = hashText(id);
    const hour = new Date(at).getHours() + new Date(at).getMinutes() / 60;
    const daily = Math.sin(((hour - 8) / 24) * Math.PI * 2) * 0.5 + 0.5;
    const wobble = Math.sin(at / 600_000 + seed) * 6;
    const cpu = Math.min(
      100,
      Math.max(1, 12 + (seed % 25) + daily * 35 + wobble + (status === 'degraded' ? 45 : 0)),
    );
    hosts[id] = {
      status,
      reason,
      cpuPercent: status === 'offline' ? null : cpu,
      memoryPercent: status === 'offline' ? null : Math.min(99, 35 + (seed % 30) + daily * 12),
      maxDiskPercent: status === 'offline' ? null : 40 + (seed % 45),
      networkBytesPerSec: status === 'offline' ? null : 2e5 * (1 + (seed % 9)) * (0.3 + daily),
      loadOne: status === 'offline' ? null : (cpu / 100) * 4,
    };
  }
  const resources: ReplayFrame['resources'] = {};
  for (const id of resourceIds) resources[id] = statusAt(id);
  return { at, hosts, resources };
}

function hashText(text: string): number {
  let value = 2166136261;
  for (let i = 0; i < text.length; i++) value = Math.imul(value ^ text.charCodeAt(i), 16777619);
  return value >>> 0;
}
