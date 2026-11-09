import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { parseServerEnv } from './config/env';
import { loadEnvFiles } from './config/env-files';
import { createApp } from './http/create-app';
import { decideBind } from './security/bind-guard';
import { createSessionToken, TOKEN_QUERY_PARAM } from './security/session-token';

/** `--dev` is passed by `npm run dev`: pretty logs, and print the Vite URL. */
const isDevMode = process.argv.includes('--dev');

async function main(): Promise<void> {
  loadEnvFiles();
  const env = parseServerEnv(process.env);

  const bind = decideBind(env.HOST, env.BIND_INSIDE_CONTAINER);
  if (!bind.allowed) throw new Error(bind.reason);

  const sessionToken = createSessionToken();
  const app = await createApp({
    projectName: env.PROJECT_NAME,
    version: packageJson.version,
    sessionToken,
    port: env.SERVER_PORT,
    // In the bundled build this file lives in apps/server/dist/.
    webDistDir: isDevMode ? undefined : fileURLToPath(new URL('../../web/dist', import.meta.url)),
    logger: {
      level: env.LOG_LEVEL,
      transport: isDevMode ? { target: 'pino-pretty' } : undefined,
    },
  });

  if (bind.warning) app.log.warn(bind.warning);

  await app.listen({ host: env.HOST, port: env.SERVER_PORT });

  // Printed straight to stdout, never through the logger, so the token does
  // not end up in log files or log shippers.
  const publicPort = isDevMode ? env.WEB_PORT : env.SERVER_PORT;
  const url = `http://127.0.0.1:${publicPort}/?${TOKEN_QUERY_PARAM}=${sessionToken}`;
  process.stdout.write(`\n  ${env.PROJECT_NAME} is running. Open:\n\n    ${url}\n\n`);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
