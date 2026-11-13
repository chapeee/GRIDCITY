// Builds the GRIDCITY desktop app from the npm package in release/npm:
//
//   npm run pack:npm                       (repository root: builds release/npm)
//   cd packaging/desktop && npm ci
//   node build.mjs [electron-builder args]  e.g. --win --x64, --mac --arm64, --linux
//   node build.mjs --stage-only             only prepare stage/ (to run or test it)
//
// Output:
//   stage/                 the app folder Electron runs (main.cjs + the gridcity package)
//   dist/                  installers: GRIDCITY-<version>-<os>-<arch>.<ext>
//   ../../release/desktop-npm/  the `gridcity-desktop` npm package (`npx gridcity-desktop`)
//
// The library code is not touched or rebuilt here: the desktop app ships the
// exact `gridcity` package that goes to npm.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const npmPackage = join(root, 'release', 'npm');
const stage = join(here, 'stage');
const work = join(here, '.work');
const desktopNpm = join(root, 'release', 'desktop-npm');

const args = process.argv.slice(2);
const stageOnly = args.includes('--stage-only');
const builderArgs = args.filter((arg) => arg !== '--stage-only');

if (!existsSync(join(npmPackage, 'package.json'))) {
  console.error('release/npm is missing: run "npm run pack:npm" in the repository root first.');
  process.exit(1);
}
const gridcity = JSON.parse(readFileSync(join(npmPackage, 'package.json'), 'utf8'));
const electronVersion = JSON.parse(
  readFileSync(join(here, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;
const version = gridcity.version;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (command, commandArgs, cwd) =>
  execFileSync(command, commandArgs, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

const common = {
  version,
  description:
    'GRIDCITY desktop app: your servers, databases and buckets as a living 3D city, in its own window.',
  author: { name: 'Raj', email: '137584877+chapeee@users.noreply.github.com' },
  license: gridcity.license,
  homepage: 'https://chapeee.github.io/GRIDCITY/',
  repository: gridcity.repository,
  bugs: gridcity.bugs,
};

// 1. The gridcity package as npm would install it, packed to a tarball.
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
run(npm, ['pack', npmPackage, '--pack-destination', work, '--silent'], here);
const tarball = join(work, `gridcity-${version}.tgz`);

// 2. stage/: main.cjs, the icon, and gridcity with its runtime dependencies.
//    Optional dependencies are left out: better-sqlite3 is native code built for
//    plain Node.js, and the app uses the SQLite built into Electron's Node.js.
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'build'), { recursive: true });
cpSync(join(here, 'main.cjs'), join(stage, 'main.cjs'));
cpSync(join(here, 'icon.png'), join(stage, 'icon.png'));
cpSync(join(here, 'icon.png'), join(stage, 'build', 'icon.png'));
cpSync(join(here, 'installer.nsh'), join(stage, 'build', 'installer.nsh'));
writeFileSync(
  join(stage, 'package.json'),
  `${JSON.stringify(
    {
      name: 'gridcity-desktop',
      productName: 'GRIDCITY',
      ...common,
      main: 'main.cjs',
      dependencies: { gridcity: version },
    },
    null,
    2,
  )}\n`,
);
run(
  npm,
  ['install', tarball, '--omit=optional', '--omit=dev', '--no-save', '--no-audit', '--no-fund'],
  stage,
);
console.log(`stage/: gridcity ${version} on Electron ${electronVersion}`);

// 3. The gridcity-desktop npm package: `npx gridcity-desktop` downloads Electron
//    and gridcity from npm and opens the same window.
rmSync(desktopNpm, { recursive: true, force: true });
mkdirSync(join(desktopNpm, 'bin'), { recursive: true });
cpSync(join(here, 'main.cjs'), join(desktopNpm, 'main.cjs'));
cpSync(join(here, 'icon.png'), join(desktopNpm, 'icon.png'));
cpSync(join(here, 'launcher.cjs'), join(desktopNpm, 'bin', 'gridcity-desktop.cjs'));
cpSync(join(here, 'README.npm.md'), join(desktopNpm, 'README.md'));
cpSync(join(root, 'LICENSE'), join(desktopNpm, 'LICENSE'));
writeFileSync(
  join(desktopNpm, 'package.json'),
  `${JSON.stringify(
    {
      name: 'gridcity-desktop',
      ...common,
      keywords: ['gridcity', 'desktop', 'electron', 'monitoring', 'devops', 'ssh', '3d', 'mcp'],
      main: 'main.cjs',
      bin: { 'gridcity-desktop': 'bin/gridcity-desktop.cjs' },
      files: ['bin', 'main.cjs', 'icon.png', 'README.md', 'LICENSE'],
      engines: gridcity.engines,
      dependencies: { electron: electronVersion, gridcity: version },
      publishConfig: { access: 'public', provenance: true },
    },
    null,
    2,
  )}\n`,
);
console.log(`release/desktop-npm/: gridcity-desktop ${version}`);

if (stageOnly) process.exit(0);

// 4. Installers.
run(
  join(
    here,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
  ),
  [
    '--projectDir',
    stage,
    '--config',
    join(here, 'electron-builder.yml'),
    `-c.electronVersion=${electronVersion}`,
    '--publish',
    'never',
    ...builderArgs,
  ],
  here,
);
