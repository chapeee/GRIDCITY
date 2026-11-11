import { spawn } from 'node:child_process';
import { parseServerEnv } from './config/env';
import { loadEnvFiles } from './config/env-files';
import { decideBind } from './security/bind-guard';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveAppPaths } from './config/app-paths';
import { loadOrCreateSessionToken, TOKEN_QUERY_PARAM } from './security/session-token';
import { startServer } from './server';

/** `--dev` is passed by `npm run dev`: pretty logs, and print the Vite URL. */
const isDevMode = process.argv.includes('--dev');
/** `--demo` (used by `npm run demo`) serves the simulated fleet instead of hosts.yaml. */
const isDemoFlag = process.argv.includes('--demo');
/** `--new-token` replaces the saved session token (signs out every browser). */
const rotateToken = process.argv.includes('--new-token');
/** `--open` opens the app in the default browser once it is ready. */
const openBrowser = process.argv.includes('--open');
/** `--port <n>` (or `--port=<n>`) overrides SERVER_PORT. */
const portFlag = (() => {
  const index = process.argv.findIndex((arg) => arg === '--port' || arg.startsWith('--port='));
  if (index < 0) return undefined;
  const arg = process.argv[index]!;
  return arg.includes('=') ? arg.split('=')[1] : process.argv[index + 1];
})();

async function main(): Promise<void> {
  loadEnvFiles();
  process.env.PROJECT_NAME ??= 'GRIDCITY';
  if (portFlag) process.env.SERVER_PORT = portFlag;
  if (isDemoFlag) process.env.DATA_MODE = 'demo';
  const env = parseServerEnv(process.env);

  const bind = decideBind(env.HOST, env.BIND_INSIDE_CONTAINER);
  if (!bind.allowed) throw new Error(bind.reason);
  if (bind.warning) process.stderr.write(`${bind.warning}\n`);

  const { dataDir } = resolveAppPaths({
    projectName: env.PROJECT_NAME,
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
  });
  const sessionToken = loadOrCreateSessionToken(join(dataDir, 'session-token'), {
    rotate: rotateToken,
  });
  const server = await startServer({ env, sessionToken, devMode: isDevMode });

  // Printed straight to stdout, never through the logger, so the token does
  // not end up in log files or log shippers.
  const publicPort = isDevMode ? env.WEB_PORT : env.SERVER_PORT;
  const url = `http://127.0.0.1:${publicPort}/?${TOKEN_QUERY_PARAM}=${sessionToken}`;
  const fleet =
    env.DATA_MODE === 'demo'
      ? 'DEMO DATA (simulated fleet)'
      : `${server.hostCount} host(s) from ${server.paths.hostsFile}`;
  process.stdout.write(`\n  ${env.PROJECT_NAME} is running · ${fleet}\n\n    ${url}\n\n`);
  if (openBrowser && !isDevMode) openInBrowser(url);
  if (server.configErrors.length > 0) {
    process.stdout.write(`  hosts.yaml has errors:\n    ${server.configErrors.join('\n    ')}\n\n`);
  }

  const shutdown = async () => {
    await server.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

/** Opens a URL in the default browser, without waiting or failing the server. */
function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch {
    // No browser here (a server, a container): the URL is printed above.
  }
}
