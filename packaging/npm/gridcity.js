#!/usr/bin/env node
// The `gridcity` command. Starts the app, or runs one of its tools.
// Installed from npm, the app keeps its settings in your user config folder,
// never in the folder you start it from.
//
// `gridcity` and `gridcity demo` start the server in the background, so it
// keeps watching your servers (and sending alerts) after the terminal closes.
// `--foreground` keeps it attached to the terminal instead.
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = createRequire(import.meta.url)(join(root, 'package.json'));

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(
    `gridcity needs Node.js 22.12 or newer (this is ${process.versions.node}).\n`,
  );
  process.exit(1);
}

process.env.GRIDCITY_PACKAGED = '1';
process.env.PROJECT_NAME ??= 'GRIDCITY';
// A command-line tool prints its link, warnings and errors; request logs are for debugging.
process.env.LOG_LEVEL ??= 'warn';

const HELP = `
  gridcity ${pkg.version} · your servers as a living city of light

  gridcity                      start with your servers in the background,
                                then open the printed link
  gridcity demo                 start with a simulated city (no setup at all)
  gridcity status               is it running? prints the link again
  gridcity stop                 stop the background server
  gridcity restart              stop, then start with the same mode and port
  gridcity logs [-f]            show the background server's log (-f: follow)
  gridcity doctor [--json]      check this machine and every server, database,
                                bucket and probe; proves fixes (exit 1 on problems)
  gridcity mcp                  connect Claude Code or any MCP app to your city
  gridcity add-host user@host   test and add one SSH server
  gridcity import-ssh-config    add every host from ~/.ssh/config

  Options for start and demo:
    --port <n>      serve on this port (default 4600, always 127.0.0.1 only)
    --open          open the browser
    --new-token     new link: signs out every browser
    --foreground    stay in this terminal (Ctrl+C stops it); for systemd,
                    launchd, Task Scheduler or a container

  Everything else (servers, databases, keys, alerts) is set up in the app.
  Docs: https://chapeee.github.io/GRIDCITY/
`;

const ENTRIES = {
  start: 'index.js',
  demo: 'index.js',
  doctor: 'doctor.js',
  mcp: 'mcp-setup.js',
  'add-host': 'add-host.js',
  'import-ssh-config': 'import-ssh-config.js',
};
const CONTROL = new Set(['status', 'stop', 'restart', 'logs']);

const args = process.argv.slice(2);
const first = args[0];
if (first === '--help' || first === '-h' || first === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}
if (first === '--version' || first === '-v' || first === 'version') {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const command = first && !first.startsWith('-') ? first : 'start';
if (!ENTRIES[command] && !CONTROL.has(command)) {
  process.stderr.write(`Unknown command "${command}".\n${HELP}`);
  process.exit(1);
}
const rest =
  command === 'start' && first?.startsWith('-') ? args : args.slice(first === command ? 1 : 0);

// ---------------------------------------------------------------------------
// Background server: where it keeps its pid, state and log.

/** Same folder as the server's data (apps/server/src/config/app-paths.ts). */
function dataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const slug = process.env.PROJECT_NAME.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const home = homedir();
  return process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), slug)
    : join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), slug);
}
const DIR = dataDir();
const STATE_FILE = join(DIR, 'server.json');
const LOG_FILE = join(DIR, 'server.log');

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return undefined;
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function isHealthy(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** The background server, if one is running (a stale state file is removed). */
async function running() {
  const state = readState();
  if (!state) return undefined;
  if (isAlive(state.pid) && (await isHealthy(state.port))) return state;
  if (!isAlive(state.pid)) rmSync(STATE_FILE, { force: true });
  return isAlive(state.pid) ? { ...state, starting: true } : undefined;
}

function link(port) {
  try {
    const token = readFileSync(join(DIR, 'session-token'), 'utf8').trim();
    return `http://127.0.0.1:${port}/?token=${token}`;
  } catch {
    return `http://127.0.0.1:${port}/`;
  }
}

function portOf(list) {
  const index = list.findIndex((arg) => arg === '--port' || arg.startsWith('--port='));
  if (index < 0) return Number(process.env.SERVER_PORT ?? 4600);
  const arg = list[index];
  return Number(arg.includes('=') ? arg.split('=')[1] : list[index + 1]);
}

function printRunning(state, note) {
  const mode = state.mode === 'demo' ? 'demo (simulated city)' : 'your servers';
  process.stdout.write(
    `\n  ${process.env.PROJECT_NAME} ${note} · ${mode} · pid ${state.pid}\n\n` +
      `    ${link(state.port)}\n\n` +
      '  It keeps running after you close this terminal.\n' +
      '  gridcity stop · gridcity status · gridcity logs\n\n',
  );
}

function tail(file, lines) {
  try {
    return readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

function openInBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // No browser here: the link is printed.
  }
}

async function startBackground(mode, options) {
  const current = await running();
  if (current) {
    if (current.mode !== mode) {
      process.stderr.write(
        `\n  ${process.env.PROJECT_NAME} is already running with ${current.mode === 'demo' ? 'the demo' : 'your servers'}.\n` +
          `  Run "gridcity stop" first, then "gridcity${mode === 'demo' ? ' demo' : ''}".\n\n`,
      );
      process.exit(1);
    }
    printRunning(current, 'is already running');
    if (options.includes('--open')) openInBrowser(link(current.port));
    return;
  }

  const port = portOf(options);
  if (await isHealthy(port)) {
    process.stderr.write(
      `\n  Port ${port} is already in use by another server (maybe "gridcity --foreground" in another terminal).\n` +
        '  Stop it, or choose another port with --port <n>.\n\n',
    );
    process.exit(1);
  }

  mkdirSync(DIR, { recursive: true });
  if (existsSync(LOG_FILE)) renameSync(LOG_FILE, `${LOG_FILE}.old`);
  const log = openSync(LOG_FILE, 'a');
  const childArgs = [
    fileURLToPath(import.meta.url),
    mode,
    '--foreground',
    ...options.filter((arg) => arg !== '--open'),
  ];
  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: ['ignore', log, log],
    windowsHide: true,
    env: { ...process.env, GRIDCITY_BACKGROUND: '1' },
  });
  closeSync(log);
  let exited = false;
  child.once('exit', () => (exited = true));
  const state = { pid: child.pid, port, mode, options, startedAt: new Date().toISOString() };
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  child.unref();

  process.stdout.write(`  Starting ${process.env.PROJECT_NAME} in the background…`);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited || !isAlive(child.pid)) break;
    if (await isHealthy(port)) {
      process.stdout.write('\n');
      printRunning(state, 'is running');
      if (options.includes('--open')) openInBrowser(link(port));
      process.exit(0);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  process.stdout.write('\n');
  const stillAlive = isAlive(child.pid);
  if (!stillAlive) rmSync(STATE_FILE, { force: true });
  process.stderr.write(
    stillAlive
      ? `\n  ${process.env.PROJECT_NAME} has not answered yet (pid ${child.pid}). Check "gridcity status" or "gridcity logs".\n\n`
      : `\n  ${process.env.PROJECT_NAME} stopped while starting:\n\n${tail(LOG_FILE, 20)}\n\n  Full log: ${LOG_FILE}\n\n`,
  );
  process.exit(1);
}

async function stop({ quiet = false } = {}) {
  const state = readState();
  if (!state || !isAlive(state.pid)) {
    rmSync(STATE_FILE, { force: true });
    if (!quiet) process.stdout.write(`  ${process.env.PROJECT_NAME} is not running.\n`);
    return undefined;
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    // Gone already.
  }
  const deadline = Date.now() + 10_000;
  while (isAlive(state.pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (isAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGKILL');
    } catch {
      // Gone already.
    }
  }
  rmSync(STATE_FILE, { force: true });
  if (!quiet) process.stdout.write(`  ${process.env.PROJECT_NAME} stopped (pid ${state.pid}).\n`);
  return state;
}

async function logs(follow) {
  if (!existsSync(LOG_FILE)) {
    process.stdout.write(`  No log yet (${LOG_FILE}).\n`);
    return;
  }
  process.stdout.write(`${tail(LOG_FILE, 200)}\n`);
  if (!follow) return;
  let size = statSync(LOG_FILE).size;
  setInterval(() => {
    let now;
    try {
      now = statSync(LOG_FILE).size;
    } catch {
      return;
    }
    if (now < size) size = 0;
    if (now === size) return;
    const fd = openSync(LOG_FILE, 'r');
    const buffer = Buffer.alloc(now - size);
    readSync(fd, buffer, 0, buffer.length, size);
    closeSync(fd);
    process.stdout.write(buffer);
    size = now;
  }, 500);
}

// ---------------------------------------------------------------------------

const foreground = rest.includes('--foreground');
const options = rest.filter((arg) => arg !== '--foreground');

if (command === 'status') {
  const state = await running();
  if (!state) {
    process.stdout.write(
      `  ${process.env.PROJECT_NAME} is not running. Start it with "gridcity".\n`,
    );
    process.exit(1);
  }
  if (state.starting) {
    process.stdout.write(`  ${process.env.PROJECT_NAME} is starting (pid ${state.pid}).\n`);
  } else {
    printRunning(state, 'is running');
  }
  process.exit(0);
}
if (command === 'stop') {
  await stop();
  process.exit(0);
}
if (command === 'restart') {
  const previous = await stop({ quiet: true });
  const mode = previous?.mode ?? 'start';
  const keep = (previous?.options ?? []).filter((arg) => arg !== '--new-token' && arg !== '--open');
  await startBackground(mode, [...keep, ...options]);
} else if (command === 'logs') {
  await logs(rest.includes('-f') || rest.includes('--follow'));
} else if ((command === 'start' || command === 'demo') && !foreground) {
  await startBackground(command, options);
} else {
  const entry = ENTRIES[command];
  process.argv = [
    process.argv[0],
    join(root, 'apps/server/dist', entry),
    ...(command === 'demo' ? ['--demo'] : []),
    ...options,
  ];
  await import(pathToFileURL(join(root, 'apps/server/dist', entry)).href);
}
