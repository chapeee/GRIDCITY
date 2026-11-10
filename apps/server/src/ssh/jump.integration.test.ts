import type { Host } from '@app/shared';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftToHostInput } from '../config/host-draft';
import { startFakeSshServer, type FakeSshServer } from '../testing/fake-ssh-server';
import { buildAuthOptions } from './auth-options';
import { probeHostKey, trustHostKey } from './host-key-setup';
import { openThroughJump } from './jump';
import { parseKnownHosts } from './known-hosts';
import { readKnownHostsFiles } from './known-hosts-files';
import { testConnection } from './test-connection';

/**
 * A private server reachable only through a bastion: same key for both, as
 * on AWS. The server's SSH session runs end to end through the tunnel.
 */

let dir: string;
let keyPath: string;
let publicKey: string;
let bastion: FakeSshServer;
let server: FakeSshServer;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jump-'));
  const pair = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
  keyPath = join(dir, 'key.pem');
  writeFileSync(keyPath, pair.private);
  publicKey = pair.public;
  bastion = await startFakeSshServer({
    user: 'ec2-user',
    authorizedKey: publicKey,
    allowTunnels: true,
  });
  server = await startFakeSshServer({ user: 'ubuntu', authorizedKey: publicKey });
});

afterEach(async () => {
  await bastion.close();
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

const privateHost = (): Host => ({
  id: 'private-db',
  name: 'private-db',
  address: '127.0.0.1',
  port: server.port,
  user: 'ubuntu',
  district: 'AWS',
  tags: [],
  auth: { method: 'keyFile', path: keyPath },
  jump: {
    address: '127.0.0.1',
    port: bastion.port,
    user: 'ec2-user',
    auth: { method: 'keyFile', path: keyPath },
  },
});

const auth = (h: Host) =>
  buildAuthOptions(h.auth, { env: {}, platform: process.platform, homeDir: dir });

describe('connecting through a jump host', () => {
  it('connects to the private server through the bastion', async () => {
    const knownHosts = parseKnownHosts(`${bastion.knownHostsLine}\n${server.knownHostsLine}`);
    const result = await testConnection(privateHost(), {
      loadKnownHosts: () => knownHosts,
      buildAuth: auth,
    });
    expect(result).toEqual({ ok: true });
    expect(bastion.tunnelsOpened).toBe(1);
  });

  it('refuses an untrusted bastion with its fingerprint, before any tunnel', async () => {
    const result = await testConnection(privateHost(), {
      loadKnownHosts: () => parseKnownHosts(server.knownHostsLine),
      buildAuth: auth,
    });
    expect(result).toMatchObject({
      ok: false,
      problem: 'host-key',
      message: expect.stringMatching(/jump host .* not trusted/),
      hostKeyRefusal: { reason: 'unknown', fingerprint: expect.stringMatching(/^SHA256:/) },
    });
    expect(bastion.tunnelsOpened).toBe(0);
  });

  it('still checks the private server key end to end (the bastion cannot fake it)', async () => {
    const result = await testConnection(privateHost(), {
      loadKnownHosts: () => parseKnownHosts(bastion.knownHostsLine),
      buildAuth: auth,
    });
    expect(result).toMatchObject({ ok: false, problem: 'host-key' });
  });
});

describe('setting up a server behind a jump host', () => {
  it('probes and trusts the private server through the tunnel', async () => {
    const knownHostsFile = join(dir, 'known_hosts');
    writeFileSync(knownHostsFile, `${bastion.knownHostsLine}\n`);
    const destination = { address: '127.0.0.1', port: server.port, user: 'ubuntu' };
    const openSocket = async () => {
      const tunnel = await openThroughJump({
        jump: { address: '127.0.0.1', port: bastion.port, user: 'ec2-user' },
        auth: { privateKey: readFileSync(keyPath) },
        knownHosts: readKnownHostsFiles([knownHostsFile]),
        destination,
      });
      return tunnel.sock;
    };

    const probed = await probeHostKey(destination, openSocket);
    expect(server.knownHostsLine).toContain(probed.keyBase64);
    expect(
      await trustHostKey({
        endpoint: destination,
        confirmedFingerprint: probed.fingerprint,
        knownHosts: readKnownHostsFiles([knownHostsFile]),
        knownHostsFile,
        openSocket,
      }),
    ).toBe('added');
  });

  it('turns a draft with a jump host into config (same key for both)', () => {
    const host = draftToHostInput(
      {
        target: 'ubuntu@10.0.1.5',
        jump: { target: 'ec2-user@bastion.example.com' },
        auth: { method: 'keyFile', path: '~/.ssh/aws.pem' },
      },
      'me',
    );
    expect(host.jump).toEqual({
      address: 'bastion.example.com',
      port: 22,
      user: 'ec2-user',
      auth: { method: 'keyFile', path: '~/.ssh/aws.pem' },
    });
  });
});
