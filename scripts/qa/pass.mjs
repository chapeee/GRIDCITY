// A repeatable QA pass for a release: real databases, AWS emulators (LocalStack for S3,
// Moto for RDS, EC2 and load balancers), the attack lab, and Mailpit + ntfy for alerts.
// The app runs on its own config and data in .qa/, never your real hosts or vault.
//
//   node scripts/qa/pass.mjs up       start or create everything, seed it, write .qa/config
//   node scripts/qa/pass.mjs serve    build first (npm run build), then run the app on :4700
//   node scripts/qa/pass.mjs attack   run the attack lab's attacks against the lab server
//   node scripts/qa/pass.mjs reset    forget the app's data (.qa/data), keep the containers
//
// Checklist and what each step should show: docs/qa/release-test-pass.md
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const qa = join(root, '.qa');
const PORT = '4700';

// Throwaway values for these test containers only (same as compose.connectors-test.yaml).
const QA_ENV = {
  QA_PW: 'test-monitor',
  QA_AWS: 'test',
  QA_MINIO_K: 'test-minio',
  QA_MINIO_S: 'test-minio-secret',
};

/** Emulators that are not in a compose file: started if they exist, created if not. */
const EMULATORS = [
  { name: 'gridcity-localstack', args: ['-p', '127.0.0.1:4566:4566', 'localstack/localstack:4.4'] },
  { name: 'gridcity-moto', args: ['-p', '127.0.0.1:5000:5000', 'motoserver/moto:5.1.4'] },
  {
    name: 'gridcity-mailpit',
    args: ['-p', '127.0.0.1:1025:1025', '-p', '127.0.0.1:8025:8025', 'axllent/mailpit:v1.27'],
  },
  {
    name: 'gridcity-ntfy',
    args: ['-p', '127.0.0.1:8090:80', 'binwiederhier/ntfy:v2.14.0', 'serve'],
  },
];

function run(command, args, { quiet = false, allowFail = false, env } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: quiet ? 'pipe' : 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0 && !allowFail) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${result.status}) ${result.stderr ?? ''}`,
    );
  }
  return result;
}

function up() {
  console.log('▶ databases (compose.connectors-test.yaml)');
  run('docker', ['compose', '-f', 'compose.connectors-test.yaml', 'up', '-d', '--wait']);

  for (const { name, args } of EMULATORS) {
    const started = run('docker', ['start', name], { quiet: true, allowFail: true });
    if (started.status !== 0) {
      console.log(`▶ creating ${name}`);
      run('docker', ['run', '-d', '--name', name, ...args]);
    } else console.log(`▶ ${name} started`);
  }
  // LocalStack and Moto need a moment before they answer.
  run('node', ['-e', 'setTimeout(()=>{},8000)']);

  console.log('▶ attack lab, public bucket and exposed RDS');
  run('node', ['scripts/security-lab.mjs', 'up']);
  run('node', ['scripts/security-lab.mjs', 'exposure']);
  console.log('▶ seeding LocalStack and Moto');
  run('node', ['scripts/qa/seed.mjs']);

  const config = join(qa, 'config');
  const ssh = join(qa, 'ssh');
  mkdirSync(config, { recursive: true });
  mkdirSync(join(qa, 'data'), { recursive: true });
  mkdirSync(ssh, { recursive: true });
  copyFileSync(join(root, 'scripts/qa/resources.yaml'), join(config, 'resources.yaml'));
  const key = join(root, 'scripts/security-lab/.keys/gridcity_lab').replaceAll('\\', '/');
  writeFileSync(
    join(config, 'hosts.yaml'),
    [
      'hosts:',
      '  - id: lab-target',
      '    name: lab-target',
      '    address: 127.0.0.1',
      '    port: 2222',
      '    user: ops',
      `    auth: { method: keyFile, path: ${key} }`,
      '    district: Security lab',
      '    tags: [web, lab]',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(config, 'districts.yaml'),
    'districts:\n  - { name: AWS, provider: aws, region: us-east-1, description: LocalStack + Moto }\n',
  );
  // Trust the lab's host key the way "Connect a server" would after a confirmed fingerprint.
  const scan = run('ssh-keyscan', ['-p', '2222', '-t', 'ed25519', '127.0.0.1'], { quiet: true });
  const line = scan.stdout.split('\n').find((l) => l.includes('ssh-ed25519'));
  if (!line) throw new Error('could not read the lab host key');
  writeFileSync(join(ssh, 'known_hosts'), `${line.trim()}\n`);
  console.log(`\n✔ Ready. Build (npm run build), then: node scripts/qa/pass.mjs serve`);
}

function serve() {
  if (!existsSync(join(root, 'apps/server/dist/index.js'))) {
    throw new Error('Build first: npm run build');
  }
  if (!existsSync(join(qa, 'config/hosts.yaml'))) throw new Error('Run "pass.mjs up" first.');
  console.log(`▶ GRIDCITY on http://127.0.0.1:${PORT} with .qa/ (Ctrl+C stops it)`);
  run('node', ['--enable-source-maps', 'apps/server/dist/index.js', '--foreground'], {
    env: {
      ...QA_ENV,
      CONFIG_DIR: join(qa, 'config'),
      DATA_DIR: join(qa, 'data'),
      SSH_DIR: join(qa, 'ssh'),
      SERVER_PORT: PORT,
    },
  });
}

const [command = 'up'] = process.argv.slice(2);
try {
  if (command === 'up') up();
  else if (command === 'serve') serve();
  else if (command === 'attack') run('node', ['scripts/security-lab.mjs', 'attack']);
  else if (command === 'reset') rmSync(join(qa, 'data'), { recursive: true, force: true });
  else throw new Error(`unknown command "${command}" (up, serve, attack, reset)`);
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
