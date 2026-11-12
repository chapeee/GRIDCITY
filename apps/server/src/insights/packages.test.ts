import { describe, expect, it } from 'vitest';
import {
  createPackagesProducer,
  cvss3Score,
  osvEcosystem,
  parsePackages,
  vulnFacts,
} from './packages';

const NOW = Date.parse('2026-11-12T00:00:00Z');

describe('vulnerable packages', () => {
  it('computes CVSS 3.1 base scores like the official calculator', () => {
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H')).toBe(10);
    expect(cvss3Score('CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N')).toBe(5.5);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N')).toBe(3.1);
    expect(cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N')).toBe(0);
    expect(cvss3Score('garbage')).toBeNull();
  });

  it("maps /etc/os-release to OSV's ecosystem names", () => {
    expect(osvEcosystem('debian', '12')).toBe('Debian:12');
    expect(osvEcosystem('ubuntu', '24.04')).toBe('Ubuntu:24.04:LTS');
    expect(osvEcosystem('ubuntu', '24.10')).toBe('Ubuntu:24.10');
    expect(osvEcosystem('alpine', '3.20.3')).toBe('Alpine:v3.20');
    expect(osvEcosystem('rocky', '9.4')).toBe('Rocky Linux:9');
    expect(osvEcosystem('arch', '')).toBeNull();
  });

  it('reads dpkg and apk package lists', () => {
    const dpkg = parsePackages(
      '@@os debian 12\n@@format dpkg\nopenssl\t3.0.17-1~deb12u2\nopenssl\t3.0.17-1~deb12u2\nbash\t5.2.15-2+b7\n@@end',
    );
    expect(dpkg).toMatchObject({
      ecosystem: 'Debian:12',
      packages: [
        { name: 'openssl', version: '3.0.17-1~deb12u2' },
        { name: 'bash', version: '5.2.15-2+b7' },
      ],
    });
    const apk = parsePackages(
      '@@os alpine 3.20.3\n@@format apk\nbusybox-1.36.1-r29\nlibcrypto3-3.3.2-r0\n@@end',
    );
    expect(apk!.packages).toEqual([
      { name: 'busybox', version: '1.36.1-r29' },
      { name: 'libcrypto3', version: '3.3.2-r0' },
    ]);
    expect(parsePackages('@@os debian 12')).toBeNull();
  });

  it('keeps the score, CVE ids and the fixed version for this ecosystem', () => {
    const facts = vulnFacts(
      {
        id: 'DEBIAN-CVE-2025-9230',
        upstream: ['CVE-2025-9230'],
        details: 'Issue summary: An application trying to decrypt CMS messages…',
        severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }],
        affected: [
          {
            package: { name: 'openssl', ecosystem: 'Debian:12' },
            ranges: [{ events: [{ introduced: '0' }, { fixed: '3.0.17-1~deb12u3' }] }],
          },
          {
            package: { name: 'openssl', ecosystem: 'Debian:13' },
            ranges: [{ events: [{ fixed: '3.5.1-1' }] }],
          },
        ],
      },
      'Debian:12',
      NOW,
    );
    expect(facts).toMatchObject({
      score: 9.8,
      aliases: ['CVE-2025-9230'],
      fixed: { openssl: '3.0.17-1~deb12u3' },
    });
    expect(facts.summary).toBe('An application trying to decrypt CMS messages…');
  });

  it('turns OSV answers into one finding per server, severity from the worst fixable issue', async () => {
    const send = (async (url: string | URL) => {
      if (String(url).endsWith('/querybatch')) {
        return new Response(
          JSON.stringify({
            results: [{ vulns: [{ id: 'V1' }, { id: 'V2' }] }, {}, { vulns: [{ id: 'V3' }] }],
          }),
        );
      }
      const id = String(url).split('/').pop();
      const records: Record<string, unknown> = {
        V1: {
          id: 'V1',
          upstream: ['CVE-1'],
          severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N' }],
          affected: [
            {
              package: { name: 'openssl', ecosystem: 'Debian:12' },
              ranges: [{ events: [{ fixed: '3.0.18' }] }],
            },
          ],
        },
        V2: { id: 'V2', upstream: ['CVE-2'], affected: [] },
        V3: {
          id: 'V3',
          upstream: ['CVE-3'],
          severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:L/AC:L/PR:L/UI:N/S:U/C:L/I:N/A:N' }],
          affected: [],
        },
      };
      return new Response(JSON.stringify(records[id!]));
    }) as unknown as typeof fetch;
    const values = new Map<string, unknown>();
    const producer = createPackagesProducer({
      hosts: () => [
        {
          id: 'web',
          name: 'web-1',
          address: 'h',
          port: 22,
          user: 'u',
          district: 'D',
          tags: [],
          auth: { method: 'agent' },
        },
      ],
      runnerFor: () => ({
        exec: async () => ({
          stdout: '@@os debian 12\n@@format dpkg\nopenssl\t3.0.17\nbash\t5.2\nsystemd\t252\n@@end',
        }),
      }),
      fetch: send,
      cache: {
        getJson: <T>(k: string) => (values.get(k) as T) ?? null,
        setJson: (k, v) => void values.set(k, v),
      },
    });
    const [result] = await producer.run(NOW);
    expect(result!.drafts[0]).toMatchObject({
      severity: 'critical', // CVSS 9.1 for the fixable openssl issue
      title: '1 package on web-1 has security fixes waiting',
    });
    expect(result!.drafts[0]!.detail).toContain('openssl 3.0.17 → 3.0.18');
    expect(result!.drafts[0]!.detail).toContain('2 of 3 installed packages');
  });
});
