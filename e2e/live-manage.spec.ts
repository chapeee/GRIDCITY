import { expect, test, type Page } from '@playwright/test';
import { startLiveStack, type LiveStack } from './support/live-stack';

/**
 * History, Edit and Settings against the built server and a real SSH host:
 * an outage is recorded and shown in History; renaming, moving and giving a
 * server its own warning threshold rewrite hosts.yaml and the city follows;
 * Settings saves the retention.
 */
test.describe.configure({ mode: 'serial' });

let stack: LiveStack;
let page: Page;

test.beforeAll(async ({ browser }) => {
  stack = await startLiveStack();
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.addInitScript(() => localStorage.setItem('preferences:intro-seen', 'true'));
  await page.goto(stack.url);
  await expect(page.locator('html[data-world-ready="true"]')).toHaveCount(1, { timeout: 60_000 });
});

test.afterAll(async () => {
  await page?.close();
  await stack?.close();
});

async function focus(name: string): Promise<void> {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type(name);
  await page.keyboard.press('Enter');
  await expect(page.locator('.focus-hud h2').filter({ hasText: name })).toBeVisible();
}

const hudStatus = () => page.locator('.hud-status');

test('an outage is recorded and shown in the server history', async () => {
  await focus('lab-01');
  await expect(hudStatus()).toHaveText('online', { timeout: 15_000 });
  stack.trusted.dropAllClients();
  await expect(hudStatus()).toHaveText('offline', { timeout: 10_000 });
  await expect(hudStatus()).toHaveText('online', { timeout: 20_000 });

  await page.keyboard.press('h');
  const panel = page.locator('.history-panel');
  await expect(panel.getByText('History · lab-01')).toBeVisible();
  await expect(panel.getByText('DEMO DATA')).toHaveCount(0);
  const incident = panel.locator('.history-incidents li.is-offline').first();
  await expect(incident).toBeVisible();
  await expect(panel.locator('.history-segment.is-offline')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/screenshots/live-history.png' });
  await page.keyboard.press('Escape');
});

test('edit renames, moves district and sets an own warning; the city follows', async () => {
  await focus('lab-01');
  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog', { name: 'Edit lab-01' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Name').fill('Lab one');
  await dialog.getByLabel('District').fill('Basement');
  // Any real memory use is above 1%: this server must turn amber.
  await dialog.getByLabel('Memory warning above').fill('1');
  await page.screenshot({ path: 'test-results/screenshots/live-edit.png' });
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);

  await focus('Lab one');
  await expect(page.locator('.hud-subtitle').first()).toHaveText('Basement');
  await expect(hudStatus()).toHaveText('degraded', { timeout: 15_000 });
  await expect(page.locator('.hud-reason')).toContainText('memory');
  await expect(page.getByText('Own warnings: memory > 1%')).toBeVisible();

  // Clearing the override returns it to the file-wide rules.
  await page.keyboard.press('e');
  const again = page.getByRole('dialog', { name: 'Edit Lab one' });
  await again.getByLabel('Memory warning above').fill('');
  await again.getByRole('button', { name: 'Save' }).click();
  await expect(hudStatus()).toHaveText('online', { timeout: 15_000 });
});

test('settings save the history retention', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('settings');
  await page.keyboard.press('Enter');
  const panel = page.locator('.settings-panel');
  await expect(panel.getByLabel('Keep history for')).toHaveValue('7');
  await panel.getByLabel('Keep history for').fill('14');
  await panel.getByRole('button', { name: 'Save' }).click();
  await expect(panel.getByText(/^Saved\./)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('settings');
  await page.keyboard.press('Enter');
  await expect(page.locator('.settings-panel').getByLabel('Keep history for')).toHaveValue('14');
});
