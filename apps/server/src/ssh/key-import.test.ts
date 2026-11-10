import type { Host } from '@app/shared';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeSshServer } from '../testing/fake-ssh-server';
import { makePpk, type PpkKeyType } from '../testing/ppk-fixture';
import { buildAuthOptions } from './auth-options';
import { probeHostKey, trustHostKey } from './host-key-setup';
import {
  classifyKeyText,
  importPrivateKey,
  KeyImportError,
  keyFileName,
  KeyNameTakenError,
  ppkToOpenSsh,
  prepareKey,
} from './key-import';
import { readKnownHostsFiles } from './known-hosts-files';
import { listLocalKeys } from './local-keys';
import { testConnection } from './test-connection';

let sshDir: string;
beforeEach(() => {
  sshDir = mkdtempSync(join(tmpdir(), 'key-import-'));
});
afterEach(() => rmSync(sshDir, { recursive: true, force: true }));

/** "type base64" without the comment. */
const typeAndBlob = (line: string) => line.split(' ').slice(0, 2).join(' ');

/** An AWS-style key: unencrypted PKCS#1 RSA PEM. */
const awsPem = () =>
  generateKeyPairSync('rsa', { modulusLength: 2048 })
    .privateKey.export({ type: 'pkcs1', format: 'pem' })
    .toString();

describe('classifyKeyText', () => {
  it('recognizes private, PuTTY and public keys', () => {
    expect(classifyKeyText(awsPem())).toBe('private');
    expect(classifyKeyText(ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).private)).toBe(
      'private',
    );
    expect(classifyKeyText(makePpk('ed25519').ppk)).toBe('ppk');
    expect(classifyKeyText(ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).public)).toBe(
      'public',
    );
    expect(classifyKeyText('---- BEGIN SSH2 PUBLIC KEY ----\nAAAA')).toBe('public');
    expect(classifyKeyText('hello world')).toBe('unknown');
  });
});

describe('PuTTY .ppk conversion', () => {
  const cases: [PpkKeyType, 2 | 3][] = [
    ['rsa', 2],
    ['rsa', 3],
    ['ed25519', 2],
    ['ed25519', 3],
    ['ecdsa', 3],
  ];

  it.each(cases)('converts a %s key (PPK v%i) to the same OpenSSH key', (type, version) => {
    const fixture = makePpk(type, { version, comment: 'from-puttygen' });
    const prepared = prepareKey(fixture.ppk, 'fallback');
    expect(prepared.privateText).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    expect(typeAndBlob(prepared.publicLine)).toBe(fixture.publicLine);
    expect(prepared.publicLine.endsWith(' from-puttygen')).toBe(true);
  });

  it('produces files the real ssh-keygen accepts', () => {
    let hasKeygen = true;
    try {
      execFileSync('ssh-keygen', ['-?'], { stdio: 'ignore' });
    } catch (error) {
      hasKeygen = (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    if (!hasKeygen) return; // nothing to compare against on this machine

    for (const type of ['rsa', 'ed25519', 'ecdsa'] as const) {
      const fixture = makePpk(type);
      const path = join(sshDir, `converted_${type}`);
      writeFileSync(path, ppkToOpenSsh(fixture.ppk), { mode: 0o600 });
      const derived = execFileSync('ssh-keygen', ['-y', '-f', path], { encoding: 'utf8' });
      expect(typeAndBlob(derived.trim())).toBe(fixture.publicLine);
    }
  });

  it('refuses passphrase-protected PuTTY keys', () => {
    const encrypted = makePpk('ed25519').ppk.replace('Encryption: none', 'Encryption: aes256-cbc');
    expect(() => prepareKey(encrypted, 'x')).toThrow(/passphrase/);
  });

  it('refuses a key whose halves do not match', () => {
    const one = makePpk('ed25519', { version: 3 }).ppk;
    const other = makePpk('ed25519', { version: 3 }).ppk;
    const privateOf = (ppk: string) => ppk.slice(ppk.indexOf('Private-Lines'));
    const spliced = one.replace(privateOf(one), privateOf(other));
    expect(() => prepareKey(spliced, 'x')).toThrow(/damaged/);
  });
});

describe('prepareKey', () => {
  it('accepts an AWS .pem as it is', () => {
    const pem = awsPem();
    const prepared = prepareKey(pem, 'aws-prod.pem');
    expect(prepared.privateText).toBe(`${pem.trim()}\n`);
    expect(prepared.publicLine).toMatch(/^ssh-rsa AAAA\S+ aws-prod\.pem$/);
  });

  it('explains a public key upload', () => {
    const pub = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256 }).public;
    expect(() => prepareKey(pub, 'x')).toThrow(/This is a public key/);
  });

  it('refuses passphrase-protected OpenSSH keys without asking for the passphrase', () => {
    const locked = ssh2.utils.generateKeyPairSync('ecdsa', {
      bits: 256,
      passphrase: 'secret',
      cipher: 'aes256-ctr',
      rounds: 16,
    }).private;
    expect(() => prepareKey(locked, 'x')).toThrow(/passphrase/);
  });

  it('refuses things that are not keys', () => {
    expect(() => prepareKey('not a key', 'x')).toThrow(KeyImportError);
    expect(() => prepareKey('x'.repeat(70_000), 'x')).toThrow(/too large/);
  });
});

describe('keyFileName', () => {
  it('keeps names safe and drops the .ppk extension', () => {
    expect(keyFileName('aws-prod.pem', 'private')).toBe('aws-prod.pem');
    expect(keyFileName('C:\\Users\\me\\Downloads\\My Key.ppk', 'ppk')).toBe('My_Key');
    expect(keyFileName('../../etc/passwd', 'private')).toBe('passwd');
    expect(keyFileName('.hidden', 'private')).toBe('hidden');
    expect(keyFileName('known_hosts', 'private')).toBe('imported_known_hosts');
    expect(keyFileName('id.pub', 'private')).toBe('imported_id');
  });
});

describe('importPrivateKey', () => {
  it('saves the key and its .pub, and lists it as usable', async () => {
    const result = await importPrivateKey({
      sshDir,
      fileName: 'aws-prod.pem',
      content: awsPem(),
    });
    expect(result.created).toBe(true);
    expect(readFileSync(`${result.privatePath}.pub`, 'utf8')).toMatch(/^ssh-rsa AAAA/);
    if (process.platform !== 'win32') expect(statSync(result.privatePath).mode & 0o777).toBe(0o600);

    const [key] = await listLocalKeys({ sshDir });
    expect(key).toMatchObject({
      privatePath: result.privatePath,
      fingerprint: result.fingerprint,
      usable: true,
    });
  });

  it('is harmless to repeat, and never overwrites a different key', async () => {
    const pem = awsPem();
    await importPrivateKey({ sshDir, fileName: 'k.pem', content: pem });
    const again = await importPrivateKey({ sshDir, fileName: 'k.pem', content: pem });
    expect(again.created).toBe(false);
    await expect(
      importPrivateKey({ sshDir, fileName: 'k.pem', content: awsPem() }),
    ).rejects.toThrow(KeyNameTakenError);
  });

  it('saves a converted PuTTY key without the .ppk extension', async () => {
    const fixture = makePpk('ed25519');
    const result = await importPrivateKey({ sshDir, fileName: 'laptop.ppk', content: fixture.ppk });
    expect(result.privatePath).toBe(join(sshDir, 'laptop'));
    expect(existsSync(join(sshDir, 'laptop.ppk'))).toBe(false);
    expect(typeAndBlob(readFileSync(join(sshDir, 'laptop.pub'), 'utf8'))).toBe(fixture.publicLine);
  });
});

describe('listLocalKeys with keys that have no .pub', () => {
  it('derives the public half of a lone .pem and ignores non-key files', async () => {
    writeFileSync(join(sshDir, 'aws.pem'), awsPem());
    writeFileSync(join(sshDir, 'config'), 'Host *\n  User ops\n');
    writeFileSync(join(sshDir, 'known_hosts'), '');
    const keys = await listLocalKeys({ sshDir });
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ id: 'file:aws.pem', keyType: 'ssh-rsa', usable: true });
    expect(keys[0]!.fingerprint).toMatch(/^SHA256:/);
  });

  it('points a lone PuTTY key to the upload button', async () => {
    writeFileSync(join(sshDir, 'old.ppk'), makePpk('ed25519').ppk);
    const [key] = await listLocalKeys({ sshDir });
    expect(key).toMatchObject({ usable: false, note: expect.stringMatching(/Upload a key file/) });
  });
});

describe('an imported key logs in', () => {
  it('connects to a server that has the PuTTY key authorized (no password)', async () => {
    const fixture = makePpk('ed25519');
    const server = await startFakeSshServer({ user: 'ubuntu', authorizedKey: fixture.publicLine });
    try {
      const knownHostsFile = join(sshDir, 'known_hosts');
      const endpoint = { address: '127.0.0.1', port: server.port, user: 'ubuntu' };
      const { fingerprint } = await probeHostKey(endpoint);
      await trustHostKey({
        endpoint,
        confirmedFingerprint: fingerprint,
        knownHosts: [],
        knownHostsFile,
      });
      const { privatePath } = await importPrivateKey({
        sshDir,
        fileName: 'aws.ppk',
        content: fixture.ppk,
      });

      const host: Host = {
        id: 'aws',
        name: 'aws',
        address: '127.0.0.1',
        port: server.port,
        user: 'ubuntu',
        district: 'AWS',
        tags: [],
        auth: { method: 'keyFile', path: privatePath },
      };
      const result = await testConnection(host, {
        loadKnownHosts: () => readKnownHostsFiles([knownHostsFile]),
        buildAuth: (h) =>
          buildAuthOptions(h.auth, { env: {}, platform: process.platform, homeDir: sshDir }),
      });
      expect(result).toEqual({ ok: true });
    } finally {
      await server.close();
    }
  });
});
