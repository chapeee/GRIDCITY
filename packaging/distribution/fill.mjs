// Fills the package-manager manifests in this folder with a released version
// and the SHA-256 checksums of its GitHub release downloads:
//
//   node packaging/distribution/fill.mjs 0.5.0
//
// Reads SHA256SUMS.txt from the release (so run it after the Release workflow
// finished) and writes the filled files to release/distribution/, ready to
// submit (see website/docs/contributing/releasing.md, "Other places to publish").
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'release', 'distribution');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+/.test(version ?? '')) {
  console.error('Usage: node packaging/distribution/fill.mjs <version>   (e.g. 0.5.0)');
  process.exit(1);
}

const base = `https://github.com/chapeee/GRIDCITY/releases/download/v${version}`;
const response = await fetch(`${base}/SHA256SUMS.txt`);
if (!response.ok) {
  console.error(`No SHA256SUMS.txt in release v${version} yet (${response.status}).`);
  process.exit(1);
}
const sums = Object.fromEntries(
  (await response.text())
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+\*?/))
    .map(([hash, file]) => [file, hash]),
);
const sha = (file) => {
  if (!sums[file]) throw new Error(`${file} is not in SHA256SUMS.txt`);
  return sums[file];
};
const values = {
  VERSION: version,
  WIN_X64_SHA256: sha(`GRIDCITY-${version}-win-x64.exe`).toUpperCase(),
  WIN_ARM64_SHA256: sha(`GRIDCITY-${version}-win-arm64.exe`).toUpperCase(),
  WIN_ZIP_X64_SHA256: sha(`GRIDCITY-${version}-win-x64.zip`),
  MAC_ARM64_SHA256: sha(`GRIDCITY-${version}-mac-arm64.dmg`),
  MAC_X64_SHA256: sha(`GRIDCITY-${version}-mac-x64.dmg`),
  LINUX_X64_DEB_SHA256: sha(`GRIDCITY-${version}-linux-amd64.deb`),
  LINUX_ARM64_DEB_SHA256: sha(`GRIDCITY-${version}-linux-arm64.deb`),
};

const templates = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return templates(path);
    return name.endsWith('.mjs') || name === 'README.md' ? [] : [path];
  });
for (const file of templates(here)) {
  const target = join(out, relative(here, file));
  mkdirSync(dirname(target), { recursive: true });
  const text = readFileSync(file, 'utf8').replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`${file}: unknown placeholder ${match}`);
    return values[key];
  });
  writeFileSync(target, text);
  console.log(`release/distribution/${relative(here, file).replace(/\\/g, '/')}`);
}
