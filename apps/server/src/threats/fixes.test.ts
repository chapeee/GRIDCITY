import type { ThreatFinding } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { applyFix, fixesFor, isSafeIp } from './fixes';

const finding = (over: Partial<ThreatFinding>): ThreatFinding => ({
  id: 'web:brute-force:203.0.113.9',
  targetId: 'web',
  source: 'builtin',
  severity: 'high',
  category: 'brute-force',
  title: 't',
  detail: 'd',
  advice: 'a',
  attackerIp: '203.0.113.9',
  count: 1,
  firstSeen: 0,
  lastSeen: 0,
  blocked: null,
  status: 'open',
  resolvedAt: null,
  ...over,
});

const context = { env: {}, homeDir: '/', appName: 't', now: Date.now };

describe('one-click fixes', () => {
  it('offers blocking an attacker, locking an account and closing a bucket', () => {
    expect(fixesFor(finding({}), true, false).map((f) => f.id)).toEqual(['block-ip']);
    expect(fixesFor(finding({ blocked: true }), true, false)).toEqual([]);
    expect(fixesFor(finding({ status: 'resolved' }), true, false)).toEqual([]);
    expect(
      fixesFor(finding({ id: 'web:uid0:toor', attackerIp: null }), true, false).map((f) => f.label),
    ).toEqual(['Lock account toor']);
    expect(
      fixesFor(
        finding({ id: 'b:public-bucket', targetId: 'b', attackerIp: null }),
        false,
        true,
      ).map((f) => f.id),
    ).toEqual(['make-private']);
  });

  it('never puts unsafe values into a command', () => {
    expect(isSafeIp('203.0.113.9')).toBe(true);
    expect(isSafeIp('2001:db8::1')).toBe(true);
    expect(isSafeIp('1.2.3.4; reboot')).toBe(false);
    expect(fixesFor(finding({ attackerIp: '1.2.3.4;reboot' }), true, false)).toEqual([]);
    expect(fixesFor(finding({ id: 'web:user:$(reboot)', attackerIp: null }), true, false)).toEqual(
      [],
    );
  });

  it('reports success, and a sudo that wants a password honestly', async () => {
    const [block] = fixesFor(finding({}), true, false);
    const ok = await applyFix(
      block!,
      { hostId: 'web' },
      {
        context,
        exec: async () => ({
          stdout: 'blocked 203.0.113.9 with Fail2ban (sshd jail)\n',
          stderr: '',
          exitCode: 0,
        }),
      },
    );
    expect(ok).toMatchObject({
      ok: true,
      message: 'blocked 203.0.113.9 with Fail2ban (sshd jail)',
    });
    const refused = await applyFix(
      block!,
      { hostId: 'web' },
      {
        context,
        exec: async () => ({ stdout: '', stderr: 'sudo: a password is required', exitCode: 1 }),
      },
    );
    expect(refused.ok).toBe(false);
    expect(refused.message).toMatch(/never types one/);
  });

  it('blocks public access on a bucket', async () => {
    const calls: string[] = [];
    const [option] = fixesFor(
      finding({ id: 'b:public-bucket', targetId: 'b', attackerIp: null }),
      false,
      true,
    );
    const outcome = await applyFix(
      option!,
      { bucket: { config: { kind: 's3', id: 'm' } as never, name: 'site' } },
      {
        context,
        exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        blockPublicAccess: async (_c, bucket) => void calls.push(bucket),
      },
    );
    expect(outcome.ok).toBe(true);
    expect(calls).toEqual(['site']);
  });
});
