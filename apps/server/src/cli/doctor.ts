import type { Diagnosis, DoctorReport } from '@app/shared';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveAppPaths } from '../config/app-paths';
import { parseServerEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { loadHostsFile } from '../config/hosts-file';
import { loadResourcesFile } from '../config/resources-file';
import { diagnoseResource } from '../doctor/doctor';
import { environmentDiagnoses } from '../doctor/environment';
import { runningInContainer } from '../doctor/ladder';
import { diagnoseHost } from '../doctor/ssh';
import { testResource } from '../http/resource-routes';
import { buildAuthOptions, defaultAgentSocket } from '../ssh/auth-options';
import { readKnownHostsFiles } from '../ssh/known-hosts-files';
import { listLocalKeys } from '../ssh/local-keys';
import { testConnection } from '../ssh/test-connection';
import { openDatabase } from '../storage/database';
import { loadVaultKey, SecretVault } from '../storage/secret-vault';

const USAGE = `Check this machine and every server and resource, without starting the app.

  gridcity doctor            readable report
  gridcity doctor --json     machine-readable (for CI and AI agents)
  gridcity doctor --only orders-db,web-01

For each target that does not connect, the Doctor finds where it breaks
(DNS, port, TLS, login), explains why, and tests candidate fixes with real
read-only connections. Nothing is changed: apply a proven fix in the app.
Exit code 0 when everything connects, 1 when something needs attention.`;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t: string) => paint(32, t);
const amber = (t: string) => paint(33, t);
const red = (t: string) => paint(31, t);
const dim = (t: string) => paint(2, t);
const bold = (t: string) => paint(1, t);

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      json: { type: 'boolean', default: false },
      only: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  loadEnvFiles();
  process.env.PROJECT_NAME ??= 'GRIDCITY';
  const env = parseServerEnv(process.env);
  const homeDir = homedir();
  const paths = resolveAppPaths({
    projectName: env.PROJECT_NAME,
    env: process.env,
    platform: process.platform,
    homeDir,
  });
  const only = values.only ? new Set(values.only.split(',').map((id) => id.trim())) : null;

  // Saved credentials, read-only (the vault is only opened if the app made one).
  const vaultKeyFile = join(paths.dataDir, 'vault.key');
  const secrets =
    existsSync(paths.databaseFile) && (existsSync(vaultKeyFile) || process.env.SECRETS_KEY)
      ? new SecretVault(
          openDatabase(paths.databaseFile),
          loadVaultKey(vaultKeyFile, process.env.SECRETS_KEY),
        )
      : undefined;
  const context = { env: process.env, homeDir, appName: env.PROJECT_NAME, now: Date.now, secrets };

  const hostsFile = await loadHostsFile(paths.hostsFile);
  const resourcesFile = await loadResourcesFile(paths.resourcesFile);
  const hosts = hostsFile.ok ? hostsFile.config.hosts : [];
  const resources = resourcesFile.ok ? resourcesFile.config.resources : [];

  const socket = defaultAgentSocket(process.env, process.platform);
  const agentSocket = socket && existsSync(socket) ? socket : null;
  const keys = agentSocket ? await listLocalKeys({ sshDir: paths.sshDir, agentSocket }) : [];
  const environment: Diagnosis[] = environmentDiagnoses({
    platform: process.platform,
    nodeVersion: process.version,
    dataDir: existsSync(paths.dataDir) ? paths.dataDir : homeDir,
    inContainer: runningInContainer(),
    agentSocket,
    agentKeyCount: agentSocket ? keys.filter((key) => key.source === 'agent').length : null,
    knownHostsFile: paths.knownHostsFiles[0] ?? '',
    hostCount: hosts.length,
    configErrors: [
      ...(hostsFile.ok ? [] : [`hosts.yaml has errors\n${hostsFile.errors.join('\n')}`]),
      ...(resourcesFile.ok
        ? resourcesFile.skipped.length > 0
          ? [`resources.yaml has entries that were not loaded\n${resourcesFile.skipped.join('\n')}`]
          : []
        : [`resources.yaml has errors\n${resourcesFile.errors.join('\n')}`]),
    ],
    localhostTargets: [],
  });

  const reports: DoctorReport[] = [];
  const progress = (text: string) => {
    if (!values.json && process.stderr.isTTY) process.stderr.write(`\r${dim(text.padEnd(60))}`);
  };
  for (const host of hosts) {
    if (only && !only.has(host.id)) continue;
    progress(`checking ${host.name}…`);
    reports.push(
      await diagnoseHost(host, {
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
      }),
    );
  }
  for (const resource of resources) {
    if (only && !only.has(resource.id)) continue;
    progress(`checking ${resource.name ?? resource.id}…`);
    reports.push(
      await diagnoseResource(resource, {
        test: async (candidate) => {
          const result = await testResource(candidate, {}, context);
          return {
            ok: result.ok,
            error: result.error ?? result.found.find((f) => !f.ok)?.error ?? null,
          };
        },
      }),
    );
  }
  progress('');
  if (!values.json && process.stderr.isTTY) process.stderr.write('\r');

  const failing = reports.filter((report) => !report.ok);
  const healthy = environment.length === 0 && failing.length === 0;
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ ok: healthy, environment, reports }, null, 2)}\n`);
  } else {
    printReport(environment, reports, paths.hostsFile);
  }
  process.exitCode = healthy ? 0 : 1;
}

function printReport(environment: Diagnosis[], reports: DoctorReport[], hostsFile: string): void {
  const out = (line = '') => process.stdout.write(`${line}\n`);
  out();
  out(bold('  GRIDCITY Doctor'));
  out();
  if (environment.length === 0) out(`  ${green('✓')} this machine looks fine`);
  for (const diagnosis of environment) printDiagnosis(diagnosis, '  ');
  if (reports.length === 0) {
    out(`  ${dim(`no servers or resources yet (${hostsFile})`)}`);
  }
  for (const report of reports) {
    if (report.ok) {
      out(`  ${green('✓')} ${report.targetName}`);
      continue;
    }
    out(`  ${red('✗')} ${bold(report.targetName)}  ${dim(report.error ?? '')}`);
    const failed = report.ladder.find((step) => step.status === 'failed');
    if (failed) out(`      ${dim(`stops at ${failed.step.toUpperCase()}: ${failed.detail}`)}`);
    for (const diagnosis of report.diagnoses.slice(0, 2)) printDiagnosis(diagnosis, '      ');
  }
  const bad = reports.filter((r) => !r.ok).length + environment.length;
  out();
  out(
    bad === 0
      ? `  ${green('All good.')}`
      : `  ${amber(`${bad} thing${bad === 1 ? ' needs' : 's need'} attention.`)} Open the app and press D to apply proven fixes.`,
  );
  out();
}

function printDiagnosis(diagnosis: Diagnosis, indent: string): void {
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(`${indent}${amber('→')} ${diagnosis.title} ${dim(`(${diagnosis.confidence})`)}`);
  for (const fix of diagnosis.fixes.slice(0, 3)) {
    const mark =
      fix.verified === 'works'
        ? green('proven')
        : fix.verified === 'fails'
          ? red('tried, no')
          : dim(fix.kind === 'patch' ? 'untested' : 'manual');
    const risk = fix.risk === 'lower-security' ? amber(' lower security') : '';
    out(`${indent}    ${mark}${risk}  ${fix.label}${fix.command ? dim(`  $ ${fix.command}`) : ''}`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
