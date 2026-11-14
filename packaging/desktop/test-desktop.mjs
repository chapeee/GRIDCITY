// End-to-end test of the desktop app (run after `node build.mjs --stage-only`,
// or against an unpacked installer build with --app <path to the executable>).
//
//   node test-desktop.mjs [--app <GRIDCITY executable>]
//
// Uses its own data and config folders and port, so it never touches a real
// GRIDCITY on this machine. Screenshots go to test-results/.
import { _electron as electron } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// --app-dir <folder>: run that app folder (e.g. a build's resources/app) with Electron.
const appDirIndex = process.argv.indexOf('--app-dir');
const stage = appDirIndex > 0 ? resolve(process.argv[appDirIndex + 1]) : join(here, 'stage');
const out = join(here, 'test-results');
const appIndex = process.argv.indexOf('--app');
const packaged = appIndex > 0 ? process.argv[appIndex + 1] : undefined;
const electronBinary = createRequire(import.meta.url)('electron');

const port = 4637;
const work = mkdtempSync(join(tmpdir(), 'gridcity-desktop-'));
const env = {
  ...process.env,
  DATA_DIR: join(work, 'data'),
  CONFIG_DIR: join(work, 'config'),
  SERVER_PORT: String(port),
  // Keep the app's own settings, login entry and autostart file apart from a real install.
  GRIDCITY_DESKTOP_USER_DATA: join(work, 'user-data'),
  GRIDCITY_DESKTOP_LOGIN_NAME: 'GRIDCITY-e2e-test',
  XDG_CONFIG_HOME: join(work, 'xdg-config'),
};
delete env.ELECTRON_RUN_AS_NODE;
mkdirSync(out, { recursive: true });

// Unpacked builds keep the app in resources/app (Windows, Linux) or
// GRIDCITY.app/Contents/Resources/app (macOS, next to Contents/MacOS/GRIDCITY).
const appDir = !packaged
  ? stage
  : process.platform === 'darwin'
    ? join(dirname(packaged), '..', 'Resources', 'app')
    : join(dirname(packaged), 'resources', 'app');
const cli = join(appDir, 'node_modules', 'gridcity', 'bin', 'gridcity.js');
/** The bundled CLI, run the way the app runs it (Electron as Node.js). */
// Output goes through a file, not a pipe: the background server it starts
// inherits the handle, and a pipe would then never close.
const runCli = (...args) => {
  const file = join(work, 'cli-output.txt');
  const fd = openSync(file, 'w');
  try {
    spawnSync(packaged ?? electronBinary, [cli, ...args], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1', GRIDCITY_SQLITE_DRIVER: 'node' },
      stdio: ['ignore', fd, fd],
      timeout: 90_000,
    });
  } finally {
    closeSync(fd);
  }
  return readFileSync(file, 'utf8');
};
const serverState = () => JSON.parse(readFileSync(join(env.DATA_DIR, 'server.json'), 'utf8'));
const healthy = async () => {
  try {
    return (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
  } catch {
    return false;
  }
};

async function launch(extraArgs = []) {
  const app = await electron.launch(
    packaged
      ? { executablePath: packaged, args: extraArgs, env }
      : { executablePath: electronBinary, args: [stage, ...extraArgs], env },
  );
  const page = await app.firstWindow();
  await page.waitForURL(new RegExp(`^http://127\\.0\\.0\\.1:${port}/`), { timeout: 90_000 });
  await page.waitForLoadState('load');
  return { app, page };
}

/**
 * Quits the app like the tray's Quit does, and waits for its process to end.
 * Not app.close(): on Windows the background server inherits the app's output
 * pipes, so Playwright would wait for them to close forever.
 */
async function quit(app) {
  const pid = app.process().pid;
  await app
    .evaluate(({ app: electronApp }) => setTimeout(() => electronApp.quit(), 50))
    .catch(() => {});
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the app did not quit');
}

const RUN_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LOGIN_NAME = env.GRIDCITY_DESKTOP_LOGIN_NAME;
/** Runs a PowerShell command, returns its trimmed output. */
function powershell(command) {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    command,
  ]);
  return result.stdout.toString().trim();
}

/** The test's login entry: the Windows Run value, or the Linux autostart file ('' if none). */
function loginEntry() {
  if (process.platform === 'linux') {
    try {
      return readFileSync(
        join(env.XDG_CONFIG_HOME, 'autostart', 'gridcity-e2e-test.desktop'),
        'utf8',
      );
    } catch {
      return '';
    }
  }
  return powershell(
    `(Get-ItemProperty -Path '${RUN_KEY}' -Name '${LOGIN_NAME}' -ErrorAction SilentlyContinue).'${LOGIN_NAME}'`,
  );
}

/** Rows in the history tables of state.db (read with the SQLite built into Node.js). */
function countRows() {
  const db = new DatabaseSync(join(env.DATA_DIR, 'state.db'), { readOnly: true });
  try {
    return ['status_events', 'metric_samples', 'audit_log', 'layout_slots'].reduce(
      (sum, table) => sum + Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n),
      0,
    );
  } finally {
    db.close();
  }
}

let failed = false;
const results = [];
const step = async (name, fn) => {
  const started = Date.now();
  await fn();
  results.push(`  ok  ${name} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  console.log(results.at(-1));
};

try {
  let firstPid;

  await step('first launch starts the server and opens the city', async () => {
    const { app, page } = await launch();
    assert.ok(await healthy(), 'server answers /healthz');
    firstPid = serverState().pid;
    assert.equal(serverState().mode, 'start');
    const token = readFileSync(join(env.DATA_DIR, 'session-token'), 'utf8').trim();
    const meta = await (await fetch(`http://127.0.0.1:${port}/api/meta?token=${token}`)).json();
    const version = JSON.parse(
      readFileSync(join(appDir, 'node_modules', 'gridcity', 'package.json'), 'utf8'),
    ).version;
    assert.equal(meta.version, version, 'server runs the bundled gridcity version');
    // The web app signs in with the link's token, then removes it from the address bar.
    const signedIn = await page.evaluate(async () => (await fetch('/api/meta')).ok);
    assert.ok(signedIn, 'the window is signed in (session token accepted)');
    await page.waitForTimeout(4000);
    await page.screenshot({ path: join(out, 'desktop-first-run.png') });
    assert.equal(
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle() !== ''),
      true,
    );
    await quit(app);
  });

  await step('quitting the app keeps the server monitoring in the background', async () => {
    assert.ok(await healthy());
    assert.equal(serverState().pid, firstPid);
    assert.match(runCli('status'), /is running/);
  });

  await step(
    'the CLI and the app share one server (demo started from the CLI is reused)',
    async () => {
      runCli('stop');
      assert.equal(await healthy(), false);
      runCli('demo');
      const demoPid = serverState().pid;
      const { app, page } = await launch();
      assert.equal(serverState().pid, demoPid, 'the app reused the running server');
      await page.waitForTimeout(8000);
      await page.screenshot({ path: join(out, 'desktop-demo-city.png') });
      await quit(app);
    },
  );

  await step('the tray switches between your servers and the demo city', async () => {
    const { app, page } = await launch();
    assert.equal(serverState().mode, 'demo');
    // The function the tray item calls.
    await app.evaluate(() => globalThis.gridcityDesktop.switchMode('start'));
    assert.equal(serverState().mode, 'start');
    await page.waitForURL(new RegExp(`^http://127\\.0\\.0\\.1:${port}/`));
    await quit(app);
  });

  await step('after a computer restart: the login entry starts GRIDCITY in the tray', async () => {
    // 1. Turn on "Start at login" from the app, as the tray checkbox does.
    let { app } = await launch();
    const hasLoginItems = process.platform === 'win32' || process.platform === 'linux';
    const command = await app.evaluate(() => globalThis.gridcityDesktop.loginCommand());
    if (hasLoginItems) {
      await app.evaluate(() => globalThis.gridcityDesktop.setStartAtLogin(true));
      assert.equal(await app.evaluate(() => globalThis.gridcityDesktop.startAtLogin()), true);
      const entry = loginEntry().toLowerCase();
      assert.ok(entry.includes(command.path.toLowerCase()), 'the entry runs this app');
      assert.match(entry, /--hidden/, 'the entry starts it hidden');
    }
    await quit(app);

    // 2. The restart: nothing of GRIDCITY is running any more.
    runCli('stop');
    assert.equal(await healthy(), false);

    // 3. Sign-in: run what the login entry runs (the app with --hidden).
    ({ app } = await launch(command.args));
    assert.ok(await healthy(), 'the server is monitoring again');
    assert.equal(await app.evaluate(() => globalThis.gridcityDesktop.hasTray()), true, 'tray icon');
    const visible = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible()),
    );
    assert.equal(visible, false, 'no window pops up at sign-in');
    if (hasLoginItems) {
      // 4. Turning it off removes the entry.
      await app.evaluate(() => globalThis.gridcityDesktop.setStartAtLogin(false));
      assert.equal(loginEntry(), '', 'the entry is gone');
    }
    await quit(app);
  });

  await step('data survives a restart (database rows and token kept)', async () => {
    const token = readFileSync(join(env.DATA_DIR, 'session-token'), 'utf8');
    runCli('stop');
    const before = countRows();
    assert.ok(before > 0, 'the database has rows (history, status events)');
    const { app } = await launch();
    assert.ok(countRows() >= before, 'no rows were lost');
    assert.equal(readFileSync(join(env.DATA_DIR, 'session-token'), 'utf8'), token);
    await quit(app);
  });

  console.log(`\nAll ${results.length} desktop checks passed. Screenshots: ${out}`);
} catch (error) {
  console.error(error);
  failed = true;
} finally {
  try {
    runCli('stop');
  } catch {
    // Not running.
  }
  if (process.platform === 'win32') {
    // A failed run must not leave the test's login entry behind.
    powershell(
      `Remove-ItemProperty -Path '${RUN_KEY}' -Name '${LOGIN_NAME}' -ErrorAction SilentlyContinue`,
    );
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
// Playwright still holds the pipes the background server inherited: exit explicitly.
process.exit(failed ? 1 : 0);
