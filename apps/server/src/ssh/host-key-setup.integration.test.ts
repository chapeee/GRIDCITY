import type { Host } from '@app/shared';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeSshServer, type FakeSshServer } from '../testing/fake-ssh-server';
import { buildAuthOptions } from './auth-options';
import { generateKey, KeyExistsError } from './generate-key';
import {
  HostKeyMismatchError,
  installPublicKey,
  PasswordRejectedError,
  probeHostKey,
  trustHostKey,
} from './host-key-setup';
import { parseKnownHosts, verifyHostKey } from './known-hosts';
import { readKnownHostsFiles } from './known-hosts-files';
import { listLocalKeys } from './local-keys';
import { testConnection } from './test-connection';

/**
 * The "Connect a server" flow end to end, against an in-process SSH server
 * that accepts a password and a real authorized_keys.
 */

const USER = 'root';
const PASSWORD = 'correct horse';

let sshDir: string;
let knownHostsFile: string;
let server: FakeSshServer;

beforeEach(async () => {
  sshDir = mkdtempSync(join(tmpdir(), 'connect-flow-'));
  knownHostsFile = join(sshDir, 'known_hosts');
  server = await startFakeSshServer({ user: USER, password: PASSWORD });
});

afterEach(async () => {
  await server.close();
  rmSync(sshDir, { recursive: true, force: true });
});

const endpoint = () => ({ address: '127.0.0.1', port: server.port, user: USER });
const knownHosts = () => readKnownHostsFiles([knownHostsFile]);

describe('probeHostKey', () => {
  it("returns the server's fingerprint without logging in or running anything", async () => {
    const probed = await probeHostKey(endpoint());
    expect(probed.fingerprint).toMatch(/^SHA256:/);
    expect(server.knownHostsLine).toContain(probed.keyBase64);
    expect(server.execCount).toBe(0);
  });

  it('explains an unreachable host', async () => {
    const port = server.port;
    await server.close();
    await expect(probeHostKey({ ...endpoint(), port })).rejects.toThrow(/ECONNREFUSED/);
    server = await startFakeSshServer({ user: USER, password: PASSWORD }); // for afterEach
  });
});

describe('trustHostKey', () => {
  it('adds the confirmed key to known_hosts, once', async () => {
    const { fingerprint } = await probeHostKey(endpoint());
    const confirm = () =>
      trustHostKey({
        endpoint: endpoint(),
        confirmedFingerprint: fingerprint,
        knownHosts: knownHosts(),
        knownHostsFile,
      });

    expect(await confirm()).toBe('added');
    expect(await confirm()).toBe('already-trusted');
    const lines = readFileSync(knownHostsFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(new RegExp(`^\\[127\\.0\\.0\\.1\\]:${server.port} ssh-ed25519 `));
  });

  it('refuses when the key differs from the one the user confirmed, writing nothing', async () => {
    await expect(
      trustHostKey({
        endpoint: endpoint(),
        confirmedFingerprint: 'SHA256:somethingElse',
        knownHosts: [],
        knownHostsFile,
      }),
    ).rejects.toThrow(HostKeyMismatchError);
    expect(() => readFileSync(knownHostsFile)).toThrow();
  });

  it('never replaces a different key that is already known (MITM case)', async () => {
    const { fingerprint } = await probeHostKey(endpoint());
    const impostor = ssh2.utils
      .generateKeyPairSync('ecdsa', { bits: 256 })
      .public.split(' ')
      .slice(0, 2)
      .join(' ');
    writeFileSync(knownHostsFile, `[127.0.0.1]:${server.port} ${impostor}\n`);
    await expect(
      trustHostKey({
        endpoint: endpoint(),
        confirmedFingerprint: fingerprint,
        knownHosts: knownHosts(),
        knownHostsFile,
      }),
    ).rejects.toThrow(/never replaces a known key/);
    expect(readFileSync(knownHostsFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

describe('installPublicKey and key login', () => {
  async function trust() {
    const { fingerprint } = await probeHostKey(endpoint());
    await trustHostKey({
      endpoint: endpoint(),
      confirmedFingerprint: fingerprint,
      knownHosts: knownHosts(),
      knownHostsFile,
    });
  }

  it('installs a new key with the password once; afterwards the key alone logs in', async () => {
    await trust();
    const { privatePath } = await generateKey({
      sshDir,
      baseName: 'test_ed25519',
      comment: 'test',
    });
    const [key] = await listLocalKeys({ sshDir });
    expect(key).toMatchObject({ source: 'file', privatePath, usable: true });

    await installPublicKey({
      endpoint: endpoint(),
      publicKey: key!.publicKey,
      password: PASSWORD,
      knownHosts: knownHosts(),
    });
    expect(server.installedKeys).toBe(1);

    const host: Host = {
      id: 'web-01',
      name: 'web-01',
      address: '127.0.0.1',
      port: server.port,
      user: USER,
      district: 'lab',
      tags: [],
      auth: { method: 'keyFile', path: privatePath },
    };
    const result = await testConnection(host, {
      loadKnownHosts: knownHosts,
      buildAuth: (h) =>
        buildAuthOptions(h.auth, { env: {}, platform: process.platform, homeDir: sshDir }),
    });
    expect(result).toEqual({ ok: true });
  });

  it('reports a wrong password without echoing it', async () => {
    await trust();
    const error = (await installPublicKey({
      endpoint: endpoint(),
      publicKey: ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).public,
      password: 'wrong-password-123',
      knownHosts: knownHosts(),
    }).catch((e: unknown) => e as Error)) as Error;
    expect(error).toBeInstanceOf(PasswordRejectedError);
    expect(error.message).not.toContain('wrong-password-123');
    expect(server.installedKeys).toBe(0);
  });

  it('never sends the password to a host whose key is not trusted', async () => {
    const error = (await installPublicKey({
      endpoint: endpoint(),
      publicKey: ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).public,
      password: PASSWORD,
      knownHosts: [],
    }).catch((e: unknown) => e as Error)) as Error;
    expect(error).toBeInstanceOf(HostKeyMismatchError);
    expect(error.message).toMatch(/password was not sent/);
    expect(server.installedKeys).toBe(0);
  });
});

describe('generateKey and listLocalKeys', () => {
  it('creates a usable key and never overwrites an existing one', async () => {
    await generateKey({ sshDir, baseName: 'k_ed25519', comment: 'c' });
    await expect(generateKey({ sshDir, baseName: 'k_ed25519', comment: 'c' })).rejects.toThrow(
      KeyExistsError,
    );
  });

  it('marks passphrase-protected keys as needing ssh-agent', async () => {
    const pair = ssh2.utils.generateKeyPairSync('ecdsa', {
      bits: 256,
      passphrase: 'secret',
      cipher: 'aes256-ctr',
      rounds: 16,
    });
    writeFileSync(join(sshDir, 'locked'), pair.private);
    writeFileSync(join(sshDir, 'locked.pub'), pair.public);
    const [key] = await listLocalKeys({ sshDir });
    expect(key).toMatchObject({ usable: false, note: expect.stringMatching(/ssh-agent/) });
  });

  it('ignores public keys without a private half', async () => {
    writeFileSync(
      join(sshDir, 'orphan.pub'),
      ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).public,
    );
    expect(await listLocalKeys({ sshDir })).toEqual([]);
  });

  it('verifies trusted keys with the same rules as the fleet', async () => {
    const { fingerprint, keyType, keyBase64 } = await probeHostKey(endpoint());
    await trustHostKey({
      endpoint: endpoint(),
      confirmedFingerprint: fingerprint,
      knownHosts: [],
      knownHostsFile,
    });
    expect(
      verifyHostKey(
        parseKnownHosts(readFileSync(knownHostsFile, 'utf8')),
        `[127.0.0.1]:${server.port}`,
        {
          keyType,
          keyBase64,
        },
      ).verdict,
    ).toBe('trusted');
  });
});
