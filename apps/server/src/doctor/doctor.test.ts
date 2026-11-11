import { describe, expect, it } from 'vitest';
import { ResourceConfigSchema, type ResourceConfig } from '../config/resources-file';
import { applyPatch, diagnoseResource, type ConnectionTest } from './doctor';
import { matchRules, type RuleContext } from './rules';

const ladder = {
  resolve: async () => [{ address: '203.0.113.7', family: 4 }],
  tcp: async () => 12,
};

const mysql = (extra: Record<string, unknown> = {}) =>
  ResourceConfigSchema.parse({
    kind: 'mysql',
    id: 'farm-ddb',
    name: 'farm ddb',
    host: 'farm-db-do-user-1.db.ondigitalocean.com',
    port: 25060,
    user: 'doadmin',
    ...extra,
  });

/** A managed MySQL: TLS required, certificate signed by a private CA. */
const managedMysql: ConnectionTest = async (config) => {
  const c = config as ResourceConfig & { tls?: boolean; tlsVerify?: boolean; tlsCa?: string };
  if (!c.tls) {
    return {
      ok: false,
      error:
        'Connections using insecure transport are prohibited while --require_secure_transport=ON.',
    };
  }
  if (c.tlsVerify !== false && !c.tlsCa)
    return { ok: false, error: 'self-signed certificate in certificate chain' };
  return { ok: true, error: null };
};

describe('Doctor', () => {
  it('finds "TLS required", proves the chain of fixes, and keeps the safe manual option', async () => {
    let attempts = 0;
    const report = await diagnoseResource(mysql(), {
      test: async (config) => {
        attempts += 1;
        return managedMysql(config);
      },
      ladder,
      inContainer: false,
    });
    expect(report.ok).toBe(false);
    expect(report.ladder.map((step) => [step.step, step.status])).toEqual([
      ['dns', 'ok'],
      ['tcp', 'ok'],
      ['tls', 'skipped'],
    ]);
    const top = report.diagnoses[0]!;
    expect(top.id).toBe('db.tls-required');
    expect(top.confidence).toBe('certain');
    expect(top.evidence.join(' ')).toMatch(/DigitalOcean/);
    const byLabel = Object.fromEntries(top.fixes.map((fix) => [fix.label, fix]));
    expect(byLabel['Turn on TLS']).toMatchObject({
      verified: 'fails',
      verifyNote: 'self-signed certificate in certificate chain',
    });
    expect(byLabel['Turn on TLS, and skip certificate verification']).toMatchObject({
      verified: 'works',
      risk: 'lower-security',
      patch: { tls: true, tlsVerify: false },
    });
    expect(top.fixes.some((fix) => fix.kind === 'manual' && /CA certificate/.test(fix.label))).toBe(
      true,
    );
    expect(attempts).toBeLessThanOrEqual(4); // first failure + at most a few proofs
  });

  it('says a plain TLS switch works when the certificate is publicly trusted', async () => {
    const report = await diagnoseResource(mysql({ host: 'db.example.com', port: 3306 }), {
      error:
        'Connections using insecure transport are prohibited while --require_secure_transport=ON.',
      test: async (config) =>
        (config as { tls?: boolean }).tls ? { ok: true, error: null } : { ok: false, error: 'x' },
      ladder,
      inContainer: false,
    });
    expect(report.diagnoses[0]!.fixes[0]).toMatchObject({
      label: 'Turn on TLS',
      verified: 'works',
      risk: 'safe',
    });
  });

  it('reports ok without diagnosing when the target answers', async () => {
    const report = await diagnoseResource(mysql({ tls: true, tlsVerify: false }), {
      test: managedMysql,
      ladder,
    });
    expect(report).toMatchObject({ ok: true, diagnoses: [] });
  });

  it('only patches allow-listed settings', () => {
    const patched = applyPatch(mysql(), { tls: true, user: 'root', id: 'x' }) as Record<
      string,
      unknown
    >;
    expect(patched).toMatchObject({ tls: true, user: 'doadmin', id: 'farm-ddb' });
  });

  it('stops at the failing rung with a firewall diagnosis', async () => {
    const report = await diagnoseResource(mysql({ host: 'db.example.com' }), {
      error: 'connect ETIMEDOUT 203.0.113.7:3306',
      test: async () => ({ ok: false, error: 'connect ETIMEDOUT' }),
      ladder: {
        ...ladder,
        tcp: async () =>
          Promise.reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
      },
      inContainer: false,
    });
    expect(report.ladder.find((s) => s.step === 'tcp')?.status).toBe('failed');
    expect(report.diagnoses[0]!.id).toBe('net.timeout');
  });
});

describe('rules on real error texts', () => {
  const base = (
    kind: string,
    error: string,
    config: Record<string, unknown> = {},
  ): RuleContext => ({
    kind,
    error,
    config: { host: 'db.example.com', port: 5432, ...config },
    ladder: [],
    provider: null,
    inContainer: false,
    addresses: [],
  });
  const ids = (context: RuleContext) => matchRules(context).map((d) => d.id);

  it.each([
    [
      'mysql',
      'Connections using insecure transport are prohibited while --require_secure_transport=ON.',
      'db.tls-required',
    ],
    [
      'mysql',
      "Authentication plugin 'caching_sha2_password' reported error: Authentication requires secure connection.",
      'db.tls-required',
    ],
    [
      'postgres',
      'no pg_hba.conf entry for host "203.0.113.5", user "monitor", database "postgres", no encryption',
      'db.tls-required',
    ],
    ['postgres', 'connection is insecure (try using `sslmode=require`)', 'db.tls-required'],
    ['postgres', 'The server does not support SSL connections', 'db.tls-unsupported'],
    [
      'redis',
      'write EPROTO ...:error:0A00010B:SSL routines:ssl3_get_record:wrong version number',
      'db.tls-unsupported',
    ],
    ['postgres', 'self-signed certificate in certificate chain', 'tls.untrusted-ca'],
    ['mssql', 'Failed to connect to sql:1433 - self-signed certificate', 'tls.untrusted-ca'],
    [
      'http',
      "Hostname/IP does not match certificate's altnames: IP: 1.2.3.4 is not in the cert's list",
      'tls.hostname-mismatch',
    ],
    ['http', 'certificate has expired', 'tls.expired'],
    ['postgres', 'getaddrinfo ENOTFOUND db.internal', 'net.dns'],
    ['mongodb', 'querySrv ENOTFOUND _mongodb._tcp.cluster0.abcde.mongodb.net', 'net.dns'],
    ['mysql', 'connect ECONNREFUSED 10.0.0.5:3306', 'net.refused'],
    [
      'mysql',
      "Access denied for user 'monitor'@'203.0.113.5' (using password: YES)",
      'auth.rejected',
    ],
    ['postgres', 'password authentication failed for user "monitor"', 'auth.rejected'],
    ['mongodb', 'bad auth : Authentication failed.', 'auth.rejected'],
    ['redis', 'WRONGPASS invalid username-password pair or user is disabled.', 'auth.rejected'],
    [
      'mysql',
      "Host '203.0.113.5' is not allowed to connect to this MySQL server",
      'mysql.host-not-allowed',
    ],
    ['mysql', "Unknown database 'shop'", 'db.unknown-database'],
    ['postgres', 'database "orders" does not exist', 'db.unknown-database'],
    ['postgres', 'role "monitor" does not exist', 'pg.role-missing'],
    ['postgres', 'sorry, too many clients already', 'db.too-many-connections'],
    ['redis', 'NOAUTH Authentication required.', 'redis.noauth'],
    [
      'redis',
      'ERR AUTH <password> called without any password configured for the default user',
      'redis.no-password-needed',
    ],
    ['redis', 'read ECONNRESET', 'stream.reset-tls-mismatch'],
    [
      'mssql',
      "Server requires encryption, set 'encrypt' config option to true.",
      'mssql.encryption-required',
    ],
    ['s3', 'Could not load credentials from any providers', 'aws.no-credentials'],
    [
      's3',
      'InvalidAccessKeyId: The AWS Access Key Id you provided does not exist in our records.',
      'aws.bad-key',
    ],
    [
      's3',
      'SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided.',
      'aws.bad-key',
    ],
    [
      's3',
      "AuthorizationHeaderMalformed: the region 'us-east-1' is wrong; expecting 'eu-west-1'",
      'aws.region-mismatch',
    ],
    [
      'rds',
      'User: arn:aws:iam::1:user/m is not authorized to perform: rds:DescribeDBInstances',
      'aws.access-denied',
    ],
    [
      's3',
      'RequestTimeTooSkewed: The difference between the request time and the current time is too large.',
      'aws.clock-skew',
    ],
    ['http', 'HTTP 503 Service Unavailable', 'http.status'],
  ])('%s: %s', (kind, error, expected) => {
    expect(ids(base(kind, error))).toContain(expected);
  });

  it('turns a refused port into "use port 25060" for DigitalOcean', () => {
    const [diagnosis] = matchRules({
      ...base('mysql', 'connect ECONNREFUSED 1.2.3.4:3306', {
        port: 3306,
        host: 'x.db.ondigitalocean.com',
      }),
      provider: {
        id: 'digitalocean',
        name: 'DigitalOcean Managed Database',
        tlsRequired: true,
        port: 25060,
        note: '',
      },
    }).filter((d) => d.id === 'net.refused');
    expect(diagnosis?.fixes[0]).toMatchObject({ label: 'Use port 25060', patch: { port: 25060 } });
  });

  it('tells Docker users about host.docker.internal', () => {
    const diagnoses = matchRules({
      ...base('postgres', 'connect ECONNREFUSED 127.0.0.1:5432', { host: 'localhost' }),
      inContainer: true,
    });
    expect(diagnoses.map((d) => d.id)).toContain('net.localhost-in-container');
  });

  it('suggests authSource=admin for Mongo auth failures', () => {
    const [diagnosis] = matchRules(
      base('mongodb', 'Authentication failed.', { url: 'mongodb://m@h' }),
    );
    expect(diagnosis?.fixes[0]?.patch).toEqual({ authSource: 'admin' });
  });
});
