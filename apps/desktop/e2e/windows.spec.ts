import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './app';

/** Several windows on one profile (docs/wiki/pages/windows.md, ADR 0019). */

let ctx: LaunchedApp;
type Invoke = (command: string, input: unknown) => Promise<unknown>;

const invokeIn = (page: Page) => (command: string, input: unknown) =>
  page.evaluate(([c, i]) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke(c as string, i), [command, input] as const);

const windowCount = () => ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test.beforeAll(async () => {
  ctx = await launchApp();
  await expect(ctx.page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
});

test.afterAll(async () => {
  await ctx?.close();
});

test('Ctrl/Cmd+Shift+N opens a second window on the same profile, cascaded from the first', async () => {
  const { app, page } = ctx;
  const first = await app.browserWindow(page);
  await first.evaluate((w) => {
    w.unmaximize();
    w.setBounds({ x: 40, y: 40, width: 1200, height: 760 });
  });
  const opened = app.waitForEvent('window');
  await page.bringToFront();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+N' : 'Control+Shift+N');
  const second = await opened;
  await second.waitForLoadState('domcontentloaded');
  await expect(second).toHaveTitle('oIDE');
  await expect(second.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  expect(await windowCount()).toBe(2);

  const bounds = await (await app.browserWindow(second)).evaluate((w) => w.getBounds());
  expect(bounds).toMatchObject({ x: 68, y: 68, width: 1200, height: 760 });

  // One profile: a settings change made in the new window reaches the first one as an event.
  const changed = page.evaluate(
    () =>
      new Promise<string>((resolve) => {
        const oide = (window as unknown as { oide: { on(e: string, cb: (s: { ui: { accent: string } }) => void): () => void } }).oide;
        const off = oide.on('settings.changed', (s) => {
          off();
          resolve(s.ui.accent);
        });
      }),
  );
  await invokeIn(second)('settings.update', { patch: { ui: { accent: '#7FC8A9' } } });
  expect(await changed).toBe('#7FC8A9');
  expect(((await invokeIn(page)('settings.get', undefined)) as { ui: { accent: string } }).ui.accent).toBe('#7FC8A9');

  // Closing one window leaves the app and the other window running.
  await (await app.browserWindow(second)).evaluate((w) => w.close());
  await expect.poll(windowCount).toBe(1);
  expect(((await invokeIn(page)('app.info', undefined)) as { version: string }).version).toBeTruthy();
});

test('"New window" in the command bar opens a window', async () => {
  const { app } = ctx;
  const opened = app.waitForEvent('window');
  await invokeIn(ctx.page)('app.newWindow', { from: 'command' });
  const win = await opened;
  await win.waitForLoadState('domcontentloaded');
  expect(await windowCount()).toBe(2);
  await (await app.browserWindow(win)).evaluate((w) => w.close());
  await expect.poll(windowCount).toBe(1);
});

test('starting oIDE again on the same profile opens a window in the running app and exits cleanly', async () => {
  const { app } = ctx;
  const execPath = await app.evaluate(() => process.execPath);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env.OIDE_USER_DATA = ctx.userData;
  env.OIDE_TELEMETRY = '0';
  const opened = app.waitForEvent('window');
  const appDir = join(import.meta.dirname, '..');
  const child = spawn(execPath, [join(appDir, 'out/main/index.js'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], { cwd: appDir, env });
  let output = '';
  child.stdout.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr.on('data', (d: Buffer) => (output += d.toString()));
  const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  expect(code).toBe(0);
  expect(output).toContain('opened a new window there');
  // It quits before Chromium opens the locked profile (the old "Unable to move the cache" line).
  expect(output).not.toMatch(/Unable to move the cache/);
  const win = await opened;
  await win.waitForLoadState('domcontentloaded');
  await expect(win).toHaveTitle('oIDE');
  expect(await windowCount()).toBe(2);
});
