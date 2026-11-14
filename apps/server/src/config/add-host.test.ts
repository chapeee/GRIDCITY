import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { draftToHostInput } from './host-draft';
import { idFromName, parseHostTarget } from './host-target';
import { HOSTS_FILE_TEMPLATE, parseHostsYaml } from './hosts-file';
import { addHostToFile, HostValidationError } from './hosts-writer';

describe('parseHostTarget', () => {
  it.each([
    ['192.168.1.155', { user: null, address: '192.168.1.155', port: null }],
    ['root@192.168.1.155', { user: 'root', address: '192.168.1.155', port: null }],
    ['ops@box.lan:2222', { user: 'ops', address: 'box.lan', port: 2222 }],
    ['ssh://deploy@web.example.com', { user: 'deploy', address: 'web.example.com', port: null }],
    ['me@[::1]:2200', { user: 'me', address: '::1', port: 2200 }],
    ['fe80::1', { user: null, address: 'fe80::1', port: null }],
  ])('parses %s', (input, expected) => {
    expect(parseHostTarget(input)).toEqual(expected);
  });

  it.each(['', 'root@', 'host:99999', 'two words', 'host:abc'])('rejects %j', (input) => {
    expect(parseHostTarget(input)).toBeNull();
  });

  it('derives ids from names', () => {
    expect(idFromName('Web 01.lan')).toBe('web-01-lan');
    expect(idFromName('192.168.1.155')).toBe('192-168-1-155');
  });
});

describe('draftToHostInput', () => {
  it('fills everything from one typed address', () => {
    expect(draftToHostInput({ target: 'root@192.168.1.155' }, 'me')).toEqual({
      id: '192-168-1-155',
      name: '192.168.1.155',
      address: '192.168.1.155',
      port: 22,
      user: 'root',
      district: 'default',
      tags: [],
      auth: { method: 'agent' },
    });
  });

  it('uses the given name, district and the default user', () => {
    const host = draftToHostInput(
      { target: 'box.lan:2222', name: 'web-01', district: 'Home lab' },
      'me',
    );
    expect(host).toMatchObject({
      id: 'web-01',
      name: 'web-01',
      user: 'me',
      port: 2222,
      district: 'Home lab',
    });
  });

  it('explains an invalid address', () => {
    expect(() => draftToHostInput({ target: 'not an address' }, 'me')).toThrow(
      /not an SSH address/,
    );
  });
});

describe('addHostToFile', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'add-host-'));
    file = join(dir, 'config', 'hosts.yaml');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const web01 = draftToHostInput(
    { target: 'root@192.168.1.155', name: 'web-01', district: 'Home lab' },
    'me',
  );

  it('creates hosts.yaml if needed, keeps the template comments, writes a minimal entry', async () => {
    await addHostToFile(file, web01);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# Hosts shown in the city.');
    // Defaults (port 22, agent auth, no tags) stay implicit, so the file stays short.
    expect(text).toContain(
      'hosts:\n  - id: web-01\n    name: web-01\n    address: 192.168.1.155\n    user: root\n    district: Home lab\n',
    );
    const parsed = parseHostsYaml(text);
    expect(parsed.ok && parsed.config.hosts[0]).toMatchObject({
      id: 'web-01',
      port: 22,
      auth: { method: 'agent' },
    });
  });

  it('keeps every server added at the same time, and refuses a duplicate even then', async () => {
    const hosts = Array.from({ length: 8 }, (_, i) =>
      draftToHostInput({ target: `root@10.0.0.${i + 1}`, name: `node-${i + 1}` }, 'me'),
    );
    const results = await Promise.allSettled([
      ...hosts.map((host) => addHostToFile(file, host)),
      addHostToFile(file, hosts[0]!),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
    const parsed = parseHostsYaml(readFileSync(file, 'utf8'));
    expect(parsed.ok && parsed.config.hosts.map((h) => h.id).sort()).toEqual(
      hosts.map((h) => h.id).sort(),
    );
  });

  it('refuses a duplicate id or the same user@address:port', async () => {
    await addHostToFile(file, web01);
    await expect(addHostToFile(file, web01)).rejects.toThrow(HostValidationError);
    await expect(addHostToFile(file, { ...web01, id: 'other', name: 'other' })).rejects.toThrow(
      /already configured as "web-01"/,
    );
  });

  it('never touches a hosts.yaml that is currently invalid', async () => {
    const broken = join(dir, 'broken.yaml');
    writeFileSync(broken, 'hosts: [ {id: 1\n');
    await expect(addHostToFile(broken, web01)).rejects.toThrow(/has errors; fix them first/);
    expect(readFileSync(broken, 'utf8')).toBe('hosts: [ {id: 1\n');
  });

  it('adds to an existing list', async () => {
    writeFileSync(join(dir, 'h.yaml'), HOSTS_FILE_TEMPLATE);
    await addHostToFile(join(dir, 'h.yaml'), web01);
    await addHostToFile(
      join(dir, 'h.yaml'),
      draftToHostInput({ target: 'ops@10.0.0.2', name: 'db' }, 'me'),
    );
    const parsed = parseHostsYaml(readFileSync(join(dir, 'h.yaml'), 'utf8'));
    expect(parsed.ok && parsed.config.hosts.map((h) => h.id)).toEqual(['web-01', 'db']);
  });
});
