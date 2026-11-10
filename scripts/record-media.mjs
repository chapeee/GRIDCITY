// Records the README media (docs/media/demo.gif) with Playwright on the real
// GPU. Cross-platform way to set the env vars the media spec needs.
//
//   npm run media
import { spawnSync } from 'node:child_process';

const result = spawnSync('npx', ['playwright', 'test', 'e2e/media.spec.ts', '--reporter=list'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, RECORD_MEDIA: '1', WORLD_GPU: '1' },
});
process.exit(result.status ?? 1);
