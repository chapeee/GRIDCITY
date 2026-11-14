import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, test, type Page } from '@playwright/test';
import { FRESH_PASSWORD, startLiveStack, type LiveStack } from './support/live-stack';

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
  await page.addInitScript(() => localStorage.setItem('preferences:intro-seen', 'true'));
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
  // Generous: under Docker's software WebGL a single frame of the dive can take seconds.
  await expect(page.locator('.terminal-status')).toHaveText('connected', { timeout: 30_000 });
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

test('connect a server with no terminal: trust, create key, password once, online', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('connect a server');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Connect a server' });
  await expect(dialog).toBeVisible();

  // 1. Address
  await dialog.getByLabel('SSH address').fill(`root@127.0.0.1:${stack.fresh.port}`);
  await dialog.getByLabel('Name', { exact: true }).fill('new-box');
  await dialog.getByLabel('District').fill('Lab');
  await dialog.getByRole('button', { name: 'Next' }).click();

  // 2. Trust: the fingerprint is shown before anything is trusted.
  await expect(dialog.locator('.fingerprint')).toContainText('SHA256:', { timeout: 15_000 });
  await page.screenshot({ path: 'test-results/screenshots/live-connect-trust.png' });
  await dialog.getByRole('button', { name: 'Yes, this is my server' }).click();

  // 3. Key: none yet, so create one.
  await expect(dialog.getByText("You don't have an SSH key yet.")).toBeVisible();
  await dialog.getByRole('button', { name: 'Create a new key for this app' }).click();
  await expect(dialog.getByRole('radio')).toBeChecked();
  await dialog.getByRole('button', { name: 'Continue' }).click();

  // 4. Install: a wrong password is refused, then the right one works.
  const password = dialog.getByLabel(/Password for/);
  await expect(password).toBeVisible({ timeout: 15_000 });
  await password.fill('not-the-password');
  await dialog.getByRole('button', { name: 'Install key and connect' }).click();
  await expect(dialog.getByRole('alert')).toContainText('rejected the password');
  await expect(password).toHaveValue(''); // never kept after an attempt
  await password.fill(FRESH_PASSWORD);
  await page.screenshot({ path: 'test-results/screenshots/live-connect-password.png' });
  await dialog.getByRole('button', { name: 'Install key and connect' }).click();

  // 5. Done: the key is on the server and the host is live.
  await expect(dialog.getByText('new-box is connected')).toBeVisible({ timeout: 15_000 });
  expect(stack.fresh.installedKeys).toBe(1);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press('Control+k');
  await page.keyboard.type('new-box');
  await expect(page.getByRole('option', { name: /new-box/ })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  await expect(hudStatus()).toHaveText('online', { timeout: 15_000 });
});

test('connect an AWS server: upload its .ppk, no user typed, no password', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('connect a server');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Connect a server' });

  // AWS: just the address. The app finds the user (here ec2-user) itself.
  await dialog.getByLabel('Where is this server?').selectOption('aws');
  await dialog.getByLabel('SSH address').fill(`127.0.0.1:${stack.cloud.port}`);
  await dialog.getByLabel('Name', { exact: true }).fill('cloud-web');
  await dialog.getByLabel('District').fill('AWS');
  await dialog.getByRole('button', { name: 'Next' }).click();
  await expect(dialog.locator('.fingerprint')).toContainText('SHA256:', { timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Yes, this is my server' }).click();

  // Upload the provider's PuTTY key; it is converted and selected.
  await dialog.getByLabel('Key file').setInputFiles({
    name: 'cloud-web.ppk',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(stack.cloudKeyPpk),
  });
  const uploaded = dialog.getByRole('radio', { name: /cloud-web · ssh-ed25519/ });
  await expect(uploaded).toBeChecked({ timeout: 10_000 });
  await page.screenshot({ path: 'test-results/screenshots/live-connect-upload.png' });
  await dialog.getByRole('button', { name: 'Continue' }).click();

  // The server already has this key: straight to done, no password step.
  await expect(dialog.getByText('cloud-web is connected')).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('cloud-web');
  await expect(page.getByRole('option', { name: /cloud-web/ })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  await expect(hudStatus()).toHaveText('online', { timeout: 15_000 });
});

test('connect a private server through a jump host (bastion)', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('connect a server');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Connect a server' });

  await dialog.getByLabel('Where is this server?').selectOption('aws');
  await dialog.getByLabel('SSH address').fill(`ubuntu@127.0.0.1:${stack.privateBox.port}`);
  await dialog.getByRole('button', { name: /jump host/ }).click();
  await dialog.getByLabel('Jump host (bastion)').fill(`ec2-user@127.0.0.1:${stack.bastion.port}`);
  await dialog.getByLabel('Name', { exact: true }).fill('private-db');
  await dialog.getByLabel('District').fill('AWS');
  await dialog.getByRole('button', { name: 'Next' }).click();

  // 1. The bastion's identity first.
  await expect(dialog.getByText('the jump host')).toBeVisible({ timeout: 15_000 });
  await dialog.getByRole('button', { name: 'Yes, this is my server' }).click();

  // 2. The key (same key for the bastion and the server).
  await dialog.getByLabel('Key file').setInputFiles({
    name: 'cloud-web.ppk',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(stack.cloudKeyPpk),
  });
  await expect(dialog.getByRole('radio', { name: /cloud-web/ })).toBeChecked({ timeout: 10_000 });
  await dialog.getByRole('button', { name: 'Continue' }).click();

  // 3. The private server's own identity, checked through the tunnel.
  await expect(dialog.locator('.fingerprint')).toContainText('SHA256:', { timeout: 15_000 });
  await expect(dialog.getByText('the jump host')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/screenshots/live-connect-jump.png' });
  await dialog.getByRole('button', { name: 'Yes, this is my server' }).click();

  await expect(dialog.getByText('private-db is connected')).toBeVisible({ timeout: 20_000 });
  expect(stack.bastion.tunnelsOpened).toBeGreaterThan(0);
  await dialog.getByRole('button', { name: 'Done' }).click();
  await page.keyboard.press('Control+k');
  await page.keyboard.type('private-db');
  await expect(page.getByRole('option', { name: /private-db/ })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Enter');
  await expect(hudStatus()).toHaveText('online', { timeout: 15_000 });
});

test('an AI app (MCP, like Claude Code) runs a command only after the user clicks Allow', async () => {
  await page.keyboard.press('Escape');
  const url = new URL(stack.url);
  const token = url.searchParams.get('token') ?? '';
  const client = new Client({ name: 'e2e-claude-code', version: '1.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL('/mcp', url.origin), {
      requestInit: {
        headers: { Authorization: `Bearer ${token}`, 'X-Agent-Client': 'Claude Code' },
      },
    }),
  );
  const listed = await client.callTool({ name: 'list_servers', arguments: {} });
  expect(JSON.stringify(listed.content)).toContain('lab-01');

  const call = client.callTool({
    name: 'run_command',
    arguments: { server: 'lab-01', command: 'echo agent-was-here', reason: 'Say hello' },
  });

  // The approval card pops up over the city, with the exact command.
  const card = page.getByRole('alertdialog', {
    name: /Claude Code wants to run a command on lab-01/,
  });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.locator('.approval-command')).toHaveText('echo agent-was-here');
  await expect(card).toContainText('Say hello');
  await page.screenshot({ path: 'test-results/screenshots/live-agent-approval.png' });
  await card.getByRole('button', { name: 'Allow', exact: true }).click();

  const result = await call;
  expect(JSON.stringify(result.content)).toContain('agent-was-here');
  expect(result.isError).toBe(false);
  await expect(card).toHaveCount(0);
  await client.close();

  // The agent panel explains how to connect Claude Code, with a ready command.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('ask an ai agent');
  await page.keyboard.press('Enter');
  const panel = page.getByRole('region', { name: 'AI agents' });
  await expect(panel).toBeVisible();
  await panel.getByText('Use Claude Code with your Claude subscription').click();
  await expect(panel.locator('.agent-command')).toContainText('claude mcp add --transport http');
  await page.screenshot({ path: 'test-results/screenshots/live-agent-panel.png' });
  await page.keyboard.press('Escape');

  const audit = await page.request.get(new URL('/api/audit', stack.url).toString());
  const entries = (await audit.json()).entries as { kind: string; detail: string | null }[];
  expect(entries.find((e) => e.kind === 'agent_command_run')?.detail).toContain(
    'Claude Code, allowed by you: echo agent-was-here → exit 0',
  );
});

test('the audit log shows connections, key refusals and terminal sessions', async () => {
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+k');
  await page.keyboard.type('audit');
  await page.keyboard.press('Enter');
  // The panel, not the toolbar button of the same name.
  const panel = page.getByRole('region', { name: 'Audit log' });
  await expect(panel).toContainText('connected');
  await expect(panel).toContainText('host key refused');
  await expect(panel).toContainText('terminal opened');
  await expect(panel).toContainText('terminal closed');
  await page.screenshot({ path: 'test-results/screenshots/live-audit-log.png' });
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
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
