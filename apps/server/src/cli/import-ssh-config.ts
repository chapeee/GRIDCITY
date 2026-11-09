import { homedir, userInfo } from 'node:os';
import { resolveAppPaths } from '../config/app-paths';
import { parseServerEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { importSshConfig } from '../config/ssh-config-importer';

/**
 * `npm run import-ssh-config`: adds the concrete hosts from ~/.ssh/config to
 * hosts.yaml. Safe to run repeatedly; existing hosts are left alone. A
 * running server picks the change up automatically.
 */
async function main(): Promise<void> {
  loadEnvFiles();
  const env = parseServerEnv(process.env);
  const paths = resolveAppPaths({
    projectName: env.PROJECT_NAME,
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
  });

  const report = await importSshConfig({
    sshConfigFile: paths.sshConfigFile,
    hostsFile: paths.hostsFile,
    defaultUser: userInfo().username,
  });

  const lines = [
    `Imported ${report.added.length} host(s) into ${report.hostsFile}`,
    ...report.added.map((id) => `  + ${id}`),
    ...report.skipped.map((skip) => `  = ${skip.alias}: ${skip.reason}`),
    ...report.warnings.map((warning) => `  ! ${warning}`),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
