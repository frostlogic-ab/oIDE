import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './app';

/**
 * Files quick open and search in the built app (main's git ls-files index and git grep, the real
 * path guard): Ctrl/Cmd+K finds a file by name and opens it in Files, revealed in the tree;
 * Ctrl/Cmd+Shift+F finds text and replaces one match after the preview.
 */

let ctx: LaunchedApp;
let repo: string;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const shots = join(import.meta.dirname, '../test-results');
type Invoke = (command: string, input: unknown) => Promise<unknown>;

const RETRY = `export const MAX_ATTEMPTS = 5;

export async function webhookRetry(send: () => Promise<void>) {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    try {
      return await send();
    } catch {
      await sleep(2 ** i * 100);
    }
  }
}
`;

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'oide-e2e-files-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  const files: Record<string, string> = {
    'README.md': '# billing\n\nRetries use MAX_ATTEMPTS from the webhooks folder.\n',
    'src/webhooks/webhookRetry.ts': RETRY,
    'src/webhooks/handler.ts': "import { webhookRetry } from './webhookRetry';\n",
    'src/invoices/invoice.ts': 'export const dueDay = 15;\n',
    'build/out.js': 'MAX_ATTEMPTS\n',
    '.gitignore': 'build/\n',
  };
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), c);
  }
  gitIn(repo, 'add', '-A');
  gitIn(repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@oide.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  ctx = await launchApp({ OIDE_E2E_TRUST: 'trust', OIDE_E2E_OPEN_PATHS: repo });
  const win = await ctx.app.browserWindow(ctx.page);
  await win.evaluate((w) => w.setContentSize(1440, 900));
  await ctx.page.evaluate((path) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke('projects.open', { path }), repo);
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('Ctrl+K finds a file by name and opens it in Files, revealed in the tree', async () => {
  const { page } = ctx;
  await page.locator('body').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press(`${mod}+K`);
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await expect(bar).toBeVisible();
  await page.keyboard.type('whkretry');
  const option = bar.getByRole('option', { name: /webhookRetry\.ts/ });
  await expect(option).toBeVisible();
  await expect(bar.getByText('Files', { exact: true })).toBeVisible();
  await expect(bar.getByRole('option').first()).toContainText('webhookRetry.ts');
  await page.screenshot({ path: join(shots, 'files-quick-open.png') });
  await page.keyboard.press('Enter');
  await expect(bar).toBeHidden();

  await expect(page.getByRole('tab', { name: /webhookRetry\.ts/ })).toHaveAttribute('aria-selected', 'true');
  const tree = page.getByRole('tree', { name: /\(main\)/ });
  await expect(tree.getByRole('treeitem', { name: 'webhookRetry.ts' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('MAX_ATTEMPTS');

  // ":line" opens at a line; ignored files are not indexed.
  await page.keyboard.press(`${mod}+K`);
  await page.keyboard.type('out.js');
  await page.waitForTimeout(300);
  await expect(bar.getByRole('option', { name: /out\.js/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('Ctrl+Shift+F finds text in files and replaces one match after the preview', async () => {
  const { page } = ctx;
  await page.getByRole('tree', { name: /\(main\)/ }).getByRole('treeitem', { name: 'webhookRetry.ts' }).focus();
  await page.keyboard.press(`${mod}+Shift+F`);
  const panel = page.getByRole('complementary', { name: 'Search' });
  await expect(panel).toBeVisible();
  const field = panel.getByRole('textbox', { name: 'Search text' });
  await expect(field).toBeFocused();
  await field.fill('MAX_ATTEMPTS');
  await expect(panel.getByText('3 results in 2 files')).toBeVisible();
  // build/ is ignored by .gitignore, so build/out.js is not searched
  await expect(panel.getByRole('list', { name: 'Matches in build/out.js' })).toHaveCount(0);

  await panel.getByRole('button', { name: 'Toggle replace' }).click();
  await panel.getByRole('textbox', { name: 'Replace with' }).fill('MAX_TRIES');
  await page.screenshot({ path: join(shots, 'files-search.png') });
  const line4 = panel.getByRole('button', { name: /Replace match at line 4, column \d+ of src\/webhooks\/webhookRetry\.ts/ });
  await line4.hover();
  await line4.click();
  const dialog = page.getByRole('dialog', { name: 'Replace 1 match?' });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('[data-kind="add"]')).toContainText('i < MAX_TRIES; i++');
  await page.screenshot({ path: join(shots, 'files-replace-dialog.png') });
  await dialog.getByRole('button', { name: 'Replace 1 match' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Replaced 1 match in 1 file')).toBeVisible();
  await expect(panel.getByText('2 results in 2 files')).toBeVisible();

  const after = readFileSync(join(repo, 'src/webhooks/webhookRetry.ts'), 'utf8');
  expect(after).toBe(RETRY.replace('i < MAX_ATTEMPTS', 'i < MAX_TRIES'));
  expect(readFileSync(join(repo, 'README.md'), 'utf8')).toContain('MAX_ATTEMPTS');

  // Clicking a result opens the file at that line.
  await panel.getByRole('list', { name: 'Matches in README.md' }).getByRole('button', { name: /^Line 3/ }).click();
  await expect(page.getByRole('tab', { name: /README\.md/ })).toHaveAttribute('aria-selected', 'true');
});

test('no console errors', async () => {
  expect(ctx.consoleErrors).toEqual([]);
});
