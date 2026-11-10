import { DEFAULT_APP_SETTINGS, DEFAULT_STATUS_THRESHOLDS, type AppSettings } from '@app/shared';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { HostValidationError } from '../config/hosts-writer';
import { AuditLog } from '../storage/audit-log';
import { openDatabase } from '../storage/database';
import { registerManageRoutes, type ManageDependencies } from './manage-routes';

function setup(overrides: Partial<ManageDependencies> = {}) {
  const app = Fastify();
  const audit = new AuditLog(openDatabase(':memory:'));
  let settings: AppSettings = DEFAULT_APP_SETTINGS;
  const deps: ManageDependencies = {
    audit,
    demoMode: false,
    now: () => 10 * 86_400_000,
    hostsFile: '/cfg/hosts.yaml',
    knownTargets: () => new Set(['web', 'orders-db']),
    samples: () => [
      {
        at: 10 * 86_400_000 - 60_000,
        cpuPercent: 50,
        memoryPercent: 40,
        networkBytesPerSec: 1,
        loadOne: 1,
        maxDiskPercent: 30,
      },
    ],
    incidents: () => [
      {
        targetId: 'web',
        status: 'degraded',
        reason: 'CPU 97% for 3 polls',
        startedAt: 1,
        endedAt: 2,
      },
      { targetId: 'gone', status: 'offline', reason: null, startedAt: 1, endedAt: null },
    ],
    loadSettings: () => settings,
    saveSettings: (next) => (settings = next),
    currentThresholds: () => DEFAULT_STATUS_THRESHOLDS,
    setThresholds: vi.fn(async (t) => ({ ...DEFAULT_STATUS_THRESHOLDS, ...t })),
    editHost: vi.fn(async () => undefined),
    removeHost: vi.fn(async () => undefined),
    ...overrides,
  };
  registerManageRoutes(app, deps);
  return { app, deps, audit };
}

describe('history, settings and edit routes', () => {
  it('returns points and incidents, hiding targets no longer configured', async () => {
    const { app } = setup();
    const response = await app.inject({ url: '/api/history?target=web&days=7' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ targetId: 'web', retentionDays: 7 });
    expect(body.points.at(-1)).toMatchObject({ cpuPercent: 50 });
    expect(body.incidents.map((i: { targetId: string }) => i.targetId)).toEqual(['web']);
    expect((await app.inject({ url: '/api/history?target=nope' })).statusCode).toBe(404);
  });

  it('never returns more days than are kept', async () => {
    const { app } = setup({ loadSettings: () => ({ historyRetentionDays: 3 }) });
    const body = (await app.inject({ url: '/api/history?days=30' })).json();
    expect(body.until - body.since).toBe(3 * 86_400_000);
  });

  it('saves retention and thresholds, validates input and audits', async () => {
    const { app, deps, audit } = setup();
    const saved = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { app: { historyRetentionDays: 14 }, thresholds: { cpuDegradedPercent: 80 } },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().app.historyRetentionDays).toBe(14);
    expect(deps.setThresholds).toHaveBeenCalledWith({ cpuDegradedPercent: 80 });
    expect(audit.recent().map((e) => e.kind)).toEqual(['settings_changed', 'settings_changed']);
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { app: { historyRetentionDays: 500 } },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('edits and removes hosts, reporting file problems as 422', async () => {
    const { app, deps, audit } = setup({
      removeHost: async () => {
        throw new HostValidationError(['no host "x" in hosts.yaml']);
      },
    });
    const edited = await app.inject({
      method: 'PATCH',
      url: '/api/hosts/web',
      payload: { name: 'Web', district: 'Home lab', thresholds: { memoryDegradedPercent: 85 } },
    });
    expect(edited.statusCode).toBe(200);
    expect(deps.editHost).toHaveBeenCalledWith('web', {
      name: 'Web',
      district: 'Home lab',
      thresholds: { memoryDegradedPercent: 85 },
    });
    expect(audit.recent()[0]).toMatchObject({ kind: 'host_edited', hostId: 'web' });
    const unknownField = await app.inject({
      method: 'PATCH',
      url: '/api/hosts/web',
      payload: { address: '1.2.3.4' },
    });
    expect(unknownField.statusCode).toBe(422);
    const removed = await app.inject({ method: 'DELETE', url: '/api/hosts/x' });
    expect(removed.statusCode).toBe(422);
    expect(removed.json().problems).toEqual(['no host "x" in hosts.yaml']);
  });

  it('refuses writes with demo data', async () => {
    const { app } = setup({ demoMode: true });
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/hosts/web', payload: { name: 'x' } }))
        .statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'PUT', url: '/api/settings', payload: {} })).statusCode,
    ).toBe(409);
    expect((await app.inject({ url: '/api/settings' })).json().editable).toBe(false);
  });
});
