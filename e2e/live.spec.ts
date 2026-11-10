import { expect, test, type Page } from '@playwright/test';
import { startLiveStack, type LiveStack } from './support/live-stack';

/**
 * The truth rules, verified in the real UI over real SSH:
 * - kill the connection  -> the host goes offline, then recovers;
 * - block polling        -> the host goes stale (frozen), then thaws;
 * - unknown host key     -> refused, with its fingerprint, nothing runs;
 * - lose the server      -> the UI says so and data freezes.
 *
 * Runs the built server (`npm run build`) against in-process SSH servers.
 */

test.describe.configure({ mode: 'serial' });

let stack: LiveStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  stack = await startLiveStack();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(stack.url);
  await expect(page.locator('html[data-world-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
});

test.afterAll(async () => {
  await page?.close();
  await stack?.close();
});

async function focus(hostName: string): Promise<void> {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type(hostName);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: hostName })).toBeVisible();
}

const hudStatus = () => page.locator('.hud-status');

test('real hosts appear, without the demo badge, and the token leaves the URL', async () => {
  await expect(page.getByText('DEMO DATA')).toHaveCount(0);
  expect(page.url()).not.toContain('token=');
  await focus('lab-01');
  await expect(hudStatus()).toHaveText('online', { timeout: 15_000 });
  await expect(page.locator('.hud-os')).toContainText('Debian');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'test-results/screenshots/live-online.png' });
});

test('an unknown host key is refused, with its fingerprint and safe guidance', async () => {
  await focus('stranger');
  await expect(hudStatus()).toHaveText('offline', { timeout: 15_000 });
  await expect(page.locator('.hud-refusal')).toContainText('SHA256:');
  await expect(page.locator('.hud-refusal')).toContainText('Unknown host key');
  expect(stack.untrusted.execCount).toBe(0);
  await page.screenshot({ path: 'test-results/screenshots/live-host-key-refused.png' });
});

test('killing the connection turns the host offline, then it recovers', async () => {
  await focus('lab-01');
  await expect(hudStatus()).toHaveText('online', { timeout: 15_000 });
  stack.trusted.dropAllClients();
  await expect(hudStatus()).toHaveText('offline', { timeout: 10_000 });
  await page.screenshot({ path: 'test-results/screenshots/live-offline.png' });
  await expect(hudStatus()).toHaveText('online', { timeout: 20_000 });
});

test('blocking polling freezes the host as stale, then it thaws', async () => {
  await focus('lab-01');
  await expect(hudStatus()).toHaveText('online', { timeout: 15_000 });
  stack.trusted.execBehavior = 'stall';
  await expect(page.locator('.focus-hud')).toHaveClass(/is-stale/, { timeout: 15_000 });
  await expect(page.locator('.hud-reason')).toContainText('last seen');
  await page.screenshot({ path: 'test-results/screenshots/live-stale.png' });
  stack.trusted.execBehavior = 'fixtures';
  await expect(page.locator('.focus-hud')).not.toHaveClass(/is-stale/, { timeout: 20_000 });
});

test('jacking in opens a real shell: input, resize, exit back to the city, audited', async () => {
  await focus('lab-01');
  await expect(hudStatus()).toHaveText('online', { timeout: 15_000 });
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-status')).toHaveText('connected', { timeout: 10_000 });
  expect(stack.trusted.lastWindow?.cols).toBeGreaterThan(40);

  await page.keyboard.type('echo hello');
  await page.keyboard.press('Enter');
  await expect.poll(() => stack.trusted.shellLines.at(-1)).toBe('echo hello');
  await page.screenshot({ path: 'test-results/screenshots/live-terminal.png' });

  const before = stack.trusted.lastWindow?.cols ?? 0;
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect.poll(() => stack.trusted.lastWindow?.cols).toBeLessThan(before);
  await page.setViewportSize({ width: 1440, height: 900 });

  // Esc goes to the shell (vim needs it), not to the city.
  await page.keyboard.press('Escape');
  await expect(page.locator('.terminal-view')).toBeVisible();
  await page.keyboard.press('Enter'); // the shell received ESC; finish that line

  await page.keyboard.type('exit');
  await page.keyboard.press('Enter');
  await expect(page.locator('.terminal-view')).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('.focus-hud')).toBeVisible();

  const audit = await page.request.get(new URL('/api/audit', stack.url).toString());
  const kinds = ((await audit.json()) as { entries: { kind: string }[] }).entries.map(
    (e) => e.kind,
  );
  expect(kinds).toEqual(expect.arrayContaining(['terminal_opened', 'terminal_closed']));
});

test('losing the server shows a reconnect banner and data freezes', async () => {
  await focus('lab-01');
  await stack.stopServer();
  await expect(page.getByText('Lost connection to the local server')).toBeVisible({
    timeout: 10_000,
  });
  // No server, no data: the client's own clock must freeze the host.
  await expect(page.locator('.focus-hud')).toHaveClass(/is-stale/, { timeout: 15_000 });
  await page.screenshot({ path: 'test-results/screenshots/live-server-lost.png' });
});
