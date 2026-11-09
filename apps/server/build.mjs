// Bundles the server into a single ESM file for production.
//
// Workspace packages (@app/*) ship as TypeScript source, so they are bundled
// in. Every third-party dependency stays external and is installed normally,
// which keeps native modules (better-sqlite3) working.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter((name) => !name.startsWith('@app/'));

await build({
  // The server, plus the import command (usable without dev tools in Docker).
  entryPoints: { index: 'src/index.ts', 'import-ssh-config': 'src/cli/import-ssh-config.ts' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external,
  logLevel: 'info',
});
