import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './app';

/**
 * Files changes view in the built app (main's `files.original` from git, Monaco's diff editor): a
 * file with uncommitted changes opens on its changes, unified; Split shows them side by side; the
 * right side stays editable and Ctrl/Cmd+S saves it; File shows the plain editor.
 */

let ctx: LaunchedApp;
let repo: string;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const shots = join(import.meta.dirname, '../test-results');
type Invoke = (command: string, input: unknown) => Promise<unknown>;

const BEFORE = `export const MAX_ATTEMPTS = 5;

export function delay(i: number): number {
  return 2 ** i * 100;
}
`;
const AFTER = `export const MAX_ATTEMPTS = 8;

export function delay(i: number): number {
  return Math.min(2 ** i * 100, 30_000);
}
`;

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'oide-e2e-diff-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/retry.ts'), BEFORE);
  writeFileSync(join(repo, 'src/plain.ts'), 'export const plain = 1;\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@oide.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
  writeFileSync(join(repo, 'src/retry.ts'), AFTER);
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

async function open(name: string): Promise<void> {
  const { page } = ctx;
  // Not from inside Monaco: there Ctrl/Cmd+K starts one of its chords.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press(`${mod}+K`);
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await expect(bar).toBeVisible();
  await page.keyboard.type(name);
  await expect(bar.getByRole('option').first()).toContainText(name);
  await page.keyboard.press('Enter');
  await expect(bar).toBeHidden();
  await expect(page.getByRole('tab', { name: new RegExp(name.replace('.', '\\.')) })).toHaveAttribute('aria-selected', 'true');
}

test('a changed file opens on its changes, unified or side by side, and stays editable', async () => {
  const { page } = ctx;
  await open('retry.ts');

  const group = page.getByRole('group', { name: 'Changes view' });
  await expect(group.getByRole('button', { name: 'Unified' })).toHaveAttribute('aria-pressed', 'true');
  const diff = page.getByTestId('monaco-diff-host');
  await expect(diff).toBeVisible();
  await expect(diff.locator('.monaco-diff-editor')).not.toHaveClass(/side-by-side/);
  // Unified: the removed line shows above the added one, in the same column.
  await expect(diff.locator('.editor.modified .view-lines:not(.line-delete)')).toContainText('MAX_ATTEMPTS = 8');
  await expect(diff).toContainText('MAX_ATTEMPTS = 5');
  await expect(page.getByText('vs last commit')).toBeVisible();
  await page.screenshot({ path: join(shots, 'files-diff-unified.png') });

  await group.getByRole('button', { name: 'Split' }).click();
  await expect(group.getByRole('button', { name: 'Split' })).toHaveAttribute('aria-pressed', 'true');
  await expect(diff.locator('.monaco-diff-editor')).toHaveClass(/side-by-side/);
  await expect(diff.locator('.editor.original .view-lines:not(.line-delete)')).toContainText('MAX_ATTEMPTS = 5');
  await expect(diff.locator('.editor.modified .view-lines:not(.line-delete)')).toContainText('MAX_ATTEMPTS = 8');
  await page.screenshot({ path: join(shots, 'files-diff-split.png') });

  // The right side is the file itself: type, save, and the file on disk changes.
  await diff.locator('.editor.modified .view-lines:not(.line-delete)').click();
  await page.keyboard.press(`${mod}+End`);
  await page.keyboard.type('// tuned');
  await expect(page.getByRole('tab', { name: /retry\.ts/ })).toContainText('●');
  await page.keyboard.press(`${mod}+S`);
  await expect.poll(() => readFileSync(join(repo, 'src/retry.ts'), 'utf8')).toContain('// tuned');

  // File: the plain editor, with the same content.
  await group.getByRole('button', { name: 'File' }).click();
  await expect(diff).toBeHidden();
  await expect(page.getByTestId('monaco-host')).toBeVisible();
  await expect(page.getByTestId('monaco-host').locator('.view-lines')).toContainText('// tuned');
});

test('a file without changes opens in the plain editor, with no changes view', async () => {
  const { page } = ctx;
  await open('plain.ts');
  await expect(page.getByTestId('monaco-host').locator('.view-lines')).toContainText('plain = 1');
  await expect(page.getByRole('group', { name: 'Changes view' })).toHaveCount(0);
  // Back to the changed file's tab: it keeps the view picked for it.
  await open('retry.ts');
  await expect(page.getByRole('group', { name: 'Changes view' }).getByRole('button', { name: 'File' })).toHaveAttribute('aria-pressed', 'true');
});

test('no console errors', async () => {
  expect(ctx.consoleErrors).toEqual([]);
});
