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

async function main(): Promise<void> {
  loadEnvFiles();
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
