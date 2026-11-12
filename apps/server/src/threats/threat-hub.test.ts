import type { Host, ThreatFinding } from '@app/shared';
import { describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../storage/database';
import type { ThreatDraft } from './detect';
import type { ExposureProbes } from './exposure';
import { ThreatHub } from './threat-hub';
import { ThreatStore } from './threat-store';

const draft = (over: Partial<ThreatDraft> = {}): ThreatDraft => ({
  key: 'brute-force:203.0.113.9',
  scope: 'auth',
  source: 'builtin',
  severity: 'medium',
  category: 'brute-force',
  title: 'SSH brute force from 203.0.113.9',
  detail: 'd',
  advice: 'a',
  attackerIp: '203.0.113.9',
  count: 12,
  firstSeen: 100,
  lastSeen: 200,
  blocked: null,
  ...over,
});

describe('threat store', () => {
  it('opens, escalates, keeps quiet when nothing changed, and resolves only from checks that ran', () => {
    const store = new ThreatStore(openDatabase(':memory:'));
    expect(store.apply('web', [draft()], ['auth'], 1000).opened).toHaveLength(1);
    expect(store.apply('web', [draft()], ['auth'], 1100).changed).toBe(false);
    const grown = store.apply(
      'web',
      [draft({ count: 150, severity: 'high', lastSeen: 300 })],
      ['auth'],
      1200,
    );
    expect(grown.escalated.map((f) => f.severity)).toEqual(['high']);
    // The auth log could not be read this time: nothing is resolved.
    expect(store.apply('web', [], [], 1300).resolved).toEqual([]);
    const over = store.apply('web', [], ['auth'], 1400);
    expect(over.resolved).toHaveLength(1);
    expect(store.list(0)[0]).toMatchObject({ status: 'resolved', resolvedAt: 1400, count: 150 });
    // It starts again later: reopened with a fresh start time.
    expect(
      store.apply('web', [draft({ firstSeen: 5000, lastSeen: 5100 })], ['auth'], 5200).opened[0],
    ).toMatchObject({ firstSeen: 5000 });
  });

  it('keeps a finding the user marked as expected quiet until newer activity', () => {
    const store = new ThreatStore(openDatabase(':memory:'));
    store.apply(
      'web',
      [draft({ key: 'port:tcp:4444', scope: 'listen', lastSeen: 900 })],
      ['listen'],
      1000,
    );
    store.acknowledge('web:port:tcp:4444', 1000);
    expect(
      store.apply(
        'web',
        [draft({ key: 'port:tcp:4444', scope: 'listen', lastSeen: 1000 })],
        ['listen'],
        1100,
      ).opened,
    ).toEqual([]);
    expect(
      store.apply(
        'web',
        [draft({ key: 'port:tcp:4444', scope: 'listen', lastSeen: 2000 })],
        ['listen'],
        2100,
      ).opened,
    ).toHaveLength(1);
  });

  it('forgets targets that were removed', () => {
    const store = new ThreatStore(openDatabase(':memory:'));
    store.apply('gone', [draft()], ['auth'], 1000);
    store.saveBaseline('gone', { users: [], ports: [], logins: [], createdAt: 0 }, 1000);
    store.prune(0, new Set(['web']));
    expect(store.list(0)).toEqual([]);
    expect(store.baseline('gone')).toBeNull();
  });
});

const host: Host = {
  id: 'web',
  name: 'web-1',
  address: '10.0.0.1',
  port: 22,
  user: 'ops',
  district: 'D',
  tags: [],
  auth: { method: 'agent' },
};
const NOW = Date.parse('2026-11-12T07:30:00Z');

function sweepOutput(auth: string, users = 'root:0:/bin/bash\nops:1000:/bin/bash') {
  return [
    '@@section clock',
    `${NOW / 1000}`,
    '+0000',
    '@@section auth',
    '@@source /var/log/auth.log',
    auth,
    '@@section users',
    users,
    '@@section listen',
    'tcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',
    '@@section crowdsec-alerts',
    '@@missing',
    '@@section crowdsec-decisions',
    '@@missing',
    '@@section crowdsec-bouncers',
    '@@missing',
    '@@section fail2ban',
    '@@missing',
    '@@end-sweep',
  ].join('\n');
}

const attack = (count: number) =>
  Array.from(
    { length: count },
    (_, i) =>
      `${new Date(NOW - (10 - i * 0.05) * 60_000).toISOString()} web sshd[${i}]: Failed password for root from 203.0.113.9 port ${i} ssh2`,
  ).join('\n');

const noProbes: ExposureProbes = {
  bucket: async () => ({ blockAll: true, policyPublic: false, aclPublic: false }),
  rds: async () => ({ instances: [], groups: [] }),
  redisOpen: async () => false,
  mongoOpen: async () => false,
};

describe('threat hub', () => {
  it('sweeps a server over SSH, learns its baseline, then reports, alerts and ends an attack', async () => {
    let output = sweepOutput('');
    const changes: ThreatFinding[][] = [];
    const notify = vi.fn((): string[] => ['Slack']);
    const audit = { append: vi.fn() };
    const store = new ThreatStore(openDatabase(':memory:'));
    const hub = new ThreatHub({
      store,
      audit: audit as never,
      alerts: { notifyThreat: notify },
      hosts: () => [host],
      runnerFor: () => ({ exec: async () => ({ stdout: output }) }),
      resources: () => [],
      resourceConfigs: async () => new Map(),
      probes: noProbes,
      onChange: (open) => changes.push(open),
      retentionDays: () => 7,
      now: () => NOW,
    });

    await hub.sweepHost(host); // first sweep: baseline only
    expect(store.baseline('web')).toMatchObject({
      users: ['root:0', 'ops:1000'],
      ports: ['tcp:22'],
    });
    expect(hub.view().findings).toEqual([]);
    expect(hub.view().coverage[0]!.checks.map((c) => `${c.name}:${c.ok}`)).toEqual([
      'SSH logins:true',
      'Accounts:true',
      'Open ports:true',
      'CrowdSec:false',
      'Fail2ban:false',
    ]);

    output = sweepOutput(
      attack(120),
      'root:0:/bin/bash\nops:1000:/bin/bash\nmallory:1001:/bin/bash',
    );
    await hub.sweepHost(host);
    const open = hub.openFindings();
    expect(open.map((f) => `${f.category}:${f.severity}`).sort()).toEqual([
      'brute-force:high',
      'new-user:medium',
    ]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(changes.at(-1)).toHaveLength(2);
    expect(audit.append).toHaveBeenCalledWith(
      'threat_opened',
      'web',
      'high: SSH brute force from 203.0.113.9',
    );

    // Mark the new account as expected: it is learned and stays quiet.
    hub.acknowledge('web:user:mallory');
    output = sweepOutput('', 'root:0:/bin/bash\nops:1000:/bin/bash\nmallory:1001:/bin/bash');
    await hub.sweepHost(host);
    expect(hub.openFindings()).toEqual([]);
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'brute-force', status: 'resolved' }),
      'resolved',
      'web-1',
      true, // an alert went out when it opened, so its end is reported too
    );
  });

  it('skips servers that are not connected', async () => {
    const exec = vi.fn();
    const hub = new ThreatHub({
      store: new ThreatStore(openDatabase(':memory:')),
      hosts: () => [host],
      runnerFor: () => undefined,
      resources: () => [],
      resourceConfigs: async () => new Map(),
      probes: noProbes,
      onChange: () => undefined,
      retentionDays: () => 7,
    });
    await hub.sweepAll();
    expect(exec).not.toHaveBeenCalled();
    expect(hub.view().coverage).toEqual([]);
  });
});
