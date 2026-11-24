import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLAUDE, launchApp, type LaunchedApp } from './app';

/**
 * Extension UI contributions in the real app: the built-in Browser preview panel opens as a tab in
 * Focus's inspector, in a sandboxed oide-ext:// iframe, and talks to its host code only through the
 * panel bridge. Its default URL comes from Settings › Extensions.
 */

let ctx: LaunchedApp;
let repo: string;
let site: Server;
let devUrl = '';

type Invoke = (command: string, input: unknown) => Promise<unknown>;
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'oide-e2e-ext-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'oIDE E2E');
  git('config', 'user.email', 'e2e@oide.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  // A stand-in for the agent's dev server.
  site = createServer((_req, res) =>
    res
      .writeHead(200, { 'content-type': 'text/html' })
      .end('<!doctype html><title>Dev app</title><h1 id="dev">Hello from the dev server</h1>'),
  );
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  devUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  // OIDE_E2E_OPEN_PATHS: the test-only stand-in for a folder-picker pick (SEC-08).
  ctx = await launchApp({ OIDE_CLAUDE_PATH: FAKE_CLAUDE, OIDE_E2E_TRUST: 'trust', OIDE_E2E_OPEN_PATHS: repo });
});

test.afterAll(async () => {
  await ctx?.close();
  site?.closeAllConnections();
  site?.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('Browser preview opens in Focus’s inspector, sandboxed, and talks to its host code', async () => {
  const { page } = ctx;
  const invoke = (command: string, input: unknown) =>
    page.evaluate(
      ([c, i]) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke(c as string, i),
      [command, input] as const,
    );

  const installed = (await invoke('extensions.installed', undefined)) as Array<{ name: string }>;
  expect(installed.map((e) => e.name)).toEqual(
    expect.arrayContaining(['@oide/ext-browser-preview', '@oide/ext-themes', '@oide/ext-git']),
  );

  // Settings › Extensions: the panel's default URL.
  const rail = page.getByRole('navigation', { name: 'Primary' });
  await rail.getByRole('button', { name: 'Settings' }).click();
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Extensions' })
    .click();
  const field = page.getByRole('textbox', { name: 'browserPreview.defaultUrl' });
  await expect(field).toHaveValue('http://localhost:3000');
  await field.fill(devUrl);
  await field.press('Enter');
  await expect
    .poll(
      async () =>
        (
          (await invoke('extensions.settings', { id: '@oide/ext-browser-preview' })) as Array<{
            value?: string;
          }>
        )[0]?.value,
    )
    .toBe(devUrl);

  // An agent to show the panel for.
  const project = (await invoke('projects.open', { path: repo })) as { id: string };
  const [agent] = (await invoke('agents.spawn', {
    projectId: project.id,
    title: 'Preview the app',
    goal: 'Check the dev server',
    mode: 'acceptEdits',
    strategy: { kind: 'single', lead: { model: 'sonnet' } },
  })) as Array<{ id: string }>;
  expect(agent).toBeTruthy();

  // Jump to it in Focus.
  await rail.getByRole('button', { name: 'Agents' }).click();
  await page.keyboard.press(`${mod}+K`);
  const bar = page.getByRole('dialog', { name: 'Command bar' });
  await page.keyboard.type('Jump to session');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Preview the app');
  await expect(bar.getByRole('option').first()).toContainText('Preview the app');
  await page.keyboard.press('Enter');
  const inspector = page.getByRole('complementary', { name: 'Inspector' });
  await expect(inspector).toBeVisible();

  // The Preview tab: a sandboxed iframe on oide-ext://, opaque origin.
  await inspector.getByRole('tab', { name: 'Preview' }).click();
  const iframe = inspector.locator('iframe[title="Preview"]');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  await expect(iframe).toHaveAttribute('src', /^oide-ext:\/\/x[0-9a-f]{24}\/dist\/panel\.html$/);
  const panel = page.frameLocator('iframe[title="Preview"]');

  // panel → bridge → host code (started on demand) → bridge → panel: the saved default URL.
  await expect(panel.getByRole('textbox', { name: 'Local URL' })).toHaveValue(devUrl, { timeout: 20_000 });

  const frame = page.frames().find((f) => f.url().startsWith('oide-ext://'));
  expect(frame).toBeTruthy();
  const probe = await frame!.evaluate(async (url) => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => violations.push(e.violatedDirective));
    let parentOide: string;
    try {
      parentOide = typeof (window.parent as unknown as { oide?: unknown }).oide;
    } catch {
      parentOide = 'blocked';
    }
    // The dev server is up, and no-cors would reach it: only the panel's CSP stops this.
    let fetched: string;
    try {
      await fetch(url, { mode: 'no-cors' });
      fetched = 'reached';
    } catch {
      fetched = 'blocked';
    }
    await new Promise((r) => setTimeout(r, 50));
    return { origin: window.origin, oide: typeof (window as unknown as { oide?: unknown }).oide, parentOide, fetched, violations };
  }, devUrl);
  // Each policy that blocks it reports once (the served header, and the panel's own <meta>).
  expect(probe).toMatchObject({ origin: 'null', oide: 'undefined', parentOide: 'blocked', fetched: 'blocked' });
  expect(new Set(probe.violations)).toEqual(new Set(['connect-src']));

  // A contributed command in Ctrl K runs in the host and navigates the open panel (host → panel).
  await page.keyboard.press(`${mod}+K`);
  await page.keyboard.type('Open browser preview');
  await expect(bar.getByRole('option').first()).toContainText('Open browser preview');
  await page.keyboard.press('Enter');
  await expect(bar).toBeHidden();
  const view = panel.locator('iframe#view');
  await expect(view).toHaveAttribute('src', devUrl);
  await expect(panel.frameLocator('iframe#view').locator('#dev')).toHaveText('Hello from the dev server');

  await page.screenshot({ path: join(import.meta.dirname, '../test-results/focus-browser-preview.png') });
  await invoke('agents.stop', { agentId: agent!.id }).catch(() => undefined);
});

test('no console errors', async () => {
  // The fetch probe above is refused by the panel's CSP (connect-src 'none'); that report is expected.
  expect(
    ctx.consoleErrors.filter((m) => !/Content Security Policy|ERR_BLOCKED_BY_CSP|Failed to fetch/.test(m)),
  ).toEqual([]);
});
