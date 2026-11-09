// Bundles the server into a single ESM file for production.
//
// Workspace packages (@app/*) ship as TypeScript source, so they are bundled
// in. Every third-party dependency stays external and is installed normally,
// which keeps native modules (e.g. better-sqlite3 later) working.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@app/'));

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
});
