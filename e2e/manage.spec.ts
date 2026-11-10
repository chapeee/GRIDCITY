import { expect, test, type Page } from '@playwright/test';

/** History, Settings and Edit in the browser demo (generated DEMO DATA, nothing saved). */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('preferences:intro-seen', 'true'));
  await page.goto('/?source=demo&poll=500');
  await expect(page.locator('html[data-world-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
  await page.waitForTimeout(3000);
});

async function palette(page: Page, query: string): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
}

test('H opens the history of the focused server: summary, timeline, charts, incidents', async ({
  page,
}) => {
  await page.keyboard.press('Tab');
  await expect(page.locator('.focus-hud')).toBeVisible();
  await page.keyboard.press('h');
  const panel = page.locator('.history-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByText(/^History · /)).toBeVisible();
  await expect(panel.getByText('DEMO DATA: generated history, not a real server.')).toBeVisible();
  await expect(panel.locator('.history-timeline')).toBeVisible();
  await expect(panel.locator('.history-chart')).toHaveCount(4);
  await expect(panel.getByRole('heading', { name: 'Incidents' })).toBeVisible();
  await expect(panel.getByRole('button', { name: '7 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // 30 days is more than is kept (7 by default): offered, but disabled.
  await expect(panel.getByRole('button', { name: '30 days' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/screenshots/history-host.png' });

  await panel.getByRole('button', { name: '24 h' }).click();
  await expect(
    panel.getByText(/in the last 24 hours|No incidents in the last 24 hours/),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('fleet history lists incidents across servers and opens one server', async ({ page }) => {
  await palette(page, 'fleet history');
  const panel = page.locator('.history-panel');
  await expect(panel.getByRole('heading', { name: 'Fleet history' })).toBeVisible();
  const first = panel.locator('.history-incidents li').first();
  await expect(first).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/history-fleet.png' });
  const name = await first.locator('.history-target').innerText();
  await first.locator('.history-target').click();
  await expect(panel.getByText(`History · ${name}`)).toBeVisible();
});

test('settings show retention and warning thresholds, read-only with demo data', async ({
  page,
}) => {
  await palette(page, 'settings');
  const panel = page.locator('.settings-panel');
  await expect(panel.getByText('DEMO DATA: settings are shown but cannot be saved.')).toBeVisible();
  await expect(panel.getByLabel('Keep history for')).toHaveValue('7');
  await expect(panel.getByLabel('CPU warning')).toHaveValue('90');
  await expect(panel.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.screenshot({ path: 'test-results/screenshots/settings.png' });
});

test('the HUD offers History; Edit only exists with real servers', async ({ page }) => {
  await page.keyboard.press('Tab');
  const hud = page.locator('.focus-hud');
  await expect(hud.getByRole('button', { name: /History/ })).toBeVisible();
  await expect(hud.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
});
