import type { Host } from '@app/shared';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeSshServer, type FakeSshServer } from '../testing/fake-ssh-server';
import { buildAuthOptions, resolveKeyPath } from './auth-options';
import { parseKnownHosts } from './known-hosts';
import { suggestedUserFrom, testConnection } from './test-connection';

/**
 * Cloud servers: the key from the provider, the user name the image wants,
 * and key paths that survive the SSH folder moving (Docker volume).
 */

let sshDir: string;
let server: FakeSshServer;
let keyPath: string;

beforeEach(async () => {
  sshDir = mkdtempSync(join(tmpdir(), 'cloud-login-'));
  const pair = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 });
  keyPath = join(sshDir, 'aws-prod.pem');
  writeFileSync(keyPath, pair.private);
  server = await startFakeSshServer({
    user: 'ubuntu',
    authorizedKey: pair.public,
    cloudUser: 'ubuntu',
  });
});

afterEach(async () => {
  await server.close();
  rmSync(sshDir, { recursive: true, force: true });
});

const hostAs = (user: string, path = keyPath): Host => ({
  id: 'aws',
  name: 'aws',
  address: '127.0.0.1',
  port: server.port,
  user,
  district: 'AWS',
  tags: [],
  auth: { method: 'keyFile', path },
});

const test = (host: Host) =>
  testConnection(host, {
    loadKnownHosts: () => parseKnownHosts(server.knownHostsLine),
    buildAuth: (h) =>
      buildAuthOptions(h.auth, { env: {}, platform: process.platform, homeDir: sshDir, sshDir }),
  });

describe('cloud images that want a specific user', () => {
  it('reads the user name from the message cloud images print', () => {
    expect(
      suggestedUserFrom('Please login as the user "ec2-user" rather than the user "root".'),
    ).toBe('ec2-user');
    expect(suggestedUserFrom('Please login as the user "ubuntu" rather than "root"')).toBe(
      'ubuntu',
    );
    expect(suggestedUserFrom('Welcome to Ubuntu')).toBeUndefined();
  });

  it('does not report success for root when the image only prints "login as ubuntu"', async () => {
    const result = await test(hostAs('root'));
    expect(result).toMatchObject({ ok: false, problem: 'wrong-user', suggestedUser: 'ubuntu' });
  });

  it('succeeds with the user the image asked for', async () => {
    expect(await test(hostAs('ubuntu'))).toEqual({ ok: true });
  });
});

describe('key paths in hosts.yaml', () => {
  it('"~/.ssh/name" means the managed SSH folder, wherever it lives', async () => {
    expect(resolveKeyPath('~/.ssh/aws-prod.pem', { homeDir: '/home/x', sshDir })).toBe(keyPath);
    expect(await test(hostAs('ubuntu', '~/.ssh/aws-prod.pem'))).toEqual({ ok: true });
  });

  it('finds a key whose old absolute path is gone (the folder moved)', async () => {
    const stale = '/home/node/.ssh/aws-prod.pem';
    expect(resolveKeyPath(stale, { homeDir: '/home/x', sshDir })).toBe(keyPath);
    expect(await test(hostAs('ubuntu', stale))).toEqual({ ok: true });
  });

  it('leaves existing absolute paths alone', () => {
    expect(resolveKeyPath(keyPath, { homeDir: '/home/x', sshDir: '/elsewhere' })).toBe(keyPath);
  });
});
