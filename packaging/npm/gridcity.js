#!/usr/bin/env node
// The `gridcity` command. Starts the app, or runs one of its tools.
// Installed from npm, the app keeps its settings in your user config folder,
// never in the folder you start it from.
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = createRequire(import.meta.url)(join(root, 'package.json'));

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  process.stderr.write(
    `gridcity needs Node.js 22.12 or newer (this is ${process.versions.node}).\n`,
  );
  process.exit(1);
}

process.env.GRIDCITY_PACKAGED = '1';
process.env.PROJECT_NAME ??= 'GRIDCITY';
// A command-line tool prints its link, warnings and errors; request logs are for debugging.
process.env.LOG_LEVEL ??= 'warn';

const HELP = `
  gridcity ${pkg.version} · your servers as a living city of light

  gridcity                      start with your servers, then open the printed link
  gridcity demo                 start with a simulated city (no setup at all)
  gridcity doctor [--json]      check this machine and every server, database,
                                bucket and probe; proves fixes (exit 1 on problems)
  gridcity mcp                  connect Claude Code or any MCP app to your city
  gridcity add-host user@host   test and add one SSH server
  gridcity import-ssh-config    add every host from ~/.ssh/config

  Options for start and demo:
    --port <n>      serve on this port (default 4600, always 127.0.0.1 only)
    --open          open the browser
    --new-token     new link: signs out every browser

  Everything else (servers, databases, keys, alerts) is set up in the app.
  Docs: https://chapeee.github.io/GRIDCITY/
`;

const ENTRIES = {
  start: 'index.js',
  demo: 'index.js',
  doctor: 'doctor.js',
  mcp: 'mcp-setup.js',
  'add-host': 'add-host.js',
  'import-ssh-config': 'import-ssh-config.js',
};

const args = process.argv.slice(2);
const first = args[0];
if (first === '--help' || first === '-h' || first === 'help') {
  process.stdout.write(HELP);
  process.exit(0);
}
if (first === '--version' || first === '-v' || first === 'version') {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}

const command = first && !first.startsWith('-') ? first : 'start';
const entry = ENTRIES[command];
if (!entry) {
  process.stderr.write(`Unknown command "${command}".\n${HELP}`);
  process.exit(1);
}
const rest =
  command === 'start' && first?.startsWith('-') ? args : args.slice(first === command ? 1 : 0);
process.argv = [
  process.argv[0],
  join(root, 'apps/server/dist', entry),
  ...(command === 'demo' ? ['--demo'] : []),
  ...rest,
];
await import(pathToFileURL(join(root, 'apps/server/dist', entry)).href);
