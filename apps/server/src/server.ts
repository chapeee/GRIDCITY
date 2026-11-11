import { lookup } from 'node:dns/promises';
import {
  createDemoLinks,
  createDemoReplayFrame,
  DEMO_DISTRICTS,
  type ReplayFrame,
  createDemoHistory,
  DEFAULT_RESOURCE_THRESHOLDS,
  DEFAULT_STATUS_THRESHOLDS,
  type DoctorReport,
  type Host,
} from '@app/shared';
import { existsSync, statSync, unwatchFile, watchFile } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import packageJson from '../package.json' with { type: 'json' };
import { AcpBridge } from './agent/acp-bridge';
import { AGENT_DEFINITIONS, agentChoices } from './agent/agent-catalog';
import { AgentHub, registerAgentRoutes } from './agent/agent-hub';
import { ApprovalGate } from './agent/approvals';
import { FleetTools, type FleetAccess } from './agent/fleet-tools';
import { MCP_PATH, registerMcpEndpoint } from './agent/mcp-endpoint';
import { projectSlug, resolveAppPaths, type AppPaths } from './config/app-paths';
import type { ServerEnv } from './config/env';
import { loadHostsFile, type HostsConfig } from './config/hosts-file';
import { addHostToFile } from './config/hosts-writer';
import { editHostInFile, removeHostFromFile, setFileThresholds } from './config/hosts-editor';
import { importSshConfig } from './config/ssh-config-importer';
import { loadDistrictsFile } from './config/districts-file';
import { loadRunbooksFile } from './config/runbooks-file';
import { createWebhookNotifier, sendTestAlert } from './alerts/webhook';
import { loadVaultKey, SecretVault } from './storage/secret-vault';

/** Vault id of the alert webhook URL (it carries a token, so it is a secret). */
const WEBHOOK_SECRET_ID = 'alerts.webhook';
import { registerRunbookRoutes } from './http/runbook-routes';
import { registerDoctorRoutes } from './http/doctor-routes';
import { diagnoseResource } from './doctor/doctor';
import { diagnoseHost } from './doctor/ssh';
import { registerResourceRoutes, testResource } from './http/resource-routes';
import { runningInContainer } from './doctor/ladder';
import { listLocalKeys } from './ssh/local-keys';
import { loadResourcesFile, type ResourcesConfig } from './config/resources-file';
import { createConnector, type ConnectorContext } from './connectors';
import { DemoFleetProvider } from './fleet/demo-fleet-provider';
import { DemoResourceProvider, ResourceFleet, type ResourceProvider } from './fleet/resource-fleet';
import type { FleetProvider } from './fleet/fleet-provider';
import { RealFleet } from './fleet/real-fleet';
import { StateHub } from './fleet/state-hub';
import { registerApiRoutes } from './http/api-routes';
import { registerConnectRoutes } from './http/connect-routes';
import { registerManageRoutes } from './http/manage-routes';
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
import { AppSettingsStore } from './storage/app-settings';
import { StatusEvents } from './storage/status-events';

/** How often hosts.yaml is checked for changes (polling works on every platform and in Docker). */
const HOSTS_FILE_POLL_MS = 2000;
const DAY_MS = 86_400_000;
/** Old history rows are deleted this often (and whenever retention changes). */
const HISTORY_PRUNE_MS = 60 * 60_000;

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
  // History: metric buckets and status transitions, kept for the retention set in Settings.
  const appSettings = new AppSettingsStore(db);
  // Credentials typed in the app (database passwords, access keys, the alert webhook):
  // AES-256-GCM in the database, key in DATA_DIR/vault.key (or SECRETS_KEY).
  const vault = new SecretVault(
    db,
    loadVaultKey(join(paths.dataDir, 'vault.key'), process.env.SECRETS_KEY),
  );
  const retentionMs = () => appSettings.load().historyRetentionDays * DAY_MS;
  const history = new SampleHistory(db, { bucketMs: 30_000, retentionMs: retentionMs() });
  // Demo and real data never mix: demo incidents are generated, never recorded.
  const statusEvents = env.DATA_MODE === 'real' ? new StatusEvents(db) : undefined;
  const pruneHistory = () => {
    const now = Date.now();
    history.setRetention(retentionMs(), now);
    statusEvents?.prune(now - retentionMs());
  };
  pruneHistory();
  const pruneTimer = setInterval(pruneHistory, HISTORY_PRUNE_MS);

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

  // Databases, RDS and object storage (resources.yaml). Same truth rules as hosts.
  const connectorContext: ConnectorContext = {
    env: process.env,
    secrets: vault,
    homeDir,
    appName: env.PROJECT_NAME,
    now: Date.now,
  };
  const buildResources = (
    config: ResourcesConfig,
    hostIds: ReadonlySet<string>,
  ): { provider: ResourceProvider; errors: string[] } => {
    const errors: string[] = [];
    const configs = config.resources.filter((resource) => {
      if (!hostIds.has(resource.id)) return true;
      errors.push(`resources: id "${resource.id}" is already used by a host in hosts.yaml`);
      return false;
    });
    return {
      provider: new ResourceFleet({
        configs,
        thresholds: config.thresholds,
        audit,
        createConnector: (resource) => createConnector(resource, connectorContext),
      }),
      errors,
    };
  };
  let resourceProvider: ResourceProvider;
  let resourceErrors: string[] = [];
  if (env.DATA_MODE === 'demo') {
    resourceProvider = new DemoResourceProvider();
  } else {
    const loaded = await loadResourcesFile(paths.resourcesFile);
    const built = buildResources(
      loaded.ok ? loaded.config : { resources: [], thresholds: DEFAULT_RESOURCE_THRESHOLDS },
      new Set(provider.hosts.map((host) => host.id)),
    );
    resourceProvider = built.provider;
    resourceErrors = loaded.ok ? built.errors : loaded.errors;
  }

  // Districts (provider, region) and runbooks (saved commands), both optional files.
  // In demo mode the districts come with the demo city; runbooks are still yours.
  const loadDeclarations = async () => {
    const [districts, runbooks] = await Promise.all([
      env.DATA_MODE === 'demo'
        ? Promise.resolve({ ok: true as const, districts: DEMO_DISTRICTS })
        : loadDistrictsFile(paths.districtsFile),
      loadRunbooksFile(paths.runbooksFile),
    ]);
    const errors = [
      ...(districts.ok ? [] : [`districts.yaml has errors:\n${districts.errors.join('\n')}`]),
      ...(runbooks.ok ? [] : [`runbooks.yaml has errors:\n${runbooks.errors.join('\n')}`]),
    ];
    return {
      districts: districts.ok ? districts.districts : [],
      runbooks: runbooks.ok ? runbooks.runbooks : [],
      errors,
    };
  };
  const declarations = await loadDeclarations();

  // Alerts: an optional webhook gets every real transition into or out of trouble.
  // The webhook is set in Settings (saved in the vault); ALERT_WEBHOOK_URL still works.
  let notifierFor: { url: string; notifier: ReturnType<typeof createWebhookNotifier> } | null =
    null;
  const webhookUrl = () => vault.get(WEBHOOK_SECRET_ID) ?? env.ALERT_WEBHOOK_URL ?? null;
  const currentNotifier = () => {
    const url = env.DATA_MODE === 'real' ? webhookUrl() : null;
    if (!url) return null;
    if (notifierFor?.url !== url) {
      notifierFor = {
        url,
        notifier: createWebhookNotifier({
          url,
          projectName: env.PROJECT_NAME,
          log: (message) => console.warn(message),
        }),
      };
    }
    return notifierFor.notifier;
  };

  const hub = new StateHub({
    provider,
    resources: resourceProvider,
    projectName: env.PROJECT_NAME,
    layoutStore: new LayoutStore(db),
    history,
    statusEvents,
    districts: declarations.districts,
    runbooks: declarations.runbooks,
    fixedLinks: env.DATA_MODE === 'demo' ? (now) => createDemoLinks(now) : undefined,
    resolve:
      env.DATA_MODE === 'real'
        ? (hostname) => lookup(hostname, { all: true }).then((all) => all.map((a) => a.address))
        : undefined,
    onTransition: (event) => {
      if (currentNotifier()?.notify(event)) {
        audit.append('alert_sent', event.targetId, `${event.from ?? '?'} → ${event.to}`);
      }
    },
  });
  hub.setConfigErrors(configErrors);
  hub.setResourceConfigErrors(resourceErrors);
  hub.setOtherConfigErrors(declarations.errors);
  hub.start();

  let lastResourcesMtime = existsSync(paths.resourcesFile)
    ? statSync(paths.resourcesFile).mtimeMs
    : 0;
  const reloadResources = async () => {
    if (env.DATA_MODE !== 'real') return;
    lastResourcesMtime = existsSync(paths.resourcesFile)
      ? statSync(paths.resourcesFile).mtimeMs
      : 0;
    const loaded = await loadResourcesFile(paths.resourcesFile);
    if (loaded.ok) {
      const built = buildResources(
        loaded.config,
        new Set(hub.currentProvider.hosts.map((host) => host.id)),
      );
      hub.replaceResources(built.provider);
      hub.setResourceConfigErrors(built.errors);
    } else {
      hub.setResourceConfigErrors(loaded.errors); // keep the last valid resources running
    }
  };
  if (env.DATA_MODE === 'real') {
    // districts.yaml and runbooks.yaml reload live too (runbooks in demo mode as well).
    const reloadDeclarations = async () => {
      const next = await loadDeclarations();
      hub.replaceDeclarations({ districts: next.districts, runbooks: next.runbooks });
      hub.setOtherConfigErrors(next.errors);
    };
    for (const file of [paths.districtsFile, paths.runbooksFile]) {
      watchFile(file, { interval: HOSTS_FILE_POLL_MS }, () => void reloadDeclarations());
    }
    watchFile(paths.resourcesFile, { interval: HOSTS_FILE_POLL_MS }, (current) => {
      if (current.mtimeMs !== lastResourcesMtime) void reloadResources();
    });
  }

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

  // AI agents: MCP clients (Claude Code...) and ACP agents (Codex, Gemini...)
  // share these tools, so every command they run waits for the user's approval.
  const realFleet = () => (hub.currentProvider instanceof RealFleet ? hub.currentProvider : null);
  // The Doctor for one server or resource (AI tools; the HTTP routes have their own wiring).
  const doctorFor = async (id: string): Promise<DoctorReport | null> => {
    const host = hub.currentProvider.hosts.find((h) => h.id === id);
    if (host) {
      return diagnoseHost(host, {
        test: () =>
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
      });
    }
    const resource = hub.currentResources.resources().find((r) => r.id === id || r.sourceId === id);
    if (!resource) return null;
    const loaded = await loadResourcesFile(paths.resourcesFile);
    const config = loaded.ok
      ? loaded.config.resources.find((r) => r.id === resource.sourceId)
      : undefined;
    if (!config) return null;
    return diagnoseResource(config, {
      test: async (candidate) => {
        const result = await testResource(candidate, {}, connectorContext);
        return {
          ok: result.ok,
          error: result.error ?? result.found.find((f) => !f.ok)?.error ?? null,
        };
      },
    });
  };
  const fleetAccess: FleetAccess = {
    hosts: () => hub.currentProvider.hosts,
    states: () => hub.currentProvider.currentStates(Date.now()),
    isConnected: (hostId) => realFleet()?.connectionFor(hostId)?.phase === 'connected',
    exec: (hostId, command, timeoutMs, stdin = '') => {
      const connection = realFleet()?.connectionFor(hostId);
      if (!connection) return Promise.reject(new Error('not connected'));
      return connection.exec(command, stdin, timeoutMs);
    },
    resources: () => hub.currentResources.resources(),
    resourceStates: () => hub.currentResources.currentStates(Date.now()),
    demoMode: () => realFleet() === null,
    links: () => hub.currentLinks,
    districts: () => hub.currentDistricts,
    runbooks: () => hub.currentRunbooks,
    diagnose: (id) => doctorFor(id),
  };
  const gate = new ApprovalGate();
  const fleetTools = new FleetTools({ fleet: fleetAccess, gate, audit });
  const mcpName = projectSlug(env.PROJECT_NAME);
  const agentHub = new AgentHub({
    gate,
    tools: fleetTools,
    agents: agentChoices(AGENT_DEFINITIONS, process.env),
    bridge: new AcpBridge({
      definitions: AGENT_DEFINITIONS,
      mcp: {
        name: mcpName,
        url: `http://127.0.0.1:${env.SERVER_PORT}${MCP_PATH}`,
        token: sessionToken,
      },
      workspaceDir: join(paths.dataDir, 'agent-workspace'),
      appName: env.PROJECT_NAME,
      version: packageJson.version,
      audit,
    }),
  });

  const app = await createApp({
    projectName: env.PROJECT_NAME,
    version: packageJson.version,
    sessionToken,
    port: env.SERVER_PORT,
    allowedOrigins: buildAllowedOrigins([env.SERVER_PORT, env.WEB_PORT]),
    programPaths: [MCP_PATH],
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
      registerMcpEndpoint(instance, {
        tools: fleetTools,
        serverName: mcpName,
        appName: env.PROJECT_NAME,
        version: packageJson.version,
      });
      await registerAgentRoutes(instance, {
        hub: agentHub,
        mcp: { name: mcpName, port: env.SERVER_PORT, token: sessionToken },
      });
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
      registerRunbookRoutes(instance, {
        audit,
        demoMode: env.DATA_MODE === 'demo',
        hosts: () => hub.currentProvider.hosts,
        runbooks: () => hub.currentRunbooks,
        runner: {
          isConnected: (hostId) => fleetAccess.isConnected(hostId),
          exec: (hostId, command, timeoutMs) => fleetAccess.exec(hostId, command, timeoutMs),
        },
      });
      const hostTest = (host: Host) =>
        testConnection(host, {
          loadKnownHosts: () => readKnownHostsFiles(paths.knownHostsFiles),
          buildAuth: (target) =>
            buildAuthOptions(target.auth, {
              env: process.env,
              platform: process.platform,
              homeDir,
              sshDir: paths.sshDir,
            }),
        });
      registerDoctorRoutes(instance, {
        audit,
        demoMode: env.DATA_MODE === 'demo',
        resourcesFile: paths.resourcesFile,
        context: connectorContext,
        hosts: () => hub.currentProvider.hosts,
        testHost: hostTest,
        entryIdOf: (id) =>
          hub.currentResources.resources().find((r) => r.id === id || r.sourceId === id)
            ?.sourceId ?? null,
        reload: reloadResources,
        troubles: () => {
          const now = Date.now();
          const hosts = hub.currentProvider.hosts;
          const resources = hub.currentResources.resources();
          return [
            ...hub.currentProvider.currentStates(now).map((s) => ({
              id: s.hostId,
              name: hosts.find((h) => h.id === s.hostId)?.name ?? s.hostId,
              kind: 'server',
              status: s.stale ? 'stale' : s.status,
              hint: s.hint ?? null,
              reason: s.statusReason,
            })),
            ...hub.currentResources.currentStates(now).map((s) => ({
              id: s.resourceId,
              name: resources.find((r) => r.id === s.resourceId)?.name ?? s.resourceId,
              kind: resources.find((r) => r.id === s.resourceId)?.engine ?? 'resource',
              status: s.stale ? 'stale' : s.status,
              hint: s.hint ?? null,
              reason: s.statusReason,
            })),
          ].filter((t) => t.status !== 'online');
        },
        environment: async () => {
          const socket = defaultAgentSocket(process.env, process.platform);
          const agentSocket = socket && existsSync(socket) ? socket : null;
          const keys = agentSocket
            ? await listLocalKeys({ sshDir: paths.sshDir, agentSocket })
            : [];
          const hosts = hub.currentProvider.hosts;
          return {
            platform: process.platform,
            nodeVersion: process.version,
            dataDir: paths.dataDir,
            inContainer: runningInContainer(),
            agentSocket,
            agentKeyCount: agentSocket ? keys.filter((k) => k.source === 'agent').length : null,
            knownHostsFile: paths.knownHostsFiles[0] ?? '',
            hostCount: env.DATA_MODE === 'real' ? hosts.length : 0,
            configErrors: [],
            localhostTargets: [
              ...hosts.filter((h) => /^(localhost|127\.|::1)/.test(h.address)).map((h) => h.name),
              ...hub.currentResources
                .resources()
                .filter((r) => /(^|\/\/|@)(localhost|127\.0\.0\.1)/.test(r.target))
                .map((r) => r.name),
            ],
          };
        },
      });
      registerResourceRoutes(instance, {
        audit,
        secrets: vault,
        demoMode: env.DATA_MODE === 'demo',
        resourcesFile: paths.resourcesFile,
        context: connectorContext,
        hostIds: () => new Set(hub.currentProvider.hosts.map((host) => host.id)),
        reload: reloadResources, // the new building appears at once
      });
      registerManageRoutes(instance, {
        audit,
        replayOldest: () => (env.DATA_MODE === 'demo' ? null : history.oldest()),
        replayFrame: (at) => {
          const hostIds = hub.currentProvider.hosts.map((host) => host.id);
          const resourceIds = hub.currentResources.resources().map((resource) => resource.id);
          // Demo data has no recorded past: its replay is generated (and labelled DEMO DATA).
          if (env.DATA_MODE === 'demo' || !statusEvents) {
            return createDemoReplayFrame(hostIds, resourceIds, at, Date.now());
          }
          history.writeOpen();
          const samples = history.frameAt(at);
          const statuses = statusEvents.statusAt(at);
          const hosts: ReplayFrame['hosts'] = {};
          for (const id of hostIds) {
            const sample = samples.get(id);
            const status = statuses.get(id);
            if (!sample && !status) continue; // not measured then: shown as unknown
            hosts[id] = {
              status: status?.status ?? 'online',
              reason: status?.reason ?? null,
              cpuPercent: sample?.cpuPercent ?? null,
              memoryPercent: sample?.memoryPercent ?? null,
              maxDiskPercent: sample?.maxDiskPercent ?? null,
              networkBytesPerSec: sample?.networkBytesPerSec ?? null,
              loadOne: sample?.loadOne ?? null,
            };
          }
          const resources: ReplayFrame['resources'] = {};
          for (const id of resourceIds) {
            const status = statuses.get(id);
            if (status) resources[id] = status;
          }
          return { at, hosts, resources };
        },
        alerts: {
          configured: () => webhookUrl() !== null,
          fromEnvironment: () => !vault.has(WEBHOOK_SECRET_ID) && Boolean(env.ALERT_WEBHOOK_URL),
          setWebhook: (url) =>
            url ? vault.set(WEBHOOK_SECRET_ID, url) : vault.delete(WEBHOOK_SECRET_ID),
          sendTest: async () => {
            const url = webhookUrl();
            if (!url) throw new Error('No webhook is set.');
            await sendTestAlert(url, env.PROJECT_NAME);
          },
        },
        demoMode: env.DATA_MODE === 'demo',
        hostsFile: env.DATA_MODE === 'real' ? paths.hostsFile : undefined,
        knownTargets: () =>
          new Set([
            ...hub.currentProvider.hosts.map((host) => host.id),
            ...hub.currentResources.resources().map((resource) => resource.id),
          ]),
        samples: (targetId, since) => {
          history.writeOpen(); // include the bucket still being filled
          return history.query(targetId, since);
        },
        incidents: (targetId, since, until) =>
          statusEvents
            ? statusEvents.incidents(targetId, since, until)
            : createDemoHistory(
                [...hub.currentProvider.hosts.map((host) => host.id)],
                targetId,
                until,
                Math.ceil((until - since) / DAY_MS),
              ).incidents,
        loadSettings: () => appSettings.load(),
        saveSettings: (settings) => {
          const saved = appSettings.save(settings);
          pruneHistory();
          return saved;
        },
        currentThresholds: () => hub.currentProvider.thresholds,
        setThresholds: async (thresholds) => {
          const saved = await setFileThresholds(paths.hostsFile, thresholds);
          await reloadHosts();
          return saved;
        },
        editHost: async (id, patch) => {
          await editHostInFile(paths.hostsFile, id, patch);
          await reloadHosts(); // the new name, district or thresholds show at once
        },
        removeHost: async (id) => {
          await removeHostFromFile(paths.hostsFile, id);
          await reloadHosts();
        },
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
      clearInterval(pruneTimer);
      unwatchFile(paths.hostsFile);
      unwatchFile(paths.resourcesFile);
      unwatchFile(paths.districtsFile);
      unwatchFile(paths.runbooksFile);
      agentHub.close();
      hub.stop();
      await app.close();
      audit.append('server_stopped');
      db.close();
    },
  };
}
