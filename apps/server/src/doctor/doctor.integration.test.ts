import { describe, expect, it } from 'vitest';
import { ResourceConfigSchema } from '../config/resources-file';
import { testResource } from '../http/resource-routes';
import { diagnoseResource, type ConnectionTest } from './doctor';

/**
 * The Doctor against a real MySQL 8.4 with require_secure_transport=ON and
 * its auto-generated CA (compose.connectors-test.yaml, service mysql-tls):
 * the exact situation of a managed MySQL. Run with `npm run test:connectors`.
 */
const enabled = process.env.CONNECTOR_TESTS === '1';
const context = {
  env: { MYSQL_MONITOR: 'test-monitor' },
  homeDir: '/',
  appName: 'doctor-test',
  now: Date.now,
};

const realTest: ConnectionTest = async (config) => {
  const result = await testResource(config, {}, context);
  const failed = result.found.find((entry) => !entry.ok);
  return { ok: result.ok, error: result.error ?? failed?.error ?? null };
};

describe.skipIf(!enabled)('Doctor (real MySQL requiring TLS)', () => {
  const config = ResourceConfigSchema.parse({
    kind: 'mysql',
    id: 'farm-ddb',
    host: '127.0.0.1',
    port: 13307,
    user: 'monitor',
    passwordEnv: 'MYSQL_MONITOR',
  });

  it('reproduces the refusal, explains it, and proves the fix that works', async () => {
    const report = await diagnoseResource(config, { test: realTest, inContainer: false });
    expect(report.ok).toBe(false);
    expect(report.error).toMatch(/insecure transport are prohibited/);
    expect(report.ladder.find((s) => s.step === 'tcp')?.status).toBe('ok');
    const top = report.diagnoses[0]!;
    expect(top.id).toBe('db.tls-required');
    const turnOn = top.fixes.find((f) => f.label === 'Turn on TLS')!;
    // MySQL's auto-generated CA is private, so verification fails: the Doctor says so...
    expect(turnOn.verified).toBe('fails');
    expect(turnOn.verifyNote).toMatch(/self[- ]signed|certificate/i);
    // ...and proves the combination that connects, flagged as lower security.
    const works = top.fixes.find((f) => f.verified === 'works')!;
    expect(works.patch).toEqual({ tls: true, tlsVerify: false });
    expect(works.risk).toBe('lower-security');
  }, 60_000);

  it('connects for real once the proven patch is applied', async () => {
    const result = await realTest({ ...config, tls: true, tlsVerify: false } as typeof config);
    expect(result).toEqual({ ok: true, error: null });
  }, 30_000);
});
