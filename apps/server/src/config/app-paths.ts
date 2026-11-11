import path from 'node:path';

/** Where the app keeps its files. Every directory name comes from PROJECT_NAME. */
export interface AppPaths {
  /** Holds hosts.yaml. */
  configDir: string;
  /** Holds the SQLite database. */
  dataDir: string;
  hostsFile: string;
  resourcesFile: string;
  /** Optional descriptions of districts (provider, region). */
  districtsFile: string;
  /** Saved commands (runbooks). */
  runbooksFile: string;
  databaseFile: string;
  /** The user's SSH directory (keys, known_hosts). Overridable for Docker. */
  sshDir: string;
  /**
   * known_hosts files to verify host keys against, user file first. The app
   * only writes to the first one, and only when the user confirms a
   * fingerprint in the "Connect a server" flow.
   */
  knownHostsFiles: string[];
  /** OpenSSH client config used by the importer. */
  sshConfigFile: string;
}

export interface PathContext {
  projectName: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homeDir: string;
}

/** "My Grid City!" -> "my-grid-city". Used as the directory name. */
export function projectSlug(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug)
    throw new Error(`PROJECT_NAME "${projectName}" has no usable characters for a directory name.`);
  return slug;
}

/**
 * Resolves platform-conventional locations (overridable for Docker and tests):
 * - config: CONFIG_DIR, else %APPDATA%\<slug> on Windows, else $XDG_CONFIG_HOME/<slug> or ~/.config/<slug>
 * - data:   DATA_DIR, else %LOCALAPPDATA%\<slug> on Windows, else $XDG_DATA_HOME/<slug> or ~/.local/share/<slug>
 */
export function resolveAppPaths({ projectName, env, platform, homeDir }: PathContext): AppPaths {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const slug = projectSlug(projectName);
  const isWindows = platform === 'win32';

  const configDir =
    env.CONFIG_DIR ??
    (isWindows
      ? p.join(env.APPDATA ?? p.join(homeDir, 'AppData', 'Roaming'), slug)
      : p.join(env.XDG_CONFIG_HOME ?? p.join(homeDir, '.config'), slug));

  const dataDir =
    env.DATA_DIR ??
    (isWindows
      ? p.join(env.LOCALAPPDATA ?? p.join(homeDir, 'AppData', 'Local'), slug)
      : p.join(env.XDG_DATA_HOME ?? p.join(homeDir, '.local', 'share'), slug));

  const sshDir = env.SSH_DIR ?? p.join(homeDir, '.ssh');

  const systemKnownHosts = isWindows
    ? p.join(env.PROGRAMDATA ?? 'C:\\ProgramData', 'ssh', 'ssh_known_hosts')
    : '/etc/ssh/ssh_known_hosts';

  return {
    configDir,
    dataDir,
    hostsFile: p.join(configDir, 'hosts.yaml'),
    resourcesFile: p.join(configDir, 'resources.yaml'),
    districtsFile: p.join(configDir, 'districts.yaml'),
    runbooksFile: p.join(configDir, 'runbooks.yaml'),
    databaseFile: p.join(dataDir, 'state.db'),
    sshDir,
    knownHostsFiles: env.KNOWN_HOSTS_FILE
      ? [env.KNOWN_HOSTS_FILE]
      : [p.join(sshDir, 'known_hosts'), systemKnownHosts],
    sshConfigFile: env.SSH_CONFIG_FILE ?? p.join(sshDir, 'config'),
  };
}

/** Expands a leading `~` to the home directory. */
export function expandHome(filePath: string, homeDir: string): string {
  if (filePath === '~') return homeDir;
  if (filePath.startsWith('~/') || filePath.startsWith('~\\'))
    return path.join(homeDir, filePath.slice(2));
  return filePath;
}
