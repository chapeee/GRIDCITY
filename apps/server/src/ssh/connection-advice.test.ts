import type { Host } from '@app/shared';
import { describe, expect, it } from 'vitest';
import { connectionAdvice } from './connection-advice';

const host: Host = {
  id: 'web-01',
  name: 'web-01',
  address: '192.168.1.155',
  port: 22,
  user: 'root',
  district: 'Home lab',
  tags: [],
  auth: { method: 'agent' },
};

describe('connectionAdvice', () => {
  it('has nothing to say when the connection works', () => {
    expect(connectionAdvice({ ok: true }, host, 'linux')).toEqual([]);
  });

  it('asks to verify an unknown key before connecting once with ssh', () => {
    const steps = connectionAdvice(
      {
        ok: false,
        problem: 'host-key',
        message: 'x',
        hostKeyRefusal: { reason: 'unknown', fingerprint: 'SHA256:abc' },
      },
      host,
      'linux',
    );
    expect(steps.join('\n')).toContain('SHA256:abc');
    expect(steps.join('\n')).toContain('ssh root@192.168.1.155');
    expect(steps.join('\n')).not.toMatch(/ssh-keyscan/); // never trust blindly
  });

  it('warns about a changed key and only then suggests removing the old one', () => {
    const steps = connectionAdvice(
      {
        ok: false,
        problem: 'host-key',
        message: 'x',
        hostKeyRefusal: { reason: 'changed', fingerprint: 'SHA256:new' },
      },
      { ...host, port: 2222 },
      'linux',
    );
    expect(steps[0]).toMatch(/CHANGED/);
    expect(steps.join('\n')).toContain('ssh-keygen -R [192.168.1.155]:2222');
  });

  it('gives platform-specific agent and key-install commands', () => {
    const failure = {
      ok: false as const,
      problem: 'auth' as const,
      message: 'x',
      hostKeyRefusal: null,
    };
    const windows = connectionAdvice(failure, host, 'win32').join('\n');
    const linux = connectionAdvice(failure, host, 'linux').join('\n');
    expect(windows).toContain('Start-Service ssh-agent');
    expect(windows).toContain('$env:USERPROFILE\\.ssh\\id_ed25519.pub');
    expect(linux).toContain('ssh-copy-id root@192.168.1.155');
    expect(linux).toContain('eval "$(ssh-agent)"');
  });
});
