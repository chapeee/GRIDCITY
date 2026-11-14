// Docker upgrade test: a container of the OLD image, full of real data in its
// /data volume, is replaced by a container of the NEW image on the same volume,
// as `docker pull` + recreate does. Every row, file and secret must survive.
//
//   node scripts/qa/docker-upgrade-test.mjs --old <image> --new <image>
//
// Uses its own volume and container names: never touches another GRIDCITY container.
// Needs the QA containers (node scripts/qa/pass.mjs up): MySQL and ntfy on this machine.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..', '..');
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const OLD = arg('--old');
const NEW = arg('--new');
if (!process.argv.includes('--old') || !process.argv.includes('--new'))
  throw new Error('--old <image> --new <image>');
const Database = createRequire(join(root, 'package.json'))('better-sqlite3');

const PORT = 4795;
const BASE = `http://127.0.0.1:${PORT}`;
const VOLUME = `gridcity-upgrade-test-${Date.now()}`;
const NAME = 'gridcity-upgrade-test';
const PASSWORD = 'QA-Unique-Pw-8841';
const work = mkdtempSync(join(tmpdir(), 'gridcity-docker-upgrade-'));
const configDir = join(work, 'config');
mkdirSync(configDir, { recursive: true });

let passed = 0;
const failed = [];
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// MSYS_NO_PATHCONV: Git Bash on Windows would rewrite /data into a Windows path.
const docker = (...args) =>
  spawnSync('docker', args, { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
const md5 = (file) =>
  existsSync(file) ? createHash('md5').update(readFileSync(file)).digest('hex') : null;
let token = '';

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      // What a browser sends with the documented mapping (-p 127.0.0.1:4600:4600): the
      // allowed Origin is the container's own port. 4600 itself is often taken here.
      Origin: 'http://127.0.0.1:4600',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, json: JSON.parse(text) };
  } catch {
    return { status: response.status, json: null };
  }
}

async function mcpResources() {
  const post = (body) =>
    fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    }).then((r) => r.text());
  await post({
    jsonrpc: '2.0',
    id: 0,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'upgrade', version: '1' },
    },
  });
  const text = await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'list_resources', arguments: {} },
  });
  const line = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(JSON.parse(line.slice(6)).result.content[0].text).resources;
}

/** Runs a container of an image on the test volume; resolves when it answers. */
async function run(image) {
  docker('rm', '-f', NAME);
  const started = docker(
    'run',
    '-d',
    '--name',
    NAME,
    '-p',
    `127.0.0.1:${PORT}:4600`,
    '-v',
    `${VOLUME}:/data`,
    '-v',
    `${configDir}:/config`,
    '--add-host',
    'host.docker.internal:host-gateway',
    image,
  );
  if (started.status !== 0) throw new Error(started.stderr);
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) {
        token = docker('exec', NAME, 'cat', '/data/session-token').stdout.trim();
        return;
      }
    } catch {
      // not yet
    }
    await sleep(1000);
  }
  throw new Error(
    `${image} did not start:\n${docker('logs', NAME).stdout}${docker('logs', NAME).stderr}`,
  );
}
const logs = () => `${docker('logs', NAME).stdout}${docker('logs', NAME).stderr}`;

/** Copies the volume's files out of the stopped container. */
function copyData(label) {
  docker('stop', NAME);
  const to = join(work, label);
  mkdirSync(to, { recursive: true });
  const copied = docker('cp', `${NAME}:/data/.`, to);
  if (copied.status !== 0) throw new Error(copied.stderr);
  return to;
}
function fingerprint(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    return Object.fromEntries(
      tables.map((t) => [
        t,
        db
          .prepare(`SELECT * FROM "${t}"`)
          .all()
          .map((r) => JSON.stringify(r)),
      ]),
    );
  } finally {
    db.close();
  }
}

// A MySQL user whose password goes into the old version's vault.
docker(
  'exec',
  'connectors-test-mysql-1',
  'mysql',
  '-uroot',
  '-ptest-root',
  '-e',
  `CREATE USER IF NOT EXISTS 'vaulttest'@'%' IDENTIFIED BY '${PASSWORD}'; GRANT PROCESS ON *.* TO 'vaulttest'@'%';`,
);
writeFileSync(join(configDir, 'hosts.yaml'), 'hosts: []\n');

console.log(`Docker upgrade ${OLD} → ${NEW}, volume ${VOLUME}\n`);
try {
  // ─── 1. The old image, used for a while ─────────────────────────────────
  await run(OLD);
  const seeded = {
    resource: await api('POST', '/api/resources', {
      resource: {
        kind: 'mysql',
        id: 'vault-db',
        host: 'host.docker.internal',
        port: 13306,
        user: 'vaulttest',
        district: 'Databases',
      },
      secrets: { password: PASSWORD },
    }),
    probe: await api('POST', '/api/resources', {
      resource: {
        kind: 'tcp',
        id: 'ssh-probe',
        host: 'host.docker.internal',
        port: 2222,
        district: 'Lab',
      },
    }),
    channel: await api('POST', '/api/alerts/channels', {
      type: 'ntfy',
      name: 'Docker upgrade test',
      settings: { server: 'http://host.docker.internal:8090', topic: 'qa-docker-upgrade' },
    }),
    settings: await api('PUT', '/api/settings', { app: { historyRetentionDays: 30 } }),
  };
  for (const [what, response] of Object.entries(seeded)) {
    check(
      `seeding with the old image: ${what} accepted`,
      response.status === 200,
      `HTTP ${response.status}`,
    );
  }
  await sleep(45_000);
  docker('restart', NAME); // as users do
  await sleep(10_000);
  const beforeDir = copyData('before');
  const before = fingerprint(join(beforeDir, 'state.db'));
  const beforeHashes = {
    vault: md5(join(beforeDir, 'vault.key')),
    token: md5(join(beforeDir, 'session-token')),
  };
  const resourcesYaml = md5(join(configDir, 'resources.yaml'));
  console.log(
    `before: ${Object.entries(before)
      .map(([t, r]) => `${t}=${r.length}`)
      .join(' ')}\n`,
  );
  docker('rm', '-f', NAME);

  // ─── 2. `docker pull` + recreate: the new image on the same volume ──────────
  await run(NEW);
  await sleep(8000);
  check('the new container says it saved a copy first', /Saved a copy of your data/.test(logs()));
  check('the old link (session token) still works', (await api('GET', '/api/meta')).status === 200);
  check(
    'the saved database password is still there',
    (await api('GET', '/api/resources/vault-db/credentials')).json?.password === true,
  );
  let status = 'missing';
  for (let i = 0; i < 20 && status !== 'online'; i++) {
    const resource = (await mcpResources()).find((r) => r.id === 'vault-db');
    status =
      resource?.status === 'online'
        ? 'online'
        : resource
          ? `${resource.status}: ${resource.statusReason}`
          : 'missing';
    if (status !== 'online') await sleep(2000);
  }
  check('the database connects with the password from the old vault', status === 'online', status);
  const channel = (await api('GET', '/api/alerts')).json?.channels?.find(
    (c) => c.name === 'Docker upgrade test',
  );
  check(
    'the alert channel and its secret topic are still there',
    channel?.secretsSet?.includes('topic'),
  );
  const sent = channel ? await api('POST', '/api/alerts/test', { id: channel.id }) : null;
  check(
    'the alert channel still sends (its secret decrypts)',
    sent?.json?.ok === true,
    sent?.json?.error,
  );
  check(
    'the changed setting is kept',
    (await api('GET', '/api/settings')).json?.app?.historyRetentionDays === 30,
  );
  const afterDir = copyData('after');

  // ─── 3. Nothing lost, nothing changed ───────────────────────────────────
  const backups = existsSync(join(afterDir, 'backups'))
    ? readdirSync(join(afterDir, 'backups'))
    : [];
  check('a snapshot is in the volume (/data/backups)', backups.length === 1, backups[0]);
  if (backups[0]) {
    const snap = fingerprint(join(afterDir, 'backups', backups[0], 'state.db'));
    check(
      'the snapshot holds every row of the old database',
      JSON.stringify(snap) === JSON.stringify(before),
    );
    check(
      'the snapshot holds the vault key',
      md5(join(afterDir, 'backups', backups[0], 'vault.key')) === beforeHashes.vault,
    );
  }
  const marker = JSON.parse(readFileSync(join(afterDir, 'data-version.json'), 'utf8'));
  check(
    'the new version recorded that it owns the data',
    Boolean(marker.version),
    JSON.stringify(marker),
  );
  const after = fingerprint(join(afterDir, 'state.db'));
  const identical = [
    'audit_log',
    'secrets',
    'status_events',
    'app_settings',
    'threat_findings',
    'threat_baselines',
  ];
  for (const [table, rows] of Object.entries(before)) {
    const kept = new Set(after[table] ?? []);
    const lost = rows.filter((row) => !kept.has(row));
    if (identical.includes(table)) {
      check(
        `${table}: every old row is still there, unchanged`,
        lost.length === 0,
        `${rows.length} → ${(after[table] ?? []).length}, ${lost.length} missing`,
      );
    } else {
      check(
        `${table}: no fewer rows than before`,
        (after[table] ?? []).length >= rows.length,
        `${rows.length} → ${(after[table] ?? []).length}`,
      );
    }
  }
  check('vault key unchanged', md5(join(afterDir, 'vault.key')) === beforeHashes.vault);
  check('session token unchanged', md5(join(afterDir, 'session-token')) === beforeHashes.token);
  check('resources.yaml unchanged', md5(join(configDir, 'resources.yaml')) === resourcesYaml);

  // ─── 4. The next start ──────────────────────────────────────────────────
  docker('start', NAME);
  await sleep(10_000);
  const again = docker('exec', NAME, 'ls', '/data/backups')
    .stdout.trim()
    .split('\n')
    .filter(Boolean);
  check('no second snapshot on the next start', again.length === 1, again.join(', '));
} finally {
  docker('rm', '-f', NAME);
  docker('volume', 'rm', VOLUME);
}
console.log(
  `\nDocker ${OLD} → ${NEW}: ${passed} passed, ${failed.length} failed${failed.length ? `\n  ${failed.join('\n  ')}` : ''}`,
);
process.exit(failed.length ? 1 : 0);
