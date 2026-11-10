import { DEFAULT_STATUS_THRESHOLDS, type Host } from '@app/shared';
import { existsSync, statSync, unwatchFile, watchFile } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { projectSlug, resolveAppPaths, type AppPaths } from './config/app-paths';
import type { ServerEnv } from './config/env';
import { loadHostsFile, type HostsConfig } from './config/hosts-file';
import { addHostToFile } from './config/hosts-writer';
import { importSshConfig } from './config/ssh-config-importer';
import { DemoFleetProvider } from './fleet/demo-fleet-provider';
import type { FleetProvider } from './fleet/fleet-provider';
import { RealFleet } from './fleet/real-fleet';
import { StateHub } from './fleet/state-hub';
import { registerApiRoutes } from './http/api-routes';
import { registerConnectRoutes } from './http/connect-routes';
import { createApp } from './http/create-app';
import { registerStateSocket } from './http/state-socket';
import { registerTerminalSocket } from './http/terminal-socket';
import { buildAllowedOrigins } from './security/origin';
import { buildAuthOptions, defaultAgentSocket } from './ssh/auth-options';
import { HostConnection } from './ssh/host-connection';
import { readKnownHostsFiles } from './ssh/known-hosts-files';
import { testConnection } from './ssh/test-connection';
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
              sshDir: paths.sshDir,
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

  // Live reload: editing hosts.yaml swaps the fleet without a restart.
  // `lastLoadedMtime` lets the app's own writes (add/import) reload at once
  // without the file watcher reloading the same content a second time.
  let lastLoadedMtime = existsSync(paths.hostsFile) ? statSync(paths.hostsFile).mtimeMs : 0;
  const reloadHosts = async () => {
    if (env.DATA_MODE !== 'real') return;
    lastLoadedMtime = existsSync(paths.hostsFile) ? statSync(paths.hostsFile).mtimeMs : 0;
    const loaded = await loadHostsFile(paths.hostsFile);
    if (loaded.ok) {
      hub.replaceProvider(createRealFleet(loaded.config));
      hub.setConfigErrors([]);
    } else {
      hub.setConfigErrors(loaded.errors); // keep the last valid fleet running
    }
  };
  if (env.DATA_MODE === 'real') {
    watchFile(paths.hostsFile, { interval: HOSTS_FILE_POLL_MS }, (current) => {
      if (current.mtimeMs !== lastLoadedMtime) void reloadHosts();
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
      // In Docker the real path is inside the container; compose provides the host-side hint.
      ...(env.DATA_MODE === 'real'
        ? { hostsFile: process.env.HOSTS_FILE_HINT ?? paths.hostsFile }
        : {}),
    }),
    registerRoutes: async (instance) => {
      await registerStateSocket(instance, hub);
      await registerTerminalSocket(instance, {
        audit,
        resolve: (hostId) => {
          const current = hub.currentProvider;
          if (!(current instanceof RealFleet)) {
            return {
              kind: 'unavailable',
              message: 'Demo data: there is no real host to open a terminal on.',
            };
          }
          const connection = current.connectionFor(hostId);
          return connection
            ? { kind: 'connection', connection }
            : { kind: 'unavailable', message: `Unknown host "${hostId}".` };
        },
      });
      registerConnectRoutes(instance, {
        sshDir: paths.sshDir,
        knownHostsFile: paths.knownHostsFiles[0] ?? 'known_hosts',
        loadKnownHosts: () => readKnownHostsFiles(paths.knownHostsFiles),
        agentSocket: defaultAgentSocket(process.env, process.platform),
        keyBaseName: `${projectSlug(env.PROJECT_NAME)}_ed25519`,
        keyComment: `${projectSlug(env.PROJECT_NAME)}@${hostname()}`,
        defaultUser: userInfo().username,
        audit,
      });
      registerApiRoutes(instance, {
        audit,
        defaultUser: userInfo().username,
        demoMode: env.DATA_MODE === 'demo',
        addHost: async (host) => {
          const saved = await addHostToFile(paths.hostsFile, host);
          await reloadHosts(); // the new tower appears immediately
          return saved;
        },
        testConnection: (host) =>
          testConnection(host, {
            loadKnownHosts: () => readKnownHostsFiles(paths.knownHostsFiles),
            buildAuth: (target) =>
              buildAuthOptions(target.auth, {
                env: process.env,
                platform: process.platform,
                homeDir,
                sshDir: paths.sshDir,
              }),
          }),
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
