// Starts real database/storage containers and runs the connector tests
// against them. `--down` removes the containers afterwards; `--mssql` also
// starts SQL Server (large, x64 only).
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const compose = [
  'compose',
  '-f',
  'compose.connectors-test.yaml',
  ...(args.includes('--mssql') ? ['--profile', 'mssql'] : []),
];
const run = (command, commandArgs, env = {}) => {
  const result = spawnSync(command, commandArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, ...env },
  });
  return result.status ?? 1;
};

let status = run('docker', [...compose, 'up', '-d', '--wait']);
if (status === 0) {
  status = run('npx', ['vitest', 'run', 'apps/server/src/connectors'], {
    CONNECTOR_TESTS: '1',
    ...(args.includes('--mssql') ? { CONNECTOR_TESTS_MSSQL: '1' } : {}),
  });
}
if (args.includes('--down')) run('docker', [...compose, 'down', '-v']);
process.exit(status);
