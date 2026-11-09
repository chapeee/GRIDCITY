import type { NetworkRate } from '@app/shared';
import type { InterfaceCounters, RawSample } from './parse-collector-output';

/** A raw sample plus the time it was collected (epoch ms, local clock). */
export interface TimedSample {
  collectedAt: number;
  raw: RawSample;
}

/** Rates derived from two consecutive polls. */
export interface DerivedRates {
  /** Null on the first poll, after a counter reset, or when no time passed. */
  cpuPercent: number | null;
  /** Empty on the first poll; interfaces whose counters reset are left out. */
  network: NetworkRate[];
}

/**
 * CPU usage between two /proc/stat readings:
 * busy share of the elapsed jiffies = 1 − Δidle / Δtotal.
 */
export function computeCpuPercent(
  previous: RawSample['cpu'],
  current: RawSample['cpu'],
): number | null {
  if (!previous || !current) return null;
  const totalDelta = current.total - previous.total;
  const idleDelta = current.idle - previous.idle;
  // No elapsed time, or counters went backwards (reboot): no honest value.
  if (totalDelta <= 0 || idleDelta < 0) return null;
  const percent = (1 - idleDelta / totalDelta) * 100;
  return Math.round(Math.min(100, Math.max(0, percent)) * 10) / 10;
}

/** Bytes per second per interface between two /proc/net/dev readings. */
export function computeNetworkRates(
  previous: readonly InterfaceCounters[],
  current: readonly InterfaceCounters[],
  elapsedSeconds: number,
): NetworkRate[] {
  if (elapsedSeconds <= 0) return [];
  const previousByName = new Map(previous.map((counters) => [counters.iface, counters]));
  const rates: NetworkRate[] = [];
  for (const counters of current) {
    const before = previousByName.get(counters.iface);
    if (!before) continue; // new interface: no delta yet
    const rx = counters.rxBytes - before.rxBytes;
    const tx = counters.txBytes - before.txBytes;
    if (rx < 0 || tx < 0) continue; // counter wrapped or interface reset
    rates.push({
      iface: counters.iface,
      rxBytesPerSec: Math.round(rx / elapsedSeconds),
      txBytesPerSec: Math.round(tx / elapsedSeconds),
    });
  }
  return rates;
}

/** Rates for the current poll given the previous one (or none on the first poll). */
export function deriveRates(previous: TimedSample | null, current: TimedSample): DerivedRates {
  if (!previous) return { cpuPercent: null, network: [] };
  const elapsedSeconds = (current.collectedAt - previous.collectedAt) / 1000;
  return {
    cpuPercent: computeCpuPercent(previous.raw.cpu, current.raw.cpu),
    network: computeNetworkRates(previous.raw.interfaces, current.raw.interfaces, elapsedSeconds),
  };
}
