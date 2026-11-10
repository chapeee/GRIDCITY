import { HostSchema } from '@app/shared';
import { homedir, userInfo } from 'node:os';
import { parseArgs } from 'node:util';
import { resolveAppPaths } from '../config/app-paths';
import { parseServerEnv } from '../config/env';
import { loadEnvFiles } from '../config/env-files';
import { draftToHostInput, HostDraftSchema } from '../config/host-draft';
import { addHostToFile } from '../config/hosts-writer';
import { buildAuthOptions } from '../ssh/auth-options';
import { connectionAdvice } from '../ssh/connection-advice';
import { readKnownHostsFiles } from '../ssh/known-hosts-files';
import { testConnection } from '../ssh/test-connection';

const USAGE = `Add a host to the city.

  npm run add-host -- root@192.168.1.155
  npm run add-host -- ops@box.lan:2222 --name web-01 --district "Home lab"

Options:
  --name <name>        label on the tower (default: the address)
  --district <name>    group (default: "default")
  --key <path>         use this unencrypted key file instead of ssh-agent
  --no-test            save without testing the connection first

The connection is tested first (strict known_hosts, your agent or key) and the
host is only saved if it works, unless --no-test. A running server picks the
change up automatically.`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: 'string' },
      district: { type: 'string' },
      key: { type: 'string' },
      'no-test': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help || positionals.length !== 1) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(values.help ? 0 : 1);
  }

  loadEnvFiles();
  const env = parseServerEnv(process.env);
  const homeDir = homedir();
  const paths = resolveAppPaths({
    projectName: env.PROJECT_NAME,
    env: process.env,
    platform: process.platform,
    homeDir,
  });

  const draft = HostDraftSchema.parse({
    target: positionals[0],
    name: values.name,
    district: values.district,
    auth: values.key ? { method: 'keyFile', path: values.key } : undefined,
  });
  const host = HostSchema.parse(draftToHostInput(draft, userInfo().username));
  const label = `${host.name} (${host.user}@${host.address}:${host.port})`;

  if (!values['no-test']) {
    process.stdout.write(`Testing ${label}…\n`);
    const result = await testConnection(host, {
      loadKnownHosts: () => readKnownHostsFiles(paths.knownHostsFiles),
      buildAuth: (target) =>
        buildAuthOptions(target.auth, { env: process.env, platform: process.platform, homeDir }),
    });
    if (!result.ok) {
      const steps = connectionAdvice(result, host, process.platform);
      process.stdout.write(
        `\nCould not connect. Not saved.\n\n${steps.map((step, i) => `  ${i + 1}. ${step}`).join('\n')}\n\n` +
          'Fix that and run the same command again, or add --no-test to save anyway.\n',
      );
      process.exit(2);
    }
    process.stdout.write('Connected.\n');
  }

  await addHostToFile(paths.hostsFile, host);
  process.stdout.write(`Added ${label} to ${paths.hostsFile}\n`);
  if (env.DATA_MODE === 'demo') {
    process.stdout.write(
      'Note: DATA_MODE=demo is set, so the city shows demo data. Set DATA_MODE=real to see it.\n',
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
