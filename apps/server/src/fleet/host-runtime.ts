import {
  computeHostStatus,
  isStale,
  nextCpuBusyStreak,
  type ConnectionPhase,
  type HostState,
  type StatusThresholds,
} from '@app/shared';
import { deriveRates, type DerivedRates, type TimedSample } from '../metrics/compute-sample';
import type { PhaseChange } from '../ssh/host-connection';

/**
 * Everything the server knows about one host between polls. Updated by
 * pure functions; `buildHostState` turns it into what clients see.
 */
export interface HostRuntime {
  connection: ConnectionPhase;
  connectionError: string | null;
  hasPolled: boolean;
  lastSeenAt: number | null;
  /** Last successful poll, kept to compute the next rates. */
  previous: TimedSample | null;
  rates: DerivedRates | null;
  cpuBusyStreak: number;
  /** Last polling problem (timeout, bad output). Data stays as it was and goes stale. */
  pollError: string | null;
}

export function createHostRuntime(): HostRuntime {
  return {
    connection: 'connecting',
    connectionError: null,
    hasPolled: false,
    lastSeenAt: null,
    previous: null,
    rates: null,
    cpuBusyStreak: 0,
    pollError: null,
  };
}

export function applyPhaseChange(runtime: HostRuntime, change: PhaseChange): HostRuntime {
  switch (change.phase) {
    case 'connected':
      return { ...runtime, connection: 'connected', connectionError: null, pollError: null };
    case 'failed':
      return { ...runtime, connection: 'failed', connectionError: change.error, cpuBusyStreak: 0 };
    case 'connecting':
      // A retry after a failure is still offline until it succeeds: never
      // show a reconnecting host as anything but offline.
      return runtime.connection === 'failed' ? runtime : { ...runtime, connection: 'connecting' };
  }
}

export function applyPollSuccess(
  runtime: HostRuntime,
  sample: TimedSample,
  thresholds: StatusThresholds,
): HostRuntime {
  const rates = deriveRates(runtime.previous, sample);
  return {
    ...runtime,
    hasPolled: true,
    lastSeenAt: sample.collectedAt,
    previous: sample,
    rates,
    cpuBusyStreak: nextCpuBusyStreak(runtime.cpuBusyStreak, rates.cpuPercent, thresholds),
    pollError: null,
  };
}

/** Records a failed poll. Nothing else changes, so the data honestly goes stale. */
export function applyPollFailure(runtime: HostRuntime, message: string): HostRuntime {
  return { ...runtime, pollError: message };
}

export function buildHostState(
  hostId: string,
  runtime: HostRuntime,
  now: number,
  thresholds: StatusThresholds,
): HostState {
  const raw = runtime.previous?.raw ?? null;
  const offline = runtime.connection === 'failed';
  // Offline: current metrics are unknown, whatever we saw before.
  const metrics = offline || !raw ? null : raw;
  const cpuPercent = offline ? null : (runtime.rates?.cpuPercent ?? null);

  const { status, reason } = computeHostStatus(
    {
      connection: runtime.connection,
      hasPolled: runtime.hasPolled,
      cpuBusyStreak: runtime.cpuBusyStreak,
      sample: { cpuPercent, memory: metrics?.memory ?? null, disks: metrics?.disks ?? [] },
      connectionError: runtime.connectionError,
    },
    thresholds,
  );

  return {
    hostId,
    status,
    statusReason: reason,
    lastSeenAt: runtime.lastSeenAt,
    stale: !offline && isStale(runtime.lastSeenAt, now, thresholds),
    cpuPercent,
    load: metrics?.load ?? null,
    memory: metrics?.memory ?? null,
    swap: metrics?.swap ?? null,
    disks: metrics?.disks ?? [],
    network: offline ? [] : (runtime.rates?.network ?? []),
    uptimeSeconds: metrics?.uptimeSeconds ?? null,
    os: raw?.os ?? null,
    error: offline ? runtime.connectionError : runtime.pollError,
  };
}
