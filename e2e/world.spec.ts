import { expect, test, type Page } from '@playwright/test';

/**
 * Visual and interaction checks of the 3D world in demo mode. Each test
 * also saves a screenshot to test-results/screenshots/ for human review
 * against docs/VISUAL_LANGUAGE.md.
 */

/** The intro plays on a first visit; tests that are not about it mark it as seen. */
const markIntroSeen = () => localStorage.setItem('preferences:intro-seen', 'true');

test.beforeEach(async ({ page }, testInfo) => {
  if (!testInfo.title.startsWith('intro')) await page.addInitScript(markIntroSeen);
});

/** The in-browser demo source (no server), with faster polling so states appear quickly. */
const DEMO_URL = '/?source=demo&poll=500';

async function openWorld(page: Page, url = DEMO_URL): Promise<void> {
  await page.goto(url);
  await expect(page.locator('html[data-world-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
  // Let several polls arrive (CPU needs 2 for a delta, degraded needs a streak).
  await page.waitForTimeout(4000);
}

async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `test-results/screenshots/${name}.png` });
}

async function focusViaPalette(page: Page, hostName: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder('Search hosts and actions…')).toBeVisible();
  await page.keyboard.type(hostName);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: hostName })).toBeVisible();
  await page.waitForTimeout(2500); // camera flight
}

test('overview shows the city and a permanent demo badge', async ({ page }) => {
  await openWorld(page);
  await expect(page.getByText('DEMO DATA')).toBeVisible();
  await screenshot(page, 'overview');
});

test('command palette lists hosts and actions', async ({ page }) => {
  await openWorld(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('web');
  await expect(page.getByRole('option', { name: /ausia-web/ })).toBeVisible();
  await screenshot(page, 'palette');
});

test('focusing a degraded host flies there and opens the HUD', async ({ page }) => {
  await openWorld(page);
  await focusViaPalette(page, 'lekhix-api');
  await expect(page.locator('.focus-hud')).toContainText('CPU');
  await expect(page.locator('.hud-status')).toHaveText('degraded');
  await screenshot(page, 'focused-degraded');
});

test('a stale host is shown frozen with a last-seen label', async ({ page }) => {
  await openWorld(page);
  await focusViaPalette(page, 'gridcity-lab');
  await expect(page.locator('.focus-hud')).toHaveClass(/is-stale/);
  await expect(page.locator('.hud-reason')).toContainText('last seen');
  await screenshot(page, 'focused-stale');
});

test('an offline host shows no metrics and its error', async ({ page }) => {
  await openWorld(page);
  await focusViaPalette(page, 'bugspoon-legacy');
  await expect(page.locator('.hud-status')).toHaveText('offline');
  // The connection error is the status reason, shown once in the alert color.
  await expect(page.locator('.hud-reason')).toContainText('ECONNREFUSED');
  await expect(page.locator('.hud-reason')).toHaveClass(/is-error/);
  await expect(page.locator('.hud-metric').first()).toContainText('—');
  await expect(page.getByRole('button', { name: /Jack in/ })).toBeDisabled();
  await screenshot(page, 'focused-offline');
});

test('keyboard: Tab jumps between hosts, Escape returns to overview', async ({ page }) => {
  await openWorld(page);
  await page.keyboard.press('Tab');
  await expect(page.locator('.focus-hud')).toBeVisible();
  const first = await page.locator('.focus-hud h2').innerText();
  await page.keyboard.press('Tab');
  await expect(page.locator('.focus-hud h2')).not.toHaveText(first);
  await page.keyboard.press('Escape');
  await expect(page.locator('.focus-hud')).toHaveCount(0);
});

test('jacking in to demo data dives in and says there is no real shell', async ({ page }) => {
  await openWorld(page);
  await focusViaPalette(page, 'ausia-web');
  await page.keyboard.press('Enter');
  // Generous: under Docker's software WebGL a single frame of the dive can take seconds.
  await expect(page.getByLabel('Terminal on ausia-web')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.terminal-status')).toHaveText('demo data');
  await page.waitForTimeout(400);
  await screenshot(page, 'terminal-demo');
  await page.keyboard.press('Control+Shift+X');
  await expect(page.getByLabel('Terminal on ausia-web')).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('.focus-hud')).toBeVisible();
});

test('offline hosts cannot be entered', async ({ page }) => {
  await openWorld(page);
  await focusViaPalette(page, 'bugspoon-legacy');
  await page.keyboard.press('Enter');
  await expect(page.getByText('no SSH connection to open a terminal on')).toBeVisible();
  await expect(page.locator('.terminal-view')).toHaveCount(0);
});

test('intro plays on the first visit, any key skips it, and it is not shown again', async ({
  page,
}) => {
  await page.goto(DEMO_URL);
  await expect(page.locator('.intro')).toBeVisible();
  await page.waitForTimeout(600);
  await screenshot(page, 'intro');
  await page.keyboard.press('Space');
  await expect(page.locator('.intro')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('html[data-world-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.locator('.intro')).toHaveCount(0);
});

test('ambient mode tours hosts that need attention, and Esc stops it', async ({ page }) => {
  await openWorld(page);
  await page.keyboard.press('a');
  await expect(page.locator('.ambient-badge')).toBeVisible();
  await expect(page.locator('.focus-hud')).toBeVisible({ timeout: 5000 });
  // Only unhealthy hosts are tour stops.
  await expect(page.locator('.hud-status')).toHaveText(/offline|degraded|stale/);
  await page.waitForTimeout(3500);
  await screenshot(page, 'ambient');
  await page.keyboard.press('Escape');
  await expect(page.locator('.ambient-badge')).toHaveCount(0);
});

test('the audit log explains it lives on the server in browser-demo mode', async ({ page }) => {
  await openWorld(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('open audit log');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Audit log')).toContainText('lives on the server');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Audit log')).toHaveCount(0);
});

test('lite mode turns off post-processing and particles', async ({ page }) => {
  await openWorld(page);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('lite mode');
  await page.keyboard.press('Enter');
  await expect(page.locator('.perf-overlay')).toContainText('lite');
  await page.waitForTimeout(1500);
  await screenshot(page, 'lite-mode');
});

test('performance with 50 hosts (numbers only meaningful with WORLD_GPU=1)', async ({ page }) => {
  await openWorld(page, '/?source=demo&hosts=50');
  await page.waitForTimeout(4000);
  const overlay = await page.locator('.perf-overlay').innerText();
  test.info().annotations.push({ type: 'perf', description: overlay.replace(/\s+/g, ' ') });
  console.log(`[perf] 50 hosts: ${overlay.replace(/\s+/g, ' ')}`);
  await expect(page.locator('.perf-overlay')).toContainText('50');
  await screenshot(page, 'overview-50-hosts');
});
