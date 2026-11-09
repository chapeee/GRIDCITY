import { describe, expect, it } from 'vitest';
import { expandHome, projectSlug, resolveAppPaths } from './app-paths';
import { HOSTS_FILE_TEMPLATE, parseHostsYaml } from './hosts-file';
import { aliasToId, appendHostsToYaml, planSshConfigImport } from './import-ssh-config';
import { matchesHostPatterns, parseSshConfig, resolveSshHosts } from './ssh-config';

describe('app paths', () => {
  it('derives a directory-safe slug from the project name', () => {
    expect(projectSlug('My Grid City!')).toBe('my-grid-city');
    expect(() => projectSlug('!!!')).toThrow();
  });

  it('uses XDG locations on Linux, named after the project', () => {
    const paths = resolveAppPaths({
      projectName: 'Example',
      env: {},
      platform: 'linux',
      homeDir: '/home/me',
    });
    expect(paths.hostsFile).toBe('/home/me/.config/example/hosts.yaml');
    expect(paths.databaseFile).toBe('/home/me/.local/share/example/state.db');
    expect(paths.knownHostsFiles).toEqual([
      '/home/me/.ssh/known_hosts',
      '/etc/ssh/ssh_known_hosts',
    ]);
  });

  it('uses APPDATA / LOCALAPPDATA on Windows', () => {
    const paths = resolveAppPaths({
      projectName: 'Example',
      env: {
        APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      },
      platform: 'win32',
      homeDir: 'C:\\Users\\me',
    });
    expect(paths.hostsFile).toBe('C:\\Users\\me\\AppData\\Roaming\\example\\hosts.yaml');
    expect(paths.databaseFile).toBe('C:\\Users\\me\\AppData\\Local\\example\\state.db');
  });

  it('honors explicit overrides (Docker)', () => {
    const paths = resolveAppPaths({
      projectName: 'Example',
      env: { CONFIG_DIR: '/config', DATA_DIR: '/data', KNOWN_HOSTS_FILE: '/ssh/known_hosts' },
      platform: 'linux',
      homeDir: '/root',
    });
    expect(paths.hostsFile).toBe('/config/hosts.yaml');
    expect(paths.databaseFile).toBe('/data/state.db');
    expect(paths.knownHostsFiles).toEqual(['/ssh/known_hosts']);
  });

  it('expands ~ in paths', () => {
    expect(expandHome('~/.ssh/id', '/home/me')).toMatch(/[\\/]home[\\/]me[\\/]\.ssh[\\/]id$/);
    expect(expandHome('/abs/key', '/home/me')).toBe('/abs/key');
  });
});

describe('parseHostsYaml', () => {
  it('accepts the generated template (no hosts, default thresholds)', () => {
    const result = parseHostsYaml(HOSTS_FILE_TEMPLATE);
    expect(result.ok && result.config.hosts).toEqual([]);
    expect(result.ok && result.config.thresholds.pollIntervalMs).toBe(2000);
  });

  it('applies host defaults and partial thresholds', () => {
    const result = parseHostsYaml(
      'thresholds:\n  pollIntervalMs: 5000\nhosts:\n  - { id: a, name: a, address: 10.0.0.1, user: ops }\n',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.thresholds).toMatchObject({ pollIntervalMs: 5000, staleAfterPolls: 3 });
    expect(result.config.hosts[0]).toMatchObject({
      port: 22,
      district: 'default',
      auth: { method: 'agent' },
    });
  });

  it('reports every problem with its location', () => {
    const result = parseHostsYaml(
      'hosts:\n  - { id: a, name: a, address: x, user: u, port: 70000 }\n  - { id: a, name: b, address: y, user: u }\n',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.some((e) => e.startsWith('hosts[0].port:'))).toBe(true);
    expect(result.errors.some((e) => e.includes('duplicate id "a"'))).toBe(true);
  });

  it('reports YAML syntax errors', () => {
    const result = parseHostsYaml('hosts: [ {id: a\n');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.errors[0]).toMatch(/^YAML:/);
  });
});

const SSH_CONFIG = `
# personal
Host web-01 web-02
  HostName %h.example.com
  User deploy

Host db
  HostName 10.0.0.20
  Port 2222
  IdentityFile ~/.ssh/db_key
  User=admin

Host *.internal !secret.internal
  User internal

Match host bastion
  User nobody

Host "quoted box"
  HostName box.lan

Include ~/.ssh/config.d/*

Host *
  User fallback
  Port 22
`;

describe('ssh config', () => {
  const parsed = parseSshConfig(SSH_CONFIG);

  it('matches wildcards and honors negation', () => {
    expect(matchesHostPatterns('a.internal', ['*.internal', '!secret.internal'])).toBe(true);
    expect(matchesHostPatterns('secret.internal', ['*.internal', '!secret.internal'])).toBe(false);
    expect(matchesHostPatterns('web-1', ['web-?'])).toBe(true);
  });

  it('resolves concrete hosts with first-value-wins and Host * defaults', () => {
    expect(resolveSshHosts(parsed)).toEqual([
      {
        alias: 'web-01',
        hostName: 'web-01.example.com',
        user: 'deploy',
        port: 22,
        identityFile: null,
      },
      {
        alias: 'web-02',
        hostName: 'web-02.example.com',
        user: 'deploy',
        port: 22,
        identityFile: null,
      },
      {
        alias: 'db',
        hostName: '10.0.0.20',
        user: 'admin',
        port: 2222,
        identityFile: '~/.ssh/db_key',
      },
      { alias: 'quoted box', hostName: 'box.lan', user: 'fallback', port: 22, identityFile: null },
    ]);
  });

  it('warns about Match and Include instead of silently ignoring them', () => {
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings[0]).toMatch(/Match/);
    expect(parsed.warnings[1]).toMatch(/Include/);
  });
});

describe('ssh config import', () => {
  const resolved = resolveSshHosts(parseSshConfig(SSH_CONFIG));

  it('creates hosts with ids, key paths and the import district', () => {
    const plan = planSshConfigImport(resolved, [], 'me');
    expect(plan.hosts.map((h) => h.id)).toEqual(['web-01', 'web-02', 'db', 'quoted-box']);
    expect(plan.hosts[2]).toMatchObject({
      port: 2222,
      auth: { method: 'keyFile', path: '~/.ssh/db_key' },
    });
    expect(plan.hosts[0]).toMatchObject({ district: 'ssh config', auth: { method: 'agent' } });
  });

  it('skips hosts that already exist, so importing twice is harmless', () => {
    const plan = planSshConfigImport(
      resolved,
      [
        { id: 'web-01', address: 'x', user: 'u', port: 22 },
        { id: 'other', address: '10.0.0.20', user: 'admin', port: 2222 },
      ],
      'me',
    );
    expect(plan.hosts.map((h) => h.id)).toEqual(['web-02', 'quoted-box']);
    expect(plan.skipped.map((s) => s.alias)).toEqual(['web-01', 'db']);
  });

  it('turns aliases into valid ids', () => {
    expect(aliasToId('My Box.local')).toBe('my-box-local');
    expect(aliasToId('***')).toBe('host');
  });

  it('appends to hosts.yaml while keeping comments, and the result validates', () => {
    const plan = planSshConfigImport(resolved, [], 'me');
    const updated = appendHostsToYaml(HOSTS_FILE_TEMPLATE, plan.hosts);
    expect(updated).toContain('# Hosts shown in the city.');
    // Block style, one entry per host, so users can keep editing by hand.
    expect(updated).toContain('\nhosts:\n  - id: web-01\n    name: web-01\n');
    const result = parseHostsYaml(updated);
    expect(result.ok && result.config.hosts.map((h) => h.id)).toEqual([
      'web-01',
      'web-02',
      'db',
      'quoted-box',
    ]);
  });
});
