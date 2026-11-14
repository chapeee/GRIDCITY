import { expect, test, type Page } from '@playwright/test';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLiveStack, type LiveStack } from './support/live-stack';

/**
 * "Connect a database or bucket" against the built server: pick a kind,
 * test with one real poll, add it, and it appears in the city and Ctrl+K;
 * then edit its name and remove it again.
 */
test.describe.configure({ mode: 'serial' });

let stack: LiveStack;
let page: Page;
let sqliteFile: string;

test.beforeAll(async ({ browser }) => {
  sqliteFile = join(mkdtempSync(join(tmpdir(), 'connect-sqlite-')), 'shop.db');
  const db = new Database(sqliteFile);
  db.exec(
    'CREATE TABLE orders (id INTEGER PRIMARY KEY); CREATE TABLE items (id INTEGER PRIMARY KEY);',
  );
  db.close();
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

async function palette(query: string): Promise<void> {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
}

test('connect a SQLite database: test shows what it read, add puts it in the city', async () => {
  await palette('connect a database');
  const dialog = page.getByRole('dialog', { name: /Connect a server, database/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: /PostgreSQL/ })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /S3 \/ Spaces \/ MinIO \/ R2/ })).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/connect-kinds.png' });

  await dialog.getByRole('button', { name: /SQLite/ }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('Shop DB');
  await expect(dialog.getByLabel('Id')).toHaveValue('shop-db');
  await dialog.getByLabel('File').fill(sqliteFile);
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText('Connected')).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText(/Tables 2/)).toBeVisible();
  await page.screenshot({ path: 'test-results/screenshots/connect-tested.png' });

  await dialog.getByRole('button', { name: 'Add to the city' }).click();
  await expect(dialog).toHaveCount(0);
  await palette('Shop DB');
  const hud = page.getByRole('complementary', { name: 'Details for Shop DB' });
  await expect(hud).toBeVisible({ timeout: 15_000 });
  await expect(hud.locator('.hud-status')).toHaveText('online', { timeout: 20_000 });
});

test('a failing test explains why, and secrets are refused', async () => {
  await palette('connect a database');
  const dialog = page.getByRole('dialog', { name: /Connect a server, database/ });
  await dialog.getByRole('button', { name: /PostgreSQL/ }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('nowhere');
  await dialog.getByLabel('Host').fill('127.0.0.1');
  await dialog.getByLabel('Port').fill('1');
  await dialog.getByLabel('User').fill('monitor');
  // Passwords are typed (and saved encrypted) by default; a variable is under Advanced.
  await dialog.getByText('Advanced: environment variables').click();
  await dialog.getByLabel('Password from').selectOption('env');
  await dialog.getByLabel('Variable name').fill('NOWHERE_PW');
  await dialog.getByLabel('Password for this test').fill('typed-once-secret');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText('Test failed')).toBeVisible({ timeout: 20_000 });
  // The real reason, not "NOWHERE_PW is not set": the typed test password was used.
  // (Shown in the result and again in the Doctor's connection steps.)
  await expect(dialog.getByText(/ECONNREFUSED/).first()).toBeVisible();
  await expect(dialog.getByText(/NOWHERE_PW is not set/)).toHaveCount(0);
  await expect(page.getByText('typed-once-secret')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('edit renames the resource and remove takes it out of the city', async () => {
  await palette('Shop DB');
  await page.keyboard.press('e');
  const dialog = page.getByRole('dialog', { name: 'Edit Shop DB' });
  await dialog.getByRole('textbox', { name: /^Name/ }).fill('Shop database');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toHaveCount(0);
  await palette('Shop database');
  await expect(page.getByRole('complementary', { name: 'Details for Shop database' })).toBeVisible({
    timeout: 15_000,
  });

  await page.keyboard.press('e');
  const again = page.getByRole('dialog', { name: 'Edit Shop database' });
  await again.getByRole('button', { name: 'Remove…' }).click();
  await again.getByRole('button', { name: 'Remove from resources.yaml?' }).click();
  await expect(again).toHaveCount(0);
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Shop database');
  await expect(page.getByText('Databases & storage')).toHaveCount(0, { timeout: 15_000 });
});
