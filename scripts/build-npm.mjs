// Assembles the publishable npm package in release/npm from the built app:
//   npm run build && node scripts/build-npm.mjs
// then `cd release/npm && npm publish` (the release workflow does this on a tag).
//
// The package is the server bundle (workspace code bundled in), the built web
// app, the `gridcity` command, and the server's third-party runtime
// dependencies only. No dev tooling, no source, no tests.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release', 'npm');
const read = (path) => JSON.parse(readFileSync(join(root, path), 'utf8'));

const rootPkg = read('package.json');
const serverPkg = read('apps/server/package.json');
for (const required of [
  'apps/server/dist/index.js',
  'apps/server/dist/doctor.js',
  'apps/web/dist/index.html',
]) {
  if (!existsSync(join(root, required))) {
    console.error(`Missing ${required}: run "npm run build" first.`);
    process.exit(1);
  }
}

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'bin'), { recursive: true });

cpSync(join(root, 'apps/server/dist'), join(out, 'apps/server/dist'), { recursive: true });
cpSync(join(root, 'apps/web/dist'), join(out, 'apps/web/dist'), { recursive: true });
cpSync(join(root, 'packaging/npm/gridcity.js'), join(out, 'bin/gridcity.js'));
cpSync(join(root, 'LICENSE'), join(out, 'LICENSE'));
cpSync(join(root, 'README.md'), join(out, 'README.md'));
if (existsSync(join(root, 'CHANGELOG.md')))
  cpSync(join(root, 'CHANGELOG.md'), join(out, 'CHANGELOG.md'));
// The server reads its own package.json for the version shown in the app.
writeFileSync(
  join(out, 'apps/server/package.json'),
  `${JSON.stringify({ name: '@gridcity/server', version: rootPkg.version, type: 'module', private: true }, null, 2)}\n`,
);

const dependencies = Object.fromEntries(
  Object.entries(serverPkg.dependencies ?? {}).filter(([name]) => !name.startsWith('@app/')),
);

const pkg = {
  name: 'gridcity',
  version: rootPkg.version,
  description:
    'Local-first server monitoring, database admin and security in a 3D city: SSH servers, PostgreSQL, MySQL, MongoDB, Redis, S3 and AWS as buildings, with attack detection, alerts (push, email, Slack, Telegram), a Doctor that proves fixes, time travel, and an MCP server for Claude Code and other AI agents.',
  keywords: [
    'devops',
    'monitoring',
    'ssh',
    'infrastructure',
    '3d',
    'threejs',
    'mcp',
    'ai-agents',
    'claude-code',
    'database',
    'observability',
    'homelab',
    'sre',
    'local-first',
    'mcp-server',
    'model-context-protocol',
    'server-monitoring',
    'database-admin',
    'postgresql',
    'mysql',
    'mongodb',
    'redis',
    's3',
    'aws',
    'security',
    'intrusion-detection',
    'crowdsec',
    'fail2ban',
    'alerts',
    'web-push',
    'uptime',
    'self-hosted',
  ],
  license: rootPkg.license ?? 'MIT',
  homepage: 'https://github.com/chapeee/GRIDCITY#readme',
  repository: { type: 'git', url: 'git+https://github.com/chapeee/GRIDCITY.git' },
  bugs: { url: 'https://github.com/chapeee/GRIDCITY/issues' },
  type: 'module',
  bin: { gridcity: 'bin/gridcity.js' },
  files: ['bin', 'apps', 'README.md', 'LICENSE', 'CHANGELOG.md'],
  engines: { node: '>=22.12' },
  dependencies,
  publishConfig: { access: 'public', provenance: true },
};
writeFileSync(join(out, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
console.log(
  `release/npm: gridcity@${pkg.version} (${Object.keys(dependencies).length} runtime dependencies)`,
);
