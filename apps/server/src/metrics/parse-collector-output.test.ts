import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  parseCollectorOutput,
  parseDf,
  parseLoadavg,
  parseMeminfo,
  parseNetDev,
  parseProcStat,
  parseUptime,
  splitSections,
} from './parse-collector-output';

/**
 * debian-* and alpine-* are real captures from `docker run <image> sh -s`
 * fed the collector script (Alpine uses busybox df). ubuntu-vm-synthetic is
 * hand-written to model a typical VM: snaps, docker bridges, a mount with spaces.
 */
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), 'utf8');

const KiB = 1024;

describe('parseCollectorOutput on a synthetic Ubuntu VM', () => {
  const sample = parseCollectorOutput(fixture('ubuntu-vm-synthetic'))!;

  it('parses CPU counters (idle includes iowait)', () => {
    expect(sample.cpu).toEqual({ idle: 3699176 + 23060, total: 3728158 });
  });

  it('computes used memory as MemTotal − MemAvailable, and swap', () => {
    expect(sample.memory).toEqual({
      usedBytes: (8131532 - 2045116) * KiB,
      totalBytes: 8131532 * KiB,
    });
    expect(sample.swap).toEqual({ usedBytes: 262144 * KiB, totalBytes: 2097148 * KiB });
  });

  it('parses load and uptime', () => {
    expect(sample.load).toEqual({ one: 1.42, five: 0.97, fifteen: 0.61 });
    expect(sample.uptimeSeconds).toBe(1296000);
  });

  it('keeps physical interfaces and skips loopback, docker and veth', () => {
    expect(sample.interfaces).toEqual([
      { iface: 'ens3', rxBytes: 9876543210, txBytes: 1234567890 },
    ]);
  });

  it('keeps real disks, skips tmpfs and snap loops, handles spaces in mount paths', () => {
    expect(sample.disks).toEqual([
      { mount: '/', usedBytes: 37450896 * KiB, totalBytes: (37450896 + 43639588) * KiB },
      { mount: '/boot/efi', usedBytes: 6250 * KiB, totalBytes: (6250 + 100582) * KiB },
      {
        mount: '/mnt/backup disk',
        usedBytes: 742398720 * KiB,
        totalBytes: (742398720 + 237151872) * KiB,
      },
    ]);
  });

  it('joins OS name and kernel release', () => {
    expect(sample.os).toBe('Ubuntu 24.04.1 LTS · 6.8.0-45-generic');
  });
});

describe.each(['debian-poll-1', 'alpine-poll-1'])(
  'parseCollectorOutput on real capture %s',
  (name) => {
    const sample = parseCollectorOutput(fixture(name))!;

    it('parses every section', () => {
      expect(sample.cpu?.total).toBeGreaterThan(0);
      expect(sample.memory?.totalBytes).toBeGreaterThan(0);
      expect(sample.load).not.toBeNull();
      expect(sample.uptimeSeconds).toBeGreaterThan(0);
      expect(sample.os).toMatch(/Linux/);
    });

    it('reports the container root once, not once per bind mount', () => {
      expect(sample.disks.map((disk) => disk.mount)).toEqual(['/']);
    });

    it('keeps eth0 and skips lo', () => {
      expect(sample.interfaces.map((i) => i.iface)).toEqual(['eth0']);
    });
  },
);

describe('truncated or broken output', () => {
  it('rejects output without the end marker (truncated)', () => {
    const truncated = fixture('ubuntu-vm-synthetic').replace('@@end', '');
    expect(splitSections(truncated)).toBeNull();
    expect(parseCollectorOutput(truncated)).toBeNull();
  });

  it('turns a missing section into unknown values, not zeros', () => {
    const sample = parseCollectorOutput('@@section stat\n@@section os\nLinux\n@@end\n')!;
    expect(sample.cpu).toBeNull();
    expect(sample.memory).toBeNull();
    expect(sample.load).toBeNull();
    expect(sample.uptimeSeconds).toBeNull();
    expect(sample.disks).toEqual([]);
    expect(sample.os).toBe('Linux');
  });

  it('handles CRLF line endings', () => {
    const sample = parseCollectorOutput(fixture('ubuntu-vm-synthetic').replace(/\n/g, '\r\n'));
    expect(sample?.load).toEqual({ one: 1.42, five: 0.97, fifteen: 0.61 });
  });
});

describe('individual parsers', () => {
  it('parseProcStat rejects garbage', () => {
    expect(parseProcStat('cpu  a b c d')).toBeNull();
    expect(parseProcStat('')).toBeNull();
  });

  it('parseMeminfo falls back to MemFree + Buffers + Cached on old kernels', () => {
    const { memory } = parseMeminfo(
      'MemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 100 kB\nCached: 300 kB',
    );
    expect(memory).toEqual({ usedBytes: 400 * KiB, totalBytes: 1000 * KiB });
  });

  it('parseMeminfo reports no memory when MemTotal is missing', () => {
    expect(parseMeminfo('MemFree: 10 kB').memory).toBeNull();
  });

  it('parseLoadavg and parseUptime reject empty input', () => {
    expect(parseLoadavg('')).toBeNull();
    expect(parseUptime('')).toBeNull();
  });

  it('parseNetDev skips header lines and malformed rows', () => {
    expect(parseNetDev('Inter-|   Receive\n face |bytes\n  eth1: x y\n')).toEqual([]);
  });

  it('parseDf skips filesystems reporting zero size', () => {
    expect(
      parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/x 0 0 0 0% /x'),
    ).toEqual([]);
  });
});
