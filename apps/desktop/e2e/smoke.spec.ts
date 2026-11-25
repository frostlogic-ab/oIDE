import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './app';

let ctx: LaunchedApp;

test.beforeAll(async () => {
  ctx = await launchApp();
});

test.afterAll(async () => {
  await ctx?.close();
});

test('window opens with title oIDE and the frame', async () => {
  const { page, app } = ctx;
  await expect(page).toHaveTitle('oIDE');
  await expect(page.getByRole('banner')).toContainText('oIDE');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('contentinfo')).toContainText('session');

  const win = await app.browserWindow(page);
  const prefs = await win.evaluate((w) => {
    const p = w.webContents.getLastWebPreferences();
    const [minW, minH] = w.getMinimumSize();
    return { contextIsolation: p?.contextIsolation, sandbox: p?.sandbox, nodeIntegration: p?.nodeIntegration, webSecurity: p?.webSecurity, minW, minH };
  });
  expect(prefs).toEqual({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, minW: 1100, minH: 700 });

  mkdirSync(join(import.meta.dirname, '../test-results'), { recursive: true });
  await win.evaluate((w) => w.setContentSize(1440, 900));
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(import.meta.dirname, '../test-results/wall-frame.png') });
});

test('renderer is isolated: no Node, only window.oide, strict CSP', async () => {
  const { page } = ctx;
  const probe = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const oide = w.oide as Record<string, unknown> | undefined;
    return {
      require: typeof w.require,
      process: typeof w.process,
      module: typeof w.module,
      ipcRenderer: typeof w.ipcRenderer,
      electron: typeof w.electron,
      oideKeys: oide ? Object.keys(oide).sort() : [],
      csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') ?? '',
    };
  });
  expect(probe.require).toBe('undefined');
  expect(probe.process).toBe('undefined');
  expect(probe.module).toBe('undefined');
  expect(probe.ipcRenderer).toBe('undefined');
  expect(probe.electron).toBe('undefined');
  // attachDropped: paths of real dropped File objects only (preload-only drop channel), see screen-focus.md.
  expect(probe.oideKeys).toEqual(['attachDropped', 'invoke', 'on', 'platform']);

  // Code handed to page.evaluate itself bypasses CSP (DevTools protocol), so probe with code the
  // page would run on its own: a string timer (needs 'unsafe-eval') and an inline <script>.
  const blocked = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
    (setTimeout as unknown as (code: string, ms: number) => void)('window.__evalRan = 1', 0);
    const s = document.createElement('script');
    s.textContent = 'window.__inlineRan = 1';
    document.head.append(s);
    await new Promise((r) => setTimeout(r, 100));
    return { evalRan: w.__evalRan === 1, inlineRan: w.__inlineRan === 1, violations };
  });
  expect(blocked.evalRan).toBe(false);
  expect(blocked.inlineRan).toBe(false);
  expect(blocked.violations.length).toBeGreaterThanOrEqual(2);
  // Those two violations are expected console errors; drop them from the console check.
  ctx.consoleErrors.splice(0, ctx.consoleErrors.length, ...ctx.consoleErrors.filter((m) => !/Content Security Policy/.test(m)));
  expect(probe.csp).toContain("script-src 'self'");
  expect(probe.csp).not.toContain('unsafe-eval');
});

test('IPC: app.info works, error codes cross IPC', async () => {
  const { page } = ctx;
  const res = await page.evaluate(async () => {
    const oide = (window as unknown as { oide: { invoke(c: string, i: unknown): Promise<unknown> } }).oide;
    const info = (await oide.invoke('app.info', undefined)) as { version: string };
    let notFound = '';
    try {
      await oide.invoke('git.worktrees', { projectId: 'x' });
    } catch (e) {
      notFound = (e as Error).message;
    }
    let invalid = '';
    try {
      await oide.invoke('shell.openExternal', { url: 'not a url' });
    } catch (e) {
      invalid = (e as Error).message;
    }
    let forbidden = '';
    try {
      await oide.invoke('shell.openExternal', { url: 'http://example.com' });
    } catch (e) {
      forbidden = (e as Error).message;
    }
    return { version: info.version, notFound, invalid, forbidden };
  });
  expect(res.version).toMatch(/\d+\.\d+\.\d+/);
  expect(res.notFound).toMatch(/^\[not_found\]/);
  expect(res.invalid).toMatch(/^\[invalid_input\]/);
  expect(res.forbidden).toMatch(/^\[forbidden\]/);
});

test('rail navigation moves aria-current and swaps the screen', async () => {
  const { page } = ctx;
  const rail = page.getByRole('navigation', { name: 'Primary' });
  await expect(rail.getByRole('button', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');

  await rail.getByRole('button', { name: 'Files' }).click();
  await expect(rail.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-current', 'page');
  await expect(rail.getByRole('button', { name: 'Agents' })).not.toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('radiogroup', { name: 'Project scope' })).toBeVisible();

  await rail.getByRole('button', { name: 'Settings' }).click();
  await expect(rail.getByRole('button', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('navigation', { name: 'Settings' })).toBeVisible();

  await page.keyboard.press('Alt+ArrowLeft');
  await expect(rail.getByRole('button', { name: 'Files' })).toHaveAttribute('aria-current', 'page');

  await rail.getByRole('button', { name: 'Agents' }).click();
  await expect(rail.getByRole('button', { name: 'Agents' })).toHaveAttribute('aria-current', 'page');
});

test('Ctrl+K opens the command bar and runs a navigation command', async () => {
  const { page } = ctx;
  await page.locator('body').click({ position: { x: 700, y: 400 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('option', { name: /Spawn an agent/ })).toBeVisible();
  await expect(bar.getByRole('option', { name: /Jump to session/ })).toBeVisible();

  await page.keyboard.type('marketpl');
  await expect(bar.getByRole('option').first()).toContainText('Go to Marketplace');
  await page.keyboard.press('Enter');
  await expect(bar).toBeHidden();
  await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: /marketplace/i })).toHaveAttribute('aria-current', 'page');

  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await expect(bar).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bar).toBeHidden();
});

test('no console errors', async () => {
  expect(ctx.consoleErrors).toEqual([]);
});
