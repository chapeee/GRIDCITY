import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests and visual review screenshots for the web client.
 *
 *   npm run docker:e2e   reference run in the Playwright Docker image
 *                        (software WebGL via SwiftShader: correct, but slow)
 *   npm run test:e2e     native run; set WORLD_GPU=1 to use the real GPU,
 *                        which is the only way to get meaningful frame times
 *
 * Screenshots are written to test-results/screenshots/ for review.
 */
const useRealGpu = process.env.WORLD_GPU === '1';
const webPort = Number(process.env.WEB_PORT ?? 4601);

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results/artifacts',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${webPort}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
        launchOptions: {
          args: useRealGpu
            ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=default']
            : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],
  webServer: {
    command: 'npm run dev -w @app/web',
    url: `http://127.0.0.1:${webPort}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
