import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './app';

/**
 * Files language servers in the built app (ADR 0019): the built-in Languages extension starts
 * `typescript-language-server` from PATH, here a shim that runs the fixture server
 * (src/main/services/lsp/fixtures/fake-lsp.mjs). Opening a .ts file shows its diagnostics in the
 * tree and the Problems list, the file status bar shows the server running, and hovering a word shows
 * the server's hover.
 */

let ctx: LaunchedApp;
let repo: string;
let bin: string;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const shots = join(import.meta.dirname, '../test-results');
const fixture = join(import.meta.dirname, '../src/main/services/lsp/fixtures/fake-lsp.mjs');
type Invoke = (command: string, input: unknown) => Promise<unknown>;

const APP = `export function greet(name: string) {
  return 'hello ' + name; // ERR: the fixture reports this line
}
`;

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'oide-e2e-lsp-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/app.ts'), APP);
  gitIn(repo, 'add', '-A');
  gitIn(repo, '-c', 'user.name=e2e', '-c', 'user.email=e2e@oide.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');

  // A `typescript-language-server` on PATH that is the fixture server.
  bin = mkdtempSync(join(tmpdir(), 'oide-e2e-lsp-bin-'));
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'typescript-language-server.cmd'), `@"${process.execPath}" "${fixture}" %*\r\n`);
  } else {
    const sh = join(bin, 'typescript-language-server');
    writeFileSync(sh, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`);
    chmodSync(sh, 0o755);
  }
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  ctx = await launchApp({ OIDE_E2E_TRUST: 'trust', OIDE_E2E_OPEN_PATHS: repo, [pathKey]: `${bin}${delimiter}${process.env[pathKey] ?? ''}` });
  const win = await ctx.app.browserWindow(ctx.page);
  await win.evaluate((w) => w.setContentSize(1440, 900));
  await ctx.page.evaluate((path) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke('projects.open', { path }), repo);
  mkdirSync(shots, { recursive: true });
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  rmSync(bin, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('a .ts file gets its language server: diagnostics in the tree and Problems, hover in the editor', async () => {
  const { page } = ctx;
  await page.locator('body').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press(`${mod}+K`);
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await expect(bar).toBeVisible();
  await page.keyboard.type('app.ts');
  await expect(bar.getByRole('option', { name: /app\.ts/ }).first()).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /app\.ts/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('greet');

  // The server runs and its diagnostics reach the file status bar, the tree and the Problems list.
  await expect(page.getByRole('button', { name: 'Language server: TypeScript language server' })).toHaveAttribute('data-lsp-state', 'running', { timeout: 20_000 });
  await expect(page.getByRole('button', { name: '1 error. Go to the next problem' })).toBeVisible();
  const tree = page.getByRole('tree', { name: /\(main\)/ });
  await expect(tree.getByRole('treeitem', { name: /^app\.ts\s*, 1 error/ })).toBeVisible();
  const problems = page.getByRole('region', { name: 'Problems' });
  await expect(problems).toContainText('ERR on line 2');

  // Hover: the fixture answers with the word under the pointer, in bold.
  // Monaco shows a hover after the pointer rests on a word; under load one move can be missed, so
  // move off and back on until it shows.
  await expect(async () => {
    const word = await page.locator('.monaco-editor .view-lines span', { hasText: /^greet$/ }).first().boundingBox();
    if (!word) throw new Error('greet is not on screen');
    await page.mouse.move(word.x - 40, word.y + 60);
    await page.mouse.move(word.x + word.width / 2, word.y + word.height / 2, { steps: 8 });
    await expect(page.locator('.monaco-hover:not(.hidden)').first()).toContainText('greet', { timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await page.screenshot({ path: join(shots, 'files-lsp-hover.png') });
});
