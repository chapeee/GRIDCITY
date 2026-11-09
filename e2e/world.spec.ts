import { expect, test, type Page } from '@playwright/test';

/**
 * Visual and interaction checks of the 3D world in demo mode. Each test
 * also saves a screenshot to test-results/screenshots/ for human review
 * against docs/VISUAL_LANGUAGE.md.
 */

/** Faster demo polling so degraded/stale states and sparklines appear quickly. */
const DEMO_URL = '/?poll=500';

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
  await expect(page.getByRole('option', { name: /web-01/ })).toBeVisible();
  await screenshot(page, 'palette');
});

test('focusing a degraded host flies there and opens the HUD', async ({ page }) => {
  await openWorld(page);
  await focusViaPalette(page, 'api-01');
  await expect(page.locator('.focus-hud')).toContainText('CPU');
  await expect(page.locator('.hud-status')).toHaveText('degraded');
  await screenshot(page, 'focused-degraded');
});

test('a stale host is shown frozen with a last-seen label', async ({ page }) => {
  await openWorld(page);
  await focusViaPalette(page, 'lab-01');
  await expect(page.locator('.focus-hud')).toHaveClass(/is-stale/);
  await expect(page.locator('.hud-reason')).toContainText('last seen');
  await screenshot(page, 'focused-stale');
});

test('an offline host shows no metrics and its error', async ({ page }) => {
  await openWorld(page);
  await focusViaPalette(page, 'legacy-vps');
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
  await openWorld(page, '/?hosts=50');
  await page.waitForTimeout(4000);
  const overlay = await page.locator('.perf-overlay').innerText();
  test.info().annotations.push({ type: 'perf', description: overlay.replace(/\s+/g, ' ') });
  console.log(`[perf] 50 hosts: ${overlay.replace(/\s+/g, ' ')}`);
  await expect(page.locator('.perf-overlay')).toContainText('50');
  await screenshot(page, 'overview-50-hosts');
});
