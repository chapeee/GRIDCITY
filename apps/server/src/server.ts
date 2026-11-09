import { DEFAULT_STATUS_THRESHOLDS, type Host } from '@app/shared';
import { unwatchFile, watchFile } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { resolveAppPaths, type AppPaths } from './config/app-paths';
import type { ServerEnv } from './config/env';
import { loadHostsFile, type HostsConfig } from './config/hosts-file';
import { importSshConfig } from './config/ssh-config-importer';
import { DemoFleetProvider } from './fleet/demo-fleet-provider';
import type { FleetProvider } from './fleet/fleet-provider';
import { RealFleet } from './fleet/real-fleet';
import { StateHub } from './fleet/state-hub';
import { registerApiRoutes } from './http/api-routes';
import { createApp } from './http/create-app';
import { registerStateSocket } from './http/state-socket';
import { buildAllowedOrigins } from './security/origin';
import { buildAuthOptions } from './ssh/auth-options';
import { HostConnection } from './ssh/host-connection';
import { readKnownHostsFiles } from './ssh/known-hosts-files';
import { AuditLog } from './storage/audit-log';
import { openDatabase } from './storage/database';
import { LayoutStore } from './storage/layout-store';
import { SampleHistory } from './storage/sample-history';

/** How often hosts.yaml is checked for changes (polling works on every platform and in Docker). */
const HOSTS_FILE_POLL_MS = 2000;

export interface StartServerOptions {
  env: ServerEnv;
  sessionToken: string;
  devMode: boolean;
}

export interface RunningServer {
  paths: AppPaths;
  hostCount: number;
  configErrors: string[];
  stop(): Promise<void>;
}

/** Assembles storage, fleet, state hub and HTTP app, and starts listening. */
export async function startServer({
  env,
  sessionToken,
  devMode,
}: StartServerOptions): Promise<RunningServer> {
  const homeDir = homedir();
  const paths = resolveAppPaths({
    projectName: env.PROJECT_NAME,
    env: process.env,
    platform: process.platform,
    homeDir,
  });

  const db = openDatabase(paths.databaseFile);
  const audit = new AuditLog(db);
  const history = new SampleHistory(db);

  const createRealFleet = (config: HostsConfig): RealFleet =>
    new RealFleet({
      hosts: config.hosts,
      thresholds: config.thresholds,
      audit,
      createConnection: (host: Host, onPhaseChange) =>
        new HostConnection({
          host,
          onPhaseChange,
          loadKnownHosts: () => readKnownHostsFiles(paths.knownHostsFiles),
          buildAuth: (target) =>
            buildAuthOptions(target.auth, {
              env: process.env,
              platform: process.platform,
              homeDir,
            }),
        }),
    });

  let configErrors: string[] = [];
  let provider: FleetProvider;
  if (env.DATA_MODE === 'demo') {
    provider = new DemoFleetProvider();
  } else {
    const loaded = await loadHostsFile(paths.hostsFile);
    configErrors = loaded.ok ? [] : loaded.errors;
    // An invalid file starts an empty fleet and the errors are shown to the user.
    provider = createRealFleet(
      loaded.ok ? loaded.config : { hosts: [], thresholds: DEFAULT_STATUS_THRESHOLDS },
    );
  }

  const hub = new StateHub({
    provider,
    projectName: env.PROJECT_NAME,
    layoutStore: new LayoutStore(db),
    history,
  });
  hub.setConfigErrors(configErrors);
  hub.start();

  // Live reload: editing hosts.yaml (or importing) swaps the fleet without a restart.
  if (env.DATA_MODE === 'real') {
    watchFile(paths.hostsFile, { interval: HOSTS_FILE_POLL_MS }, async (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs) return;
      const loaded = await loadHostsFile(paths.hostsFile);
      if (loaded.ok) {
        hub.replaceProvider(createRealFleet(loaded.config));
        hub.setConfigErrors([]);
      } else {
        hub.setConfigErrors(loaded.errors); // keep the last valid fleet running
      }
    });
  }

  const app = await createApp({
    projectName: env.PROJECT_NAME,
    version: packageJson.version,
    sessionToken,
    port: env.SERVER_PORT,
    allowedOrigins: buildAllowedOrigins([env.SERVER_PORT, env.WEB_PORT]),
    // In the bundled build this file lives in apps/server/dist/.
    webDistDir: devMode ? undefined : fileURLToPath(new URL('../../web/dist', import.meta.url)),
    logger: { level: env.LOG_LEVEL, transport: devMode ? { target: 'pino-pretty' } : undefined },
    describe: () => ({
      dataMode: env.DATA_MODE,
      ...(env.DATA_MODE === 'real' ? { hostsFile: paths.hostsFile } : {}),
    }),
    registerRoutes: async (instance) => {
      await registerStateSocket(instance, hub);
      registerApiRoutes(instance, {
        audit,
        importSshConfig: () =>
          importSshConfig({
            sshConfigFile: paths.sshConfigFile,
            hostsFile: paths.hostsFile,
            defaultUser: userInfo().username,
          }),
      });
    },
  });

  await app.listen({ host: env.HOST, port: env.SERVER_PORT });
  audit.append('server_started', null, `${provider.dataMode} mode, ${provider.hosts.length} hosts`);

  return {
    paths,
    hostCount: provider.hosts.length,
    configErrors,
    async stop() {
      unwatchFile(paths.hostsFile);
      hub.stop();
      await app.close();
      audit.append('server_stopped');
      db.close();
    },
  };
}
