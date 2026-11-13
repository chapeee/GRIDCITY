// GRIDCITY desktop: a window (Chromium, from Electron) and a tray icon around
// the same server the `gridcity` npm command runs.
//
// It does not run its own copy of the server code. It asks the bundled
// `gridcity` command to start the background server (Electron's own binary
// acts as Node.js for it), then opens that server's link in a window. So the
// desktop app and the npm command share one server, one database and one set
// of settings in the user's data folder, and either can stop it:
//
//   - A server already running (started from a terminal with `gridcity`) is
//     reused as it is, unless it is an older version: then it is restarted.
//   - Closing the window keeps GRIDCITY in the tray; the server keeps watching
//     and alerting. "Quit" leaves it running in the background (like the CLI);
//     "Stop GRIDCITY and quit" stops it.
'use strict';

const { spawn } = require('node:child_process');
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { dirname, join } = require('node:path');
const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } = require('electron');

const PROJECT_NAME = 'GRIDCITY';
const cliPath = require.resolve('gridcity/bin/gridcity.js');
const bundledVersion = JSON.parse(
  readFileSync(join(dirname(cliPath), '..', 'package.json'), 'utf8'),
).version;
const iconPath = join(__dirname, 'icon.png');

// --- the shared data folder (same rule as the CLI and the server) ----------

function dataDir() {
  if (process.env.DATA_DIR) return process.env.DATA_DIR;
  const slug = PROJECT_NAME.toLowerCase();
  const home = homedir();
  return process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), slug)
    : join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), slug);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function readToken() {
  try {
    return readFileSync(join(dataDir(), 'session-token'), 'utf8').trim();
  } catch {
    return undefined;
  }
}

// --- talking to the server ---------------------------------------------------

/** Runs the bundled `gridcity` command with Electron acting as Node.js. */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        // Electron's Node.js has SQLite built in; better-sqlite3 is a native
        // module built for plain Node.js and is not shipped with the app.
        GRIDCITY_SQLITE_DRIVER: process.env.GRIDCITY_SQLITE_DRIVER ?? 'node',
      },
      windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => resolve({ code: 1, output: `${output}${error.message}` }));
    child.on('exit', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok ? await response.json() : undefined;
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

/** The background server from server.json, if it answers. */
async function runningServer() {
  const state = readJson(join(dataDir(), 'server.json'));
  if (!state || !isAlive(state.pid)) return undefined;
  return (await fetchJson(`http://127.0.0.1:${state.port}/healthz`)) ? state : undefined;
}

function olderThan(a, b) {
  const pa = String(a).split(/[.-]/).map(Number);
  const pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0);
  }
  return false;
}

/** Makes sure the background server runs (this version or newer); returns its state. */
async function ensureServer() {
  let state = await runningServer();
  if (state) {
    const meta = await fetchJson(
      `http://127.0.0.1:${state.port}/api/meta?token=${encodeURIComponent(readToken() ?? '')}`,
    );
    if (meta?.version && olderThan(meta.version, bundledVersion)) {
      setStatus(`Updating the running server ${meta.version} → ${bundledVersion}…`);
      await runCli(['stop']);
      state = undefined;
    }
  }
  if (!state) {
    setStatus('Starting GRIDCITY…');
    const result = await runCli(['start']);
    state = await runningServer();
    if (!state) throw new Error(result.output.trim() || 'The server did not start.');
  }
  return state;
}

// --- window and tray ---------------------------------------------------------

let mainWindow;
let tray;
let serverState;
let quitting = false;

function setStatus(text) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:grid;place-items:center;background:#050708;color:#8fe3ff;font:15px system-ui,sans-serif;letter-spacing:.04em">${text.replace(/</g, '&lt;')}</body>`;
  void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

function appUrl() {
  const token = readToken();
  const base = `http://127.0.0.1:${serverState.port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// --- start at login ------------------------------------------------------------
//
// The installed app adds itself to the login items on its first start (the
// tray's "Start at login" turns it off). At login it starts with --hidden:
// the server starts and the app waits in the tray, without opening a window.
// Windows and macOS use Electron's login items; Linux an autostart file.
// Not offered for `npx gridcity-desktop`, whose Electron lives in npm's cache.

const HIDDEN_FLAG = '--hidden';
/** Registry value / autostart name; the end-to-end test uses its own. */
const loginName = process.env.GRIDCITY_DESKTOP_LOGIN_NAME ?? PROJECT_NAME;
const loginSupported = app.isPackaged || Boolean(process.env.GRIDCITY_DESKTOP_LOGIN_NAME);

function linuxAutostartFile() {
  const config = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  return join(config, 'autostart', `${loginName.toLowerCase()}.desktop`);
}

function startAtLogin() {
  if (!loginSupported) return false;
  if (process.platform === 'linux') return existsSync(linuxAutostartFile());
  const settings = app.getLoginItemSettings({
    path: process.execPath,
    args: [HIDDEN_FLAG],
    name: loginName,
  });
  // Windows: openAtLogin compares the arguments, and Electron reads them back as
  // empty, so it says false for our "--hidden" entry. Match the entry by name.
  if (process.platform === 'win32') {
    return (settings.launchItems ?? []).some((item) => item.name === loginName && item.enabled);
  }
  return settings.openAtLogin;
}

function setStartAtLogin(enabled) {
  if (!loginSupported) return;
  if (process.platform === 'linux') {
    const file = linuxAutostartFile();
    if (!enabled) {
      rmSync(file, { force: true });
    } else {
      // An AppImage runs from a temporary mount: start the .AppImage file itself.
      const executable = process.env.APPIMAGE ?? process.execPath;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        [
          '[Desktop Entry]',
          'Type=Application',
          `Name=${PROJECT_NAME}`,
          'Comment=Keeps watching your servers after login',
          `Exec="${executable.replace(/"/g, '\\"')}" ${HIDDEN_FLAG}`,
          'Terminal=false',
          'X-GNOME-Autostart-enabled=true',
          '',
        ].join('\n'),
      );
    }
  } else {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      path: process.execPath,
      args: [HIDDEN_FLAG],
      name: loginName,
    });
  }
  updateTrayMenu();
}

/** The first start of the installed app turns start-at-login on, once. */
function applyLoginDefault() {
  if (!app.isPackaged) return;
  const file = join(app.getPath('userData'), 'desktop.json');
  const settings = readJson(file) ?? {};
  if (settings.loginDefaultApplied) return;
  setStartAtLogin(true);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...settings, loginDefaultApplied: true }, null, 2)}\n`);
}

function startedAtLogin() {
  if (process.argv.includes(HIDDEN_FLAG)) return true;
  return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin === true;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  if (serverState) void mainWindow.loadURL(appUrl());
  mainWindow.show();
  mainWindow.focus();
}

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    show,
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: PROJECT_NAME,
    backgroundColor: '#050708',
    icon: iconPath,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  // Links to other sites (docs, GitHub) open in the default browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('data:')) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  // Closing the window keeps the app (and the server) in the tray.
  mainWindow.on('close', (event) => {
    if (!quitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function buildTray() {
  const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip(PROJECT_NAME);
  tray.on('click', showWindow);
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const status = serverState
    ? `Running on port ${serverState.port} (${serverState.mode === 'demo' ? 'demo' : 'your servers'})`
    : 'Not running';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open ${PROJECT_NAME}`, click: showWindow },
      {
        label: 'Open in browser',
        enabled: Boolean(serverState),
        click: () => void shell.openExternal(appUrl()),
      },
      { type: 'separator' },
      { label: status, enabled: false },
      {
        label: serverState?.mode === 'demo' ? 'Switch to your servers' : 'Switch to the demo city',
        enabled: Boolean(serverState),
        click: () => void switchMode(serverState.mode === 'demo' ? 'start' : 'demo'),
      },
      { label: 'Open data folder', click: () => void shell.openPath(dataDir()) },
      {
        label: loginSupported ? 'Start at login' : 'Start at login (installed app only)',
        type: 'checkbox',
        enabled: loginSupported,
        checked: startAtLogin(),
        click: (item) => setStartAtLogin(item.checked),
      },
      { type: 'separator' },
      {
        label: 'Quit (keep monitoring in the background)',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
      {
        label: `Stop ${PROJECT_NAME} and quit`,
        click: async () => {
          quitting = true;
          await runCli(['stop']);
          app.quit();
        },
      },
    ]),
  );
}

/** Restarts the server with the demo city ('demo') or your servers ('start'). */
async function switchMode(mode) {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  mainWindow.show();
  setStatus(mode === 'demo' ? 'Starting the demo city…' : 'Starting with your servers…');
  await runCli(['stop']);
  const result = await runCli([mode]);
  serverState = await runningServer();
  updateTrayMenu();
  if (!serverState) {
    dialog.showErrorBox(`${PROJECT_NAME} could not start`, result.output.trim());
    return;
  }
  await mainWindow.loadURL(appUrl());
}

async function start() {
  // At login: start the server and wait in the tray (a window only if there is no tray).
  const hidden = startedAtLogin();
  try {
    buildTray();
  } catch {
    tray = undefined; // Some Linux desktops have no tray: closing the window then quits.
  }
  createWindow({ show: !hidden || !tray });
  setStatus('Starting GRIDCITY…');
  try {
    applyLoginDefault();
  } catch {
    // Login items are a convenience: never block the start on them.
  }
  try {
    serverState = await ensureServer();
  } catch (error) {
    dialog.showErrorBox(`${PROJECT_NAME} could not start`, String(error.message ?? error));
    quitting = true;
    app.quit();
    return;
  }
  updateTrayMenu();
  await mainWindow.loadURL(appUrl());
}

app.setName(PROJECT_NAME);
// The end-to-end test keeps its settings (and its single-instance lock) apart from a real install.
if (process.env.GRIDCITY_DESKTOP_USER_DATA) {
  app.setPath('userData', process.env.GRIDCITY_DESKTOP_USER_DATA);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (process.platform === 'win32') app.setAppUserModelId('io.github.chapeee.gridcity');
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('before-quit', () => (quitting = true));
  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });
  void app.whenReady().then(start);
  // For the end-to-end test (test-desktop.mjs), which drives the tray actions.
  globalThis.gridcityDesktop = {
    switchMode,
    setStartAtLogin,
    startAtLogin,
    hasTray: () => Boolean(tray && !tray.isDestroyed()),
    loginCommand: () => ({ path: process.execPath, args: [HIDDEN_FLAG] }),
  };
}
