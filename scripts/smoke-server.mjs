// Starts the *built* server the way users run it and checks that it really
// works: catches problems unit tests cannot see, such as ESM/CommonJS
// interop in the bundle. Runs in demo mode with throwaway directories.
//
//   npm run smoke   (builds first)
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4699;
const TIMEOUT_MS = 20_000;
const workDir = mkdtempSync(join(tmpdir(), 'smoke-'));

const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  env: {
    ...process.env,
    DATA_MODE: 'demo',
    SERVER_PORT: String(PORT),
    CONFIG_DIR: join(workDir, 'config'),
    DATA_DIR: join(workDir, 'data'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
server.stdout.on('data', (chunk) => (output += chunk));
server.stderr.on('data', (chunk) => (output += chunk));

async function finish(ok, message) {
  server.removeAllListeners('exit');
  if (server.exitCode === null) {
    server.kill();
    // Windows keeps the database file locked until the process is really gone.
    await Promise.race([once(server, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover temp directory is harmless.
  }
  console.log(`${ok ? 'smoke: OK' : 'smoke: FAILED'} - ${message}`);
  if (!ok) console.log(output.replace(/token=[\w-]+/g, 'token=<redacted>'));
  process.exit(ok ? 0 : 1);
}

const timer = setTimeout(() => finish(false, 'server did not start in time'), TIMEOUT_MS);
server.on('exit', (code) => finish(false, `server exited early with code ${code}`));

const waitForToken = setInterval(async () => {
  const token = /token=([\w-]+)/.exec(output)?.[1];
  if (!token) return;
  clearInterval(waitForToken);
  clearTimeout(timer);
  server.removeAllListeners('exit');
  try {
    const unauthorized = await fetch(`http://127.0.0.1:${PORT}/api/meta`);
    const meta = await fetch(`http://127.0.0.1:${PORT}/api/meta`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const page = await fetch(`http://127.0.0.1:${PORT}/?token=${token}`);
    if (unauthorized.status !== 401)
      return finish(false, `expected 401 without token, got ${unauthorized.status}`);
    if (meta.status !== 200) return finish(false, `expected 200 for /api/meta, got ${meta.status}`);
    if (page.status !== 200) return finish(false, `expected the web app, got ${page.status}`);
    finish(true, `built server runs (demo mode), token enforced, web app served`);
  } catch (error) {
    finish(false, String(error));
  }
}, 100);
