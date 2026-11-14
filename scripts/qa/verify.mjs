// Re-checks every fix from the release test passes against the running app
// (node scripts/qa/pass.mjs serve) and the real containers. Each check redoes
// what once went wrong and says PASS or FAIL. Safe to run again.
//
//   node scripts/qa/verify.mjs            everything (about 3 minutes: it runs a real attack)
//   node scripts/qa/verify.mjs --quick    without the attack
//
// UI checks (side panels, approval cards) are listed in docs/qa/release-test-pass.md.
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const qa = join(root, '.qa');
const BASE = 'http://127.0.0.1:4700';
const QUICK = process.argv.includes('--quick');
const token = readFileSync(join(qa, 'data/session-token'), 'utf8').trim();
const resourcesFile = join(qa, 'config/resources.yaml');

let passed = 0;
const failed = [];
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const section = (title) => console.log(`\n── ${title}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(method, path, body, headers = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: BASE,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status, json, text };
}

let mcpReady = false;
async function mcp(tool, args = {}) {
  const post = (body) =>
    fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Agent-Client': 'QA verify',
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    }).then((r) => r.text());
  if (!mcpReady) {
    await post({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'qa', version: '1' },
      },
    });
    mcpReady = true;
  }
  const text = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  });
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  const content = JSON.parse(line.slice(6)).result.content[0].text;
  try {
    return JSON.parse(content);
  } catch {
    return content;
  }
}

const sh = (command, args, env) =>
  spawnSync(command, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
const docker = (...args) => sh('docker', args).stdout.trim();
const redisCli = (...args) =>
  docker(
    'exec',
    'connectors-test-redis-1',
    'redis-cli',
    '-a',
    'test-root',
    '--no-auth-warning',
    ...args,
  );

async function until(what, test, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) return null;
    await sleep(2000);
  }
}

const findings = async () => (await api('GET', '/api/threats')).json;
const finding = async (pattern) => (await findings()).findings.find((f) => pattern.test(f.id));
const resources = async () => (await mcp('list_resources')).resources;
const enc = encodeURIComponent;

/** Superuser accounts (throwaway test passwords of these containers) to attack read mode. */
async function ensureSuperusers() {
  const existing = new Set((await resources()).map((r) => r.id));
  const add = (resource) =>
    existing.has(resource.id)
      ? null
      : api('POST', '/api/resources', { resource, secrets: { password: 'test-root' } });
  await Promise.all([
    add({
      kind: 'postgres',
      id: 'pg-super',
      host: '127.0.0.1',
      port: 15432,
      user: 'postgres',
      district: 'Databases',
    }),
    add({
      kind: 'mysql',
      id: 'my-super',
      host: '127.0.0.1',
      port: 13306,
      user: 'root',
      district: 'Databases',
    }),
    add({
      kind: 'redis',
      id: 'redis-super',
      host: '127.0.0.1',
      port: 16379,
      district: 'Databases',
    }),
  ]);
}

/** One request with a forged Host header (fetch drops a hand-set Host; node:http sends it). */
const forgedHost = (path, host) =>
  new Promise((done) => {
    const request = httpRequest(
      `${BASE}${path}`,
      { headers: { Authorization: `Bearer ${token}`, Host: host } },
      (response) => {
        response.resume();
        done(response.statusCode);
      },
    );
    request.on('error', () => done(null));
    request.end();
  });

// ───────────────────────────────────────────────────────────────────────────
section('Fleet and probes (LocalStack, Moto, databases)');
{
  const list = await until('first polls', async () => {
    const all = await resources();
    return all.some((r) => r.id === 'short-cert' && r.status !== 'unknown') &&
      all.some((r) => r.kind === 'rds' && r.status !== 'unknown')
      ? all
      : null;
  });
  const by = (id) => list?.find((r) => r.id === id);
  check(
    'a certificate expiring within 14 days turns the probe amber',
    by('short-cert')?.status === 'degraded' &&
      /certificate expires/.test(by('short-cert')?.statusReason),
    `${by('short-cert')?.status}: ${by('short-cert')?.statusReason}`,
  );
  const rds = list?.filter((r) => r.kind === 'rds') ?? [];
  check(
    'RDS (Moto) works with accessKeyIdEnv / secretAccessKeyEnv',
    rds.length >= 2 && rds.every((r) => r.status === 'online'),
    rds.map((r) => `${r.id}:${r.status}`).join(' '),
  );
  const alb = list?.find((r) => r.kind === 'loadbalancer');
  check(
    'load balancer (Moto) works with env keys',
    alb?.status === 'online',
    `${alb?.id}:${alb?.status}`,
  );
  check(
    'the AI reads RDS storage as GiB, not raw bytes',
    rds.every((r) => /^\d+(\.\d)? GiB$/.test(r.metrics['Allocated storage'])),
    rds.map((r) => r.metrics['Allocated storage']).join(', '),
  );
  check('the TLS-only MySQL is offline, as it should be', by('mysql-tls')?.status === 'offline');
}

section('A broken entry in resources.yaml');
{
  const before = (await resources()).length;
  const original = readFileSync(resourcesFile, 'utf8');
  appendFileSync(
    resourcesFile,
    '  - { kind: redis, id: broken-one, host: 127.0.0.1, colour: blue }\n',
  );
  try {
    await sleep(6000); // the file is reloaded live
    const after = (await resources()).length;
    check('every other resource keeps running', after === before, `${before} → ${after}`);
    const mode = await api('PUT', '/api/explore/localstack/mode', { mode: 'write' });
    check(
      '"Allow changes" on a healthy resource still saves',
      mode.status === 200,
      `HTTP ${mode.status}`,
    );
    await api('PUT', '/api/explore/localstack/mode', { mode: 'read' });
    const doctor = sh('node', ['apps/server/dist/doctor.js', '--json'], {
      DATA_DIR: join(qa, 'data'),
      CONFIG_DIR: join(qa, 'config'),
      SSH_DIR: join(qa, 'ssh'),
      QA_PW: 'test-monitor',
      QA_AWS: 'test',
      QA_MINIO_K: 'test-minio',
      QA_MINIO_S: 'test-minio-secret',
    });
    const report = JSON.parse(doctor.stdout || '{}');
    check(
      'gridcity doctor names the skipped entry',
      (report.environment ?? []).some(
        (e) => e.id === 'env.config' && /broken-one/.test(e.evidence.join(' ')),
      ),
    );
    check(
      'no Node warning about TLS server names for IP addresses',
      !/ServerName to an IP address/.test(doctor.stderr),
      doctor.stderr.trim().slice(0, 80),
    );
  } finally {
    writeFileSync(resourcesFile, original);
  }
}

section('Public bucket on LocalStack');
{
  // Recreate the exposure (this also undoes a previous "Block public access").
  sh('node', ['scripts/security-lab.mjs', 'exposure']);
  await api('POST', '/api/threats/check', {});
  const open = await until('public bucket finding', async () => {
    const f = await finding(/public-website:public-bucket/);
    return f?.status === 'open' ? f : null;
  });
  check('re-running the lab brings the public bucket back', Boolean(open));
  if (open) {
    const fix = await api('POST', `/api/threats/${enc(open.id)}/fix`, { fixId: 'make-private' });
    const after = fix.json?.view?.findings.find((f) => f.id === open.id);
    check(
      '"Block public access" resolves the finding',
      fix.json?.outcome?.ok && after?.status === 'resolved',
      `outcome ${fix.json?.outcome?.ok}, status ${after?.status}`,
    );
  }
}

section('Backups');
{
  const saved = await api('POST', '/api/backups', {
    name: 'verify: too small',
    targetId: 'localstack-app-backups',
    kind: 's3',
    path: 'db/',
    maxAgeHours: 24,
    minBytes: 10_000_000,
  });
  const item = saved.json?.view?.upcoming.find((u) => u.label === 'verify: too small');
  check(
    'a too-small backup is urgent ("this week"), with the reason',
    item?.status === 'urgent' && /^too small/.test(item.detail),
    `${item?.status}: ${item?.detail?.slice(0, 50)}`,
  );
  if (saved.json?.backup) await api('DELETE', `/api/backups/${saved.json.backup.id}`);
}

section('Read-only Manage, as superuser');
// Added at the same time on purpose: concurrent adds once lost entries and corrupted the file.
await ensureSuperusers();
await sleep(3000);
{
  const ids = new Set((await resources()).map((r) => r.sourceId ?? r.id));
  const all = ['pg-super', 'my-super', 'redis-super'];
  const yamlText = readFileSync(resourcesFile, 'utf8');
  check(
    'three databases added at the same time all land in resources.yaml',
    all.every((id) => yamlText.includes(`id: ${id}`)),
    all.filter((id) => !yamlText.includes(`id: ${id}`)).join(', ') || 'all there',
  );
  check(
    '… and all three are in the city',
    all.every((id) => [...ids].some((x) => x.startsWith(id))),
  );

  const sql = (id, db, text) => api('POST', `/api/explore/${id}/sql/query`, { db, sql: text });
  // Only the read-mode refusal counts; any other error (connection, missing resource) is a FAIL.
  const refused = async (id, db, text) => {
    const error = (await sql(id, db, text)).json?.error ?? '';
    return /switch Changes on|acts on the server|not allowed in read mode/.test(error)
      ? error
      : null;
  };
  for (const text of [
    "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'monitor'",
    'SELECT "pg_reload_conf"()',
    'SELECT pg_cancel_backend/**/(1)',
    "COPY (SELECT 1) TO PROGRAM 'touch /tmp/verify-pwned'",
    "SET TRANSACTION READ WRITE; INSERT INTO demo_items(name) VALUES ('verify')",
  ]) {
    check(
      `PostgreSQL refuses: ${text.slice(0, 55)}`,
      Boolean(await refused('pg-super', 'postgres', text)),
    );
  }
  const read = await sql('pg-super', 'postgres', 'SELECT count(*) FROM pg_stat_activity');
  check('PostgreSQL still reads', Array.isArray(read.json?.results));
  check(
    'MySQL refuses SELECT … INTO OUTFILE',
    Boolean(await refused('my-super', 'shop', "SELECT 1 INTO OUTFILE '/tmp/verify.csv'")),
  );

  redisCli('set', 'verify-canary', 'alive');
  const redis = (args) =>
    api('POST', '/api/explore/redis-super/redis/command', { args, confirm: true });
  const evalWrite = await redis([
    'EVAL',
    "return redis.call('set', KEYS[1], 'written')",
    '1',
    'verify-canary',
  ]);
  check(
    'Redis refuses EVAL (scripts can write)',
    evalWrite.status === 403 && /switch Changes on/.test(evalWrite.json?.error ?? ''),
    evalWrite.json?.error,
  );
  check('… and the key is untouched', redisCli('get', 'verify-canary') === 'alive');
  const evalRo = await redis([
    'EVAL_RO',
    "return redis.call('get', KEYS[1])",
    '1',
    'verify-canary',
  ]);
  check('Redis still runs EVAL_RO', evalRo.json?.reply === 'alive');
  const publish = await redis(['PUBLISH', 'jobs', 'run']);
  check(
    'Redis refuses PUBLISH',
    /switch Changes on/.test(publish.json?.error ?? ''),
    publish.json?.error,
  );
  const multi = await redis(['MULTI']);
  check('Redis refuses MULTI', /not available/.test(multi.json?.error ?? ''), multi.json?.error);
  check(
    'Redis console still reads after that',
    (await redis(['GET', 'verify-canary'])).json?.reply === 'alive',
  );
}

section('Local API front door');
{
  const raw = (path, init) => fetch(`${BASE}${path}`, init).then((r) => r.status);
  check('no token: 401', (await raw('/api/meta')) === 401);
  check('DNS rebinding (Host: evil.com): 421', (await forgedHost('/api/meta', 'evil.com')) === 421);
  check(
    'DNS rebinding (Host: localhost.evil.com): 421',
    (await forgedHost('/api/meta', 'localhost.evil.com:4700')) === 421,
  );
  check(
    'write from another website: 403',
    (await api('POST', '/api/threats/check', {}, { Origin: 'https://evil.com' })).status === 403,
  );
  const replies = await Promise.all(
    [
      '/api/resources/pg-super/credentials',
      '/api/alerts',
      '/api/settings',
      '/api/audit',
      '/api/threats',
    ].map(async (path) => (await api('GET', path)).text),
  );
  check(
    'no saved password in any reply',
    !replies.some((text) => /test-root|test-monitor|test-minio-secret/.test(text)),
  );
}

if (!QUICK) {
  section('Guessed login, then the attacker is blocked (real attack)');
  docker('exec', 'gridcity-security-lab-target-1', 'fail2ban-client', 'unban', '--all');
  sh('node', ['scripts/security-lab.mjs', 'attack', 'guess']);
  await api('POST', '/api/threats/check', {});
  const login = await until(
    'guessed login finding',
    async () => {
      const f = await finding(/login-after-attack/);
      return f && f.status === 'open' ? f : null;
    },
    120_000,
  );
  check('the guessed login is found', Boolean(login), login?.title);
  if (login) {
    const fix = await api('POST', `/api/threats/${enc(login.id)}/fix`, { fixId: 'block-ip' });
    const after = fix.json?.view?.findings.find((f) => f.id === login.id);
    check(
      'after blocking: blocked, and still critical',
      after?.blocked === true && after?.severity === 'critical',
      `blocked ${after?.blocked}, ${after?.severity}`,
    );
    check(
      'it says the password still works elsewhere',
      /password still works/.test(after?.detail ?? ''),
    );
    const left = await api('GET', `/api/threats/${enc(login.id)}/fixes`);
    check(
      'the block button is gone',
      (left.json?.fixes ?? []).every((f) => f.id !== 'block-ip'),
    );
  }
}

console.log(`\n${passed} passed, ${failed.length} failed`);
if (failed.length > 0) {
  console.log(`Failed:\n  ${failed.join('\n  ')}`);
  process.exit(1);
}
