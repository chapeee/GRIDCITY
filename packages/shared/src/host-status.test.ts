import { describe, expect, it } from 'vitest';
import {
  computeHostStatus,
  findDegradedReasons,
  nextCpuBusyStreak,
  type HealthSample,
  type StatusInput,
} from './host-status';
import { DEFAULT_STATUS_THRESHOLDS as thresholds } from './thresholds';

const GiB = 1024 ** 3;

const healthySample: HealthSample = {
  cpuPercent: 20,
  memory: { usedBytes: 4 * GiB, totalBytes: 16 * GiB },
  disks: [{ mount: '/', usedBytes: 40 * GiB, totalBytes: 100 * GiB }],
};

const connectedInput: StatusInput = {
  connection: 'connected',
  hasPolled: true,
  cpuBusyStreak: 0,
  sample: healthySample,
};

describe('nextCpuBusyStreak', () => {
  it('counts consecutive polls above the threshold', () => {
    expect(nextCpuBusyStreak(0, 95, thresholds)).toBe(1);
    expect(nextCpuBusyStreak(2, 95, thresholds)).toBe(3);
  });

  it('resets when CPU drops to or below the threshold', () => {
    expect(nextCpuBusyStreak(5, 90, thresholds)).toBe(0);
  });

  it('resets when CPU is unknown', () => {
    expect(nextCpuBusyStreak(5, null, thresholds)).toBe(0);
  });
});

describe('findDegradedReasons', () => {
  it('ignores a CPU spike shorter than the required streak', () => {
    expect(findDegradedReasons({ ...healthySample, cpuPercent: 99 }, 2, thresholds)).toEqual([]);
  });

  it('reports sustained CPU, memory and every full disk', () => {
    const sample: HealthSample = {
      cpuPercent: 97,
      memory: { usedBytes: 15 * GiB, totalBytes: 16 * GiB },
      disks: [
        { mount: '/', usedBytes: 95 * GiB, totalBytes: 100 * GiB },
        { mount: '/data', usedBytes: 50 * GiB, totalBytes: 100 * GiB },
        { mount: '/var', usedBytes: 92 * GiB, totalBytes: 100 * GiB },
      ],
    };
    expect(findDegradedReasons(sample, 3, thresholds)).toEqual([
      'CPU 97% for 3 polls',
      'memory 94%',
      'disk / 95%',
      'disk /var 92%',
    ]);
  });

  it('skips disks with an unknown (zero) size', () => {
    const sample = { ...healthySample, disks: [{ mount: '/x', usedBytes: 1, totalBytes: 0 }] };
    expect(findDegradedReasons(sample, 0, thresholds)).toEqual([]);
  });
});

describe('computeHostStatus', () => {
  it('is offline when the connection failed, with the error as reason', () => {
    expect(
      computeHostStatus(
        { ...connectedInput, connection: 'failed', connectionError: 'ECONNREFUSED' },
        thresholds,
      ),
    ).toEqual({ status: 'offline', reason: 'ECONNREFUSED' });
  });

  it('is offline even if earlier polls succeeded', () => {
    expect(computeHostStatus({ ...connectedInput, connection: 'failed' }, thresholds).status).toBe(
      'offline',
    );
  });

  it('is unknown before the first successful poll', () => {
    expect(computeHostStatus({ ...connectedInput, hasPolled: false }, thresholds).status).toBe(
      'unknown',
    );
  });

  it('is degraded when a threshold is broken', () => {
    const sample = { ...healthySample, memory: { usedBytes: 15 * GiB, totalBytes: 16 * GiB } };
    expect(computeHostStatus({ ...connectedInput, sample }, thresholds)).toEqual({
      status: 'degraded',
      reason: 'memory 94%',
    });
  });

  it('is online when everything is within thresholds', () => {
    expect(computeHostStatus(connectedInput, thresholds).status).toBe('online');
  });

  it('respects custom thresholds', () => {
    const strict = { ...thresholds, diskDegradedPercent: 30 };
    expect(computeHostStatus(connectedInput, strict).status).toBe('degraded');
  });
});
