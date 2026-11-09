import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { computeCpuPercent, computeNetworkRates, deriveRates } from './compute-sample';
import { parseCollectorOutput, type RawSample } from './parse-collector-output';

const fixture = (name: string) =>
  parseCollectorOutput(readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8'))!;

describe('computeCpuPercent', () => {
  it('is the busy share of elapsed jiffies', () => {
    expect(computeCpuPercent({ idle: 100, total: 200 }, { idle: 160, total: 300 })).toBe(40);
  });

  it('is unknown without a previous reading', () => {
    expect(computeCpuPercent(null, { idle: 1, total: 2 })).toBeNull();
  });

  it('is unknown when counters went backwards (reboot) or no time passed', () => {
    expect(computeCpuPercent({ idle: 500, total: 1000 }, { idle: 10, total: 20 })).toBeNull();
    expect(computeCpuPercent({ idle: 5, total: 10 }, { idle: 5, total: 10 })).toBeNull();
  });

  it('gives a plausible value for two real consecutive captures', () => {
    const percent = computeCpuPercent(fixture('debian-poll-1').cpu, fixture('debian-poll-2').cpu);
    expect(percent).not.toBeNull();
    expect(percent!).toBeGreaterThanOrEqual(0);
    expect(percent!).toBeLessThanOrEqual(100);
  });
});

describe('computeNetworkRates', () => {
  const before = [{ iface: 'eth0', rxBytes: 1000, txBytes: 500 }];

  it('divides byte deltas by elapsed seconds', () => {
    const after = [{ iface: 'eth0', rxBytes: 5000, txBytes: 1500 }];
    expect(computeNetworkRates(before, after, 2)).toEqual([
      { iface: 'eth0', rxBytesPerSec: 2000, txBytesPerSec: 500 },
    ]);
  });

  it('drops interfaces whose counters reset, and brand-new interfaces', () => {
    const after = [
      { iface: 'eth0', rxBytes: 10, txBytes: 10 },
      { iface: 'eth1', rxBytes: 99, txBytes: 99 },
    ];
    expect(computeNetworkRates(before, after, 2)).toEqual([]);
  });

  it('returns nothing when no time passed', () => {
    expect(computeNetworkRates(before, before, 0)).toEqual([]);
  });
});

describe('deriveRates', () => {
  const raw = fixture('ubuntu-vm-synthetic');

  it('has no rates on the first poll', () => {
    expect(deriveRates(null, { collectedAt: 0, raw })).toEqual({ cpuPercent: null, network: [] });
  });

  it('derives rates from two polls', () => {
    const later: RawSample = {
      ...raw,
      cpu: { idle: raw.cpu!.idle + 150, total: raw.cpu!.total + 200 },
      interfaces: [{ iface: 'ens3', rxBytes: 9876543210 + 4000, txBytes: 1234567890 + 2000 }],
    };
    expect(deriveRates({ collectedAt: 0, raw }, { collectedAt: 2000, raw: later })).toEqual({
      cpuPercent: 25,
      network: [{ iface: 'ens3', rxBytesPerSec: 2000, txBytesPerSec: 1000 }],
    });
  });
});
