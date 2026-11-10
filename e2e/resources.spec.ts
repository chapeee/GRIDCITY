import { expect, test } from '@playwright/test';

/**
 * Databases, RDS and buckets in the demo city: they appear in Ctrl+K, open
 * their own panel, and cannot be "jacked into".
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('preferences:intro-seen', 'true'));
  await page.goto('/?source=demo&poll=500');
  await expect(page.locator('html[data-world-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
  await page.waitForTimeout(4000);
});

test('resources are listed in the palette and open their own panel', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.getByText('Databases & storage')).toBeVisible();
  await page.keyboard.type('orders-replica');
  await page.keyboard.press('Enter');
  const hud = page.getByRole('complementary', { name: 'Details for orders-replica' });
  await expect(hud).toBeVisible();
  await expect(hud.getByText('PostgreSQL · Databases')).toBeVisible();
  await expect(hud.getByText(/replica \d+s behind/)).toBeVisible();
  await expect(hud.getByText('Replica lag')).toBeVisible();
  await expect(hud.getByRole('button', { name: /Jack in/ })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/screenshots/resource-degraded.png' });

  // Enter on a resource explains there is no shell instead of diving in.
  await page.keyboard.press('Enter');
  await expect(page.getByText(/there is no shell to open/)).toBeVisible();
});

test('an offline cache shows dashes and its error; a bucket count can be capped', async ({
  page,
}) => {
  await page.keyboard.press('Control+k');
  await page.keyboard.type('session-cache');
  await page.keyboard.press('Enter');
  const hud = page.getByRole('complementary', { name: 'Details for session-cache' });
  await expect(hud.getByText('offline', { exact: true })).toBeVisible();
  await expect(hud.getByText(/ECONNREFUSED/)).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/resource-offline.png' });

  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('nightly-backups');
  await page.keyboard.press('Enter');
  const bucket = page.getByRole('complementary', { name: 'Details for nightly-backups' });
  await expect(bucket.getByText('S3 · R2 · Object storage')).toBeVisible();
  await expect(bucket.getByText(/^≥ 100,000$/)).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/resource-bucket.png' });
});
