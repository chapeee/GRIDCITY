// Upgrade test: an installation of a PUBLISHED version, full of real data, is
// updated to the new build, and every piece of data must survive unchanged.
//
//   node scripts/qa/upgrade-test.mjs --old <old gridcity package dir> --new <new package dir>
//        [--driver node]   run both with the SQLite built into Node.js (what the desktop app does)
//
// Needs the QA containers (node scripts/qa/pass.mjs up): the attack lab's SSH server
// for history, the MySQL test user for a vault password, ntfy for an alert secret.
import { spawn, spawnSync } from 'node:child_process';
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
const arg = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? resolve(process.argv[index + 1]) : undefined;
};
const oldPackage = arg('--old');
const newPackage = arg('--new');
const nodeDriver = process.argv.includes('--driver') && process.argv.includes('node');
// --old-runtime / --new-runtime <exe>: run that side's server with this executable as Node.js,
// e.g. the desktop app's GRIDCITY.exe or Electron, as the desktop app itself does.
const runtimes = { old: arg('--old-runtime'), new: arg('--new-runtime') };
if (!oldPackage || !newPackage) throw new Error('--old <package dir> and --new <package dir>');
const Database = createRequire(join(root, 'package.json'))('better-sqlite3');
const version = (pkg) => JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')).version;

const PORT = 4730 + Math.floor(Math.random() * 60);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'QA-Unique-Pw-8841'; // the MySQL test user's (scripts/qa: vaulttest)
const work = mkdtempSync(join(tmpdir(), 'gridcity-upgrade-'));
const dirs = {
  DATA_DIR: join(work, 'data'),
  CONFIG_DIR: join(work, 'config'),
  SSH_DIR: join(work, 'ssh'),
};
const env = {
  ...process.env,
  ...dirs,
  GRIDCITY_PACKAGED: '1',
  PROJECT_NAME: 'GRIDCITY',
  ...(nodeDriver ? { GRIDCITY_SQLITE_DRIVER: 'node' } : {}),
};
delete env.ELECTRON_RUN_AS_NODE;

let passed = 0;
const failed = [];
const check = (name, ok, detail = '') => {
  if (ok) passed++;
  else failed.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const md5 = (file) =>
  existsSync(file) ? createHash('md5').update(readFileSync(file)).digest('hex') : null;
const token = () => readFileSync(join(dirs.DATA_DIR, 'session-token'), 'utf8').trim();

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Origin: BASE,
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

/** Resources with their live status, as an AI agent reads them (MCP list_resources). */
async function mcpResources() {
  const post = (body) =>
    fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token()}`,
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

/** Starts a version's server in the foreground on the shared folders; resolves when it answers. */
async function start(pkg, label) {
  const entry = join(pkg, 'apps/server/dist/index.js');
  const runtime = pkg === oldPackage ? runtimes.old : runtimes.new;
  const child = spawn(runtime ?? process.execPath, [entry, '--port', String(PORT)], {
    env: runtime ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
    cwd: work,
  });
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error(`${label} exited:\n${output}`);
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return { child, output: () => output };
    } catch {
      // not yet
    }
    await sleep(500);
  }
  throw new Error(`${label} did not start:\n${output}`);
}
async function stop(server) {
  server.child.kill();
  await new Promise((done) => server.child.once('exit', done));
  await sleep(500);
}

/** Every table's rows (as JSON), read straight from the database file. */
function fingerprint(file = join(dirs.DATA_DIR, 'state.db')) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    return Object.fromEntries(
      tables.map((table) => [
        table,
        db
          .prepare(`SELECT * FROM "${table}"`)
          .all()
          .map((r) => JSON.stringify(r)),
      ]),
    );
  } finally {
    db.close();
  }
}
const files = () =>
  Object.fromEntries(
    [
      ...['vault.key', 'session-token'].map((name) => join(dirs.DATA_DIR, name)),
      ...['hosts.yaml', 'resources.yaml'].map((name) => join(dirs.CONFIG_DIR, name)),
    ].map((file) => [file, md5(file)]),
  );

// ─── 1. The published version, used for a while ─────────────────────────────
const from = version(oldPackage);
const to = version(newPackage);
console.log(
  `Upgrade ${from} → ${to}${nodeDriver ? ' (built-in SQLite, like the desktop app)' : ''} in ${work}\n`,
);

// A MySQL user whose password goes into the old version's vault.
spawnSync('docker', [
  'exec',
  'connectors-test-mysql-1',
  'mysql',
  '-uroot',
  '-ptest-root',
  '-e',
  `CREATE USER IF NOT EXISTS 'vaulttest'@'%' IDENTIFIED BY '${PASSWORD}'; GRANT PROCESS ON *.* TO 'vaulttest'@'%';`,
]);

mkdirSync(dirs.CONFIG_DIR, { recursive: true });
mkdirSync(dirs.SSH_DIR, { recursive: true });
const keyFile = join(root, 'scripts/security-lab/.keys/gridcity_lab').replaceAll('\\', '/');
writeFileSync(
  join(dirs.CONFIG_DIR, 'hosts.yaml'),
  `hosts:\n  - id: lab-target\n    name: lab-target\n    address: 127.0.0.1\n    port: 2222\n    user: ops\n    auth: { method: keyFile, path: ${keyFile} }\n    district: Lab\n`,
);
const scan = spawnSync('ssh-keyscan', ['-p', '2222', '-t', 'ed25519', '127.0.0.1'], {
  encoding: 'utf8',
});
writeFileSync(
  join(dirs.SSH_DIR, 'known_hosts'),
  `${scan.stdout.split('\n').find((line) => line.includes('ssh-ed25519'))}\n`,
);

let old = await start(oldPackage, `gridcity ${from}`);
const seeded = {
  resource: await api('POST', '/api/resources', {
    resource: {
      kind: 'mysql',
      id: 'vault-db',
      host: '127.0.0.1',
      port: 13306,
      user: 'vaulttest',
      district: 'Databases',
    },
    secrets: { password: PASSWORD },
  }),
  channel: await api('POST', '/api/alerts/channels', {
    type: 'ntfy',
    name: 'Upgrade test',
    settings: { server: 'http://127.0.0.1:8090', topic: 'qa-upgrade-test' },
  }),
  settings: await api('PUT', '/api/settings', { app: { historyRetentionDays: 30 } }),
};
console.log(
  `seeded with ${from}: resource ${seeded.resource.status}, alert channel ${seeded.channel.status}, settings ${seeded.settings.status}`,
);
// A refused seed would leave nothing to compare and pass on empty data: fail instead.
for (const [what, response] of Object.entries(seeded)) {
  check(
    `seeding with ${from}: ${what} accepted`,
    response.status === 200,
    `HTTP ${response.status}`,
  );
}
await sleep(40_000); // metrics, status changes, discovery, a security sweep
await stop(old);
// Restart once, as users do, so the old version wrote everything it writes on start.
old = await start(oldPackage, `gridcity ${from} (again)`);
await sleep(8000);
await stop(old);

const before = fingerprint();
const beforeFiles = files();
const lastSampleBefore = Math.max(
  ...before.metric_samples.map((r) => JSON.parse(r).bucket ?? 0),
  0,
);
console.log(
  `before: ${Object.entries(before)
    .map(([t, rows]) => `${t}=${rows.length}`)
    .join(' ')}\n`,
);

// ─── 2. The update ────────────────────────────────────────────────────────────
const upgraded = await start(newPackage, `gridcity ${to}`);
await sleep(6000);

const backups = existsSync(join(dirs.DATA_DIR, 'backups'))
  ? readdirSync(join(dirs.DATA_DIR, 'backups'))
  : [];
check(
  'a snapshot was taken before the new version used the data',
  backups.length === 1,
  backups[0],
);
check(
  'the console says where the snapshot is',
  /Saved a copy of your data/.test(upgraded.output()),
);
if (backups[0]) {
  const snap = fingerprint(join(dirs.DATA_DIR, 'backups', backups[0], 'state.db'));
  check(
    'the snapshot holds every row of the old database',
    JSON.stringify(snap) === JSON.stringify(before),
  );
  check(
    'the snapshot holds the vault key and settings files',
    md5(join(dirs.DATA_DIR, 'backups', backups[0], 'vault.key')) ===
      beforeFiles[join(dirs.DATA_DIR, 'vault.key')] &&
      existsSync(join(dirs.DATA_DIR, 'backups', backups[0], 'config', 'hosts.yaml')),
  );
}
const marker = JSON.parse(readFileSync(join(dirs.DATA_DIR, 'data-version.json'), 'utf8'));
check(
  'the new version records that it now owns the data',
  marker.version === to,
  JSON.stringify(marker),
);

check('the old link (session token) still works', (await api('GET', '/api/meta')).status === 200);
if (seeded.resource.status === 200) {
  const credentials = await api('GET', '/api/resources/vault-db/credentials');
  check('the saved database password is still there', credentials.json?.password === true);
  // The running poller is the real proof: it connects with the password from the vault.
  let status = 'missing';
  for (let i = 0; i < 20 && status !== 'online'; i++) {
    const resource = (await mcpResources()).find((r) => r.id === 'vault-db');
    status = resource ? `${resource.status}: ${resource.statusReason}` : 'missing';
    if (resource?.status === 'online') status = 'online';
    else await sleep(2000);
  }
  check('the database connects with the password from the old vault', status === 'online', status);
}
if (seeded.channel.status === 200) {
  const alerts = await api('GET', '/api/alerts');
  const channel = alerts.json?.channels?.find((c) => c.name === 'Upgrade test');
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
}
if (seeded.settings.status === 200) {
  const settings = await api('GET', '/api/settings');
  check(
    'the changed setting is kept',
    settings.json?.app?.historyRetentionDays === 30,
    JSON.stringify(settings.json?.app),
  );
}
const history = await api('GET', '/api/history?target=lab-target&days=1');
check(
  'history recorded by the old version is still shown',
  JSON.stringify(history.json ?? {}).length > 200 && history.status === 200,
  `HTTP ${history.status}`,
);
await stop(upgraded);

// ─── 3. Nothing lost, nothing changed ───────────────────────────────────────
const after = fingerprint();
for (const [table, rows] of Object.entries(before)) {
  const kept = new Set(after[table] ?? []);
  const lost = rows.filter((row) => !kept.has(row));
  // Live tables update rows in place (thresholds, layout); the record tables must be identical.
  const mustBeIdentical = [
    'audit_log',
    'secrets',
    'status_events',
    'app_settings',
    'threat_findings',
    'threat_baselines',
  ];
  if (mustBeIdentical.includes(table)) {
    check(
      `${table}: every old row is still there, unchanged`,
      lost.length === 0,
      `${rows.length} before, ${(after[table] ?? []).length} after, ${lost.length} missing`,
    );
  } else {
    check(
      `${table}: no fewer rows than before`,
      (after[table] ?? []).length >= rows.length,
      `${rows.length} → ${(after[table] ?? []).length}`,
    );
  }
}
check(
  'metric history from before the update is all still there',
  after.metric_samples.filter((r) => (JSON.parse(r).bucket ?? 0) <= lastSampleBefore).length >=
    before.metric_samples.length,
);
for (const [file, hash] of Object.entries(beforeFiles)) {
  if (hash) check(`${file.split(/[\\/]/).slice(-1)[0]} unchanged`, md5(file) === hash);
}

// ─── 4. The next start ───────────────────────────────────────────────────────
const again = await start(newPackage, `gridcity ${to} (second start)`);
await sleep(3000);
await stop(again);
check(
  'no second snapshot on the next start',
  readdirSync(join(dirs.DATA_DIR, 'backups')).length === 1,
);

console.log(
  `\n${from} → ${to}: ${passed} passed, ${failed.length} failed${failed.length ? `\n  ${failed.join('\n  ')}` : ''}`,
);
process.exit(failed.length ? 1 : 0);
