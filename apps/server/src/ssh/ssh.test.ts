import type { Host } from '@app/shared';
import { createHmac, randomBytes } from 'node:crypto';
import { utils } from 'ssh2';
import { describe, expect, it } from 'vitest';
import { AuthSetupError, buildAuthOptions, WINDOWS_OPENSSH_AGENT_PIPE } from './auth-options';
import { backoffDelayMs } from './backoff';
import { describeConnectionError } from './host-connection';
import {
  fingerprintSha256,
  knownHostsName,
  parseKnownHosts,
  preferredHostKeyAlgorithms,
  presentedKeyFromBlob,
  verifyHostKey,
} from './known-hosts';

/** A real ed25519 public key blob, generated per test run. */
function generatePublicKey() {
  const keys = utils.generateKeyPairSync('ed25519');
  const [keyType = '', keyBase64 = ''] = keys.public.split(' ');
  return { keyType, keyBase64, blob: Buffer.from(keyBase64, 'base64') };
}

function hashedHostField(name: string): string {
  const salt = randomBytes(20);
  const hash = createHmac('sha1', salt).update(name).digest();
  return `|1|${salt.toString('base64')}|${hash.toString('base64')}`;
}

describe('known_hosts verification', () => {
  const key = generatePublicKey();
  const otherKey = generatePublicKey();

  it('trusts a matching plain entry and its lookup name', () => {
    const entries = parseKnownHosts(`web.example.com,203.0.113.10 ${key.keyType} ${key.keyBase64}`);
    expect(verifyHostKey(entries, '203.0.113.10', key).verdict).toBe('trusted');
  });

  it('uses [host]:port for non-standard ports', () => {
    expect(knownHostsName('10.0.0.5', 22)).toBe('10.0.0.5');
    expect(knownHostsName('10.0.0.5', 2222)).toBe('[10.0.0.5]:2222');
    const entries = parseKnownHosts(`[10.0.0.5]:2222 ${key.keyType} ${key.keyBase64}`);
    expect(verifyHostKey(entries, '[10.0.0.5]:2222', key).verdict).toBe('trusted');
    expect(verifyHostKey(entries, '10.0.0.5', key).verdict).toBe('unknown');
  });

  it('matches hashed entries', () => {
    const entries = parseKnownHosts(
      `${hashedHostField('db.internal')} ${key.keyType} ${key.keyBase64}`,
    );
    expect(verifyHostKey(entries, 'db.internal', key).verdict).toBe('trusted');
    expect(verifyHostKey(entries, 'other.internal', key).verdict).toBe('unknown');
  });

  it('reports a changed key when the host is known with a different key', () => {
    const entries = parseKnownHosts(`db.internal ${otherKey.keyType} ${otherKey.keyBase64}`);
    expect(verifyHostKey(entries, 'db.internal', key).verdict).toBe('changed');
  });

  it('reports unknown hosts', () => {
    expect(verifyHostKey([], 'new.host', key).verdict).toBe('unknown');
  });

  it('refuses revoked keys even when also listed as trusted', () => {
    const entries = parseKnownHosts(
      `@revoked * ${key.keyType} ${key.keyBase64}\ndb.internal ${key.keyType} ${key.keyBase64}`,
    );
    expect(verifyHostKey(entries, 'db.internal', key).verdict).toBe('revoked');
  });

  it('honors wildcard and negated patterns, ignores comments and cert-authority lines', () => {
    const entries = parseKnownHosts(
      `# comment\n@cert-authority *.corp ${otherKey.keyType} ${otherKey.keyBase64}\n*.lab,!secret.lab ${key.keyType} ${key.keyBase64}`,
    );
    expect(verifyHostKey(entries, 'a.lab', key).verdict).toBe('trusted');
    expect(verifyHostKey(entries, 'secret.lab', key).verdict).toBe('unknown');
    expect(verifyHostKey(entries, 'x.corp', otherKey).verdict).toBe('unknown');
  });

  it('prefers the host key algorithms already trusted for the host', () => {
    const entries = parseKnownHosts(
      `old.box ssh-rsa AAAAB3NzaC1yc2E=\nnew.box ${key.keyType} ${key.keyBase64}`,
    );
    expect(preferredHostKeyAlgorithms(entries, 'old.box')).toEqual([
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
    ]);
    expect(preferredHostKeyAlgorithms(entries, 'new.box')).toEqual(['ssh-ed25519']);
    expect(preferredHostKeyAlgorithms(entries, 'unknown.box')).toBeNull();
  });

  it('reads the key type from a key blob and fingerprints it like OpenSSH', () => {
    expect(presentedKeyFromBlob(key.blob)).toEqual({
      keyType: 'ssh-ed25519',
      keyBase64: key.keyBase64,
    });
    expect(fingerprintSha256(key.blob)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});

describe('buildAuthOptions', () => {
  const base = { env: {}, platform: 'linux' as const, homeDir: '/home/me' };

  it('uses SSH_AUTH_SOCK for agent auth', async () => {
    const options = await buildAuthOptions(
      { method: 'agent' },
      { ...base, env: { SSH_AUTH_SOCK: '/tmp/agent.sock' } },
    );
    expect(options).toEqual({ agent: '/tmp/agent.sock' });
  });

  it("falls back to Windows OpenSSH's agent pipe", async () => {
    const options = await buildAuthOptions({ method: 'agent' }, { ...base, platform: 'win32' });
    expect(options).toEqual({ agent: WINDOWS_OPENSSH_AGENT_PIPE });
  });

  it('explains a missing agent', async () => {
    await expect(buildAuthOptions({ method: 'agent' }, base)).rejects.toThrow(/SSH_AUTH_SOCK/);
  });

  it('reads an unencrypted key file', async () => {
    const pair = utils.generateKeyPairSync('ed25519');
    const options = await buildAuthOptions(
      { method: 'keyFile', path: '~/.ssh/id' },
      { ...base, readKeyFile: async () => Buffer.from(pair.private) },
    );
    expect(options.privateKey?.toString()).toBe(pair.private);
  });

  it('refuses passphrase-protected keys with advice, never asking for the passphrase', async () => {
    const pair = utils.generateKeyPairSync('ed25519', {
      passphrase: 'secret',
      cipher: 'aes256-ctr',
      rounds: 16,
    });
    const error = await buildAuthOptions(
      { method: 'keyFile', path: '/k' },
      { ...base, readKeyFile: async () => Buffer.from(pair.private) },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthSetupError);
    expect((error as Error).message).toMatch(/passphrase-protected.*ssh-agent/);
  });

  it('reports unreadable key files without leaking content', async () => {
    const missing = Object.assign(new Error('nope'), { code: 'ENOENT' });
    await expect(
      buildAuthOptions(
        { method: 'keyFile', path: '/missing' },
        { ...base, readKeyFile: () => Promise.reject(missing) },
      ),
    ).rejects.toThrow('Cannot read key file /missing (ENOENT).');
  });
});

describe('backoffDelayMs', () => {
  const noJitter = () => 0.5;
  it('doubles per attempt and caps at the maximum', () => {
    expect(backoffDelayMs(0, undefined, noJitter)).toBe(1000);
    expect(backoffDelayMs(3, undefined, noJitter)).toBe(8000);
    expect(backoffDelayMs(20, undefined, noJitter)).toBe(60_000);
  });

  it('applies bounded jitter', () => {
    expect(backoffDelayMs(2, undefined, () => 0)).toBe(3200);
    expect(backoffDelayMs(2, undefined, () => 1)).toBe(4800);
  });
});

describe('describeConnectionError', () => {
  const host = { address: '10.0.0.9', port: 22, user: 'ops' } as Host;
  it('makes common failures readable', () => {
    expect(
      describeConnectionError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), host),
    ).toMatch(/ECONNREFUSED 10\.0\.0\.9:22/);
    expect(describeConnectionError(new Error('Keepalive timeout'), host)).toBe(
      'heartbeat lost (keepalive timeout)',
    );
    expect(
      describeConnectionError(
        Object.assign(new Error('All configured authentication methods failed'), {
          level: 'client-authentication',
        }),
        host,
      ),
    ).toBe('authentication failed for ops@10.0.0.9:22 (key not accepted)');
  });
});
