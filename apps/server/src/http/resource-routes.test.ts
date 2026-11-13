import { openSqlite } from '../storage/sqlite';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseResourcesYaml } from '../config/resources-file';
import { AuditLog } from '../storage/audit-log';
import { openDatabase } from '../storage/database';
import { SecretVault } from '../storage/secret-vault';
import { registerResourceRoutes } from './resource-routes';

function setup(options: { demoMode?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'resource-routes-'));
  const resourcesFile = join(dir, 'resources.yaml');
  writeFileSync(resourcesFile, '# my databases\nresources: []\n');
  const sqliteFile = join(dir, 'app.db');
  const db = openSqlite(sqliteFile);
  db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
  db.close();
  const app = Fastify();
  const audit = new AuditLog(openDatabase(':memory:'));
  const secrets = new SecretVault(openDatabase(':memory:'), Buffer.alloc(32, 1));
  const reload = vi.fn(async () => undefined);
  registerResourceRoutes(app, {
    audit,
    demoMode: options.demoMode ?? false,
    resourcesFile,
    secrets,
    context: { env: {}, homeDir: dir, appName: 'test', now: Date.now, secrets },
    hostIds: () => new Set(['web-01']),
    reload,
  });
  return { app, audit, reload, resourcesFile, sqliteFile, dir, secrets };
}

describe('connect a database or bucket', () => {
  it('tests a draft with one real poll and shows what it read', async () => {
    const { app, sqliteFile } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/resources/test',
      payload: { resource: { kind: 'sqlite', id: 'app-db', path: sqliteFile } },
    });
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.found[0]).toMatchObject({ name: 'app-db', engine: 'SQLite', ok: true });
    expect(body.found[0].metrics.map((m: { key: string }) => m.key)).toContain('tables');
  });

  it('uses a typed password for the test only and never echoes it', async () => {
    const { app, resourcesFile } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/resources/test',
      payload: {
        resource: {
          kind: 'postgres',
          id: 'pg',
          host: '127.0.0.1',
          port: 1,
          user: 'u',
          passwordEnv: 'NOT_SET',
        },
        password: 'typed-secret-123',
      },
    });
    const body = response.json();
    expect(body.ok).toBe(false);
    // The typed password replaced the reference (so NOT_SET was not the problem)...
    expect(JSON.stringify(body)).not.toMatch(/NOT_SET is not set/);
    // ...and is nowhere in the answer or on disk.
    expect(JSON.stringify(body)).not.toContain('typed-secret-123');
    expect(readFileSync(resourcesFile, 'utf8')).not.toContain('typed-secret-123');
  });

  it('adds only what the user set, keeps comments, audits and reloads', async () => {
    const { app, audit, reload, resourcesFile } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/resources',
      payload: {
        kind: 'postgres',
        id: 'orders-db',
        host: 'db.internal',
        user: 'monitor',
        passwordEnv: 'ORDERS_PW',
        district: 'Databases',
      },
    });
    expect(response.statusCode).toBe(200);
    const text = readFileSync(resourcesFile, 'utf8');
    expect(text).toContain('# my databases');
    expect(text).toContain('passwordEnv: ORDERS_PW');
    expect(text).not.toContain('slowQueryMs'); // defaults stay implicit
    const parsed = parseResourcesYaml(text);
    expect(parsed.ok && parsed.config.resources[0]).toMatchObject({ id: 'orders-db', port: 5432 });
    expect(audit.recent()[0]).toMatchObject({
      kind: 'resource_added',
      hostId: 'orders-db',
      detail: 'postgres db.internal:5432',
    });
    expect(reload).toHaveBeenCalled();
  });

  it('saves a pasted password encrypted and writes only its id to the file', async () => {
    const { app, audit, resourcesFile, secrets } = setup();
    const added = await app.inject({
      method: 'POST',
      url: '/api/resources',
      payload: {
        resource: { kind: 'postgres', id: 'orders-db', host: 'db.internal', user: 'monitor' },
        secrets: { password: 'pasted-secret-456' },
      },
    });
    expect(added.statusCode).toBe(200);
    const text = readFileSync(resourcesFile, 'utf8');
    expect(text).toContain('passwordSecret: orders-db.password');
    expect(text).not.toContain('pasted-secret-456');
    expect(secrets.get('orders-db.password')).toBe('pasted-secret-456');
    expect(JSON.stringify(audit.recent())).not.toContain('pasted-secret-456');
    expect(audit.recent()[0]?.detail).toContain('credentials saved encrypted');

    // Edit replaces it; the file keeps pointing at the same id.
    const edited = await app.inject({
      method: 'PATCH',
      url: '/api/resources/orders-db',
      payload: { secrets: { password: 'rotated-789' } },
    });
    expect(edited.statusCode).toBe(200);
    expect(secrets.get('orders-db.password')).toBe('rotated-789');
    const flags = await app.inject({ method: 'GET', url: '/api/resources/orders-db/credentials' });
    expect(flags.json()).toEqual({ password: true, accessKey: false });

    // Removing the entry removes its credentials.
    await app.inject({ method: 'DELETE', url: '/api/resources/orders-db' });
    expect(secrets.has('orders-db.password')).toBe(false);
  });

  it('saves pasted S3 keys in place of env names and profiles', async () => {
    const { app, resourcesFile, secrets } = setup();
    const added = await app.inject({
      method: 'POST',
      url: '/api/resources',
      payload: {
        resource: {
          kind: 's3',
          id: 'media',
          provider: 'spaces',
          endpoint: 'https://blr1.digitaloceanspaces.com',
          accessKeyIdEnv: 'OLD_KEY',
          secretAccessKeyEnv: 'OLD_SECRET',
        },
        secrets: { accessKeyId: 'DO00KEY', secretAccessKey: 'very-secret-key' },
      },
    });
    expect(added.statusCode).toBe(200);
    const text = readFileSync(resourcesFile, 'utf8');
    expect(text).toContain('accessKeyIdSecret: media.accessKeyId');
    expect(text).toContain('secretAccessKeySecret: media.secretAccessKey');
    expect(text).not.toContain('OLD_KEY');
    expect(text).not.toContain('very-secret-key');
    expect(secrets.get('media.secretAccessKey')).toBe('very-secret-key');
  });

  it('refuses secrets, duplicate ids and ids used by servers', async () => {
    const { app } = setup();
    const secret = await app.inject({
      method: 'POST',
      url: '/api/resources',
      payload: { kind: 'redis', id: 'cache', host: 'x', password: 'nope' },
    });
    expect(secret.statusCode).toBe(422);
    expect(secret.json().problems[0]).toMatch(/never stored/);
    const urlSecret = await app.inject({
      method: 'POST',
      url: '/api/resources',
      payload: { kind: 'mongodb', id: 'm', url: 'mongodb://u:pw@h:27017' },
    });
    expect(urlSecret.statusCode).toBe(422);
    const server = await app.inject({
      method: 'POST',
      url: '/api/resources',
      payload: { kind: 'redis', id: 'web-01', host: 'x' },
    });
    expect(server.json().problems[0]).toMatch(/used by a server/);
    await app.inject({
      method: 'POST',
      url: '/api/resources',
      payload: { kind: 'redis', id: 'cache', host: 'x' },
    });
    const dupe = await app.inject({
      method: 'POST',
      url: '/api/resources',
      payload: { kind: 'redis', id: 'cache', host: 'y' },
    });
    expect(dupe.json().problems[0]).toMatch(/already used/);
  });

  it('edits the label and district, and removes entries', async () => {
    const { app, resourcesFile } = setup();
    await app.inject({
      method: 'POST',
      url: '/api/resources',
      payload: { kind: 'redis', id: 'cache', host: 'x' },
    });
    const edited = await app.inject({
      method: 'PATCH',
      url: '/api/resources/cache',
      payload: { name: 'Session cache', district: 'Home lab' },
    });
    expect(edited.statusCode).toBe(200);
    const parsed = parseResourcesYaml(readFileSync(resourcesFile, 'utf8'));
    expect(parsed.ok && parsed.config.resources[0]).toMatchObject({
      name: 'Session cache',
      district: 'Home lab',
    });
    const noHost = await app.inject({
      method: 'PATCH',
      url: '/api/resources/cache',
      payload: { host: 'evil' },
    });
    expect(noHost.statusCode).toBe(422);
    expect((await app.inject({ method: 'DELETE', url: '/api/resources/cache' })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: 'DELETE', url: '/api/resources/cache' })).statusCode).toBe(
      422,
    );
  });

  it('refuses every write with demo data', async () => {
    const { app } = setup({ demoMode: true });
    expect(
      (await app.inject({ method: 'POST', url: '/api/resources', payload: {} })).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: '/api/resources/test', payload: {} })).statusCode,
    ).toBe(409);
  });
});
