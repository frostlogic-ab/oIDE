import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FAKE_CLAUDE, launchApp, type LaunchedApp } from './app';

/**
 * Crash isolation, end to end: an agent waits on a permission prompt, the renderer process is
 * killed, the window reloads by itself, the agent is still the same live process (its prompt is
 * still pending and answering it finishes the run), and the crash is in the main log. The
 * userData and project folders have spaces and non-ASCII characters on purpose.
 */

let ctx: LaunchedApp;
let repo: string;
type Invoke = (command: string, input: unknown) => Promise<unknown>;

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

const invokeIn = (page: Page) => (command: string, input: unknown) =>
  page.evaluate(([c, i]) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke(c as string, i), [command, input] as const);

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'oide e2e prój 文-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'config', 'user.name', 'oIDE E2E');
  gitIn(repo, 'config', 'user.email', 'e2e@oide.invalid');
  gitIn(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  // Test-only stand-ins for the folder pick (SEC-08) and the extra-flags confirmation (SEC-07).
  ctx = await launchApp({ OIDE_CLAUDE_PATH: FAKE_CLAUDE, OIDE_E2E_TRUST: 'trust', OIDE_E2E_OPEN_PATHS: repo, OIDE_E2E_CONFIRM: 'accept' }, { userDataPrefix: 'oide e2e data ünï-' });
});

test.afterAll(async () => {
  await ctx?.close();
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('Settings › Diagnostics reports checks without raw paths, and an error boundary report reaches the log', async () => {
  const { page } = ctx;
  const diag = (await invokeIn(page)('app.diagnostics', undefined)) as { checks: Array<{ id: string; status: string; value: string }>; report: string };
  expect(diag.checks.map((c) => c.id)).toEqual(expect.arrayContaining(['cli', 'git', 'gh', 'node', 'keychain', 'db', 'mcp', 'logs']));
  expect(diag.checks.find((c) => c.id === 'cli')?.status).toBe('ok');
  expect(diag.checks.find((c) => c.id === 'mcp')?.value).toMatch(/^127\.0\.0\.1:\d+$/);
  expect(diag.report).not.toContain(homedir());
  expect(diag.report).not.toContain(ctx.userData);

  await invokeIn(page)('app.reportError', { screen: 'files', name: 'TypeError', message: 'x is undefined', stack: 'at Foo (index.js:1:1)' });
  await expect.poll(() => readFileSync(join(ctx.userData, 'logs', 'renderer.log'), 'utf8'), { timeout: 5000 }).toContain('screen "files" crashed');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Diagnostics' }).click();
  await expect(page.getByRole('button', { name: 'Open logs folder' })).toBeVisible();
  await expect(page.getByText('oIDE MCP server')).toBeVisible();
});

test('killing the renderer never kills agents; the window reloads and rehydrates', async () => {
  const { page, app } = ctx;
  const invoke = invokeIn(page);
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Agents', exact: true }).click();
  await invoke('settings.update', { patch: { claude: { extraFlags: '--fake-scenario review' } } });
  const project = (await invoke('projects.open', { path: repo })) as { id: string };
  const [agent] = (await invoke('agents.spawn', {
    projectId: project.id,
    title: 'Crash survivor',
    goal: 'Add feature.txt and run the tests',
    mode: 'acceptEdits',
    strategy: { kind: 'single', lead: { model: 'sonnet' } },
  })) as Array<{ id: string }>;
  await expect(page.getByRole('group', { name: 'Permission: Run npm test' })).toBeVisible({ timeout: 30_000 });

  // Kill the renderer process. Main records the crash and the page load that follows it, so the
  // wait below is for the reload itself: right after the kill, `isCrashed()` can still read false
  // and the old URL is still set, which would let a plain state check pass before anything reloaded.
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    const g = globalThis as { __e2eReload?: { gone: boolean; loaded: boolean } };
    const state = { gone: false, loaded: false };
    g.__e2eReload = state;
    wc.once('render-process-gone', () => {
      state.gone = true;
      wc.once('did-finish-load', () => {
        state.loaded = true;
      });
    });
    wc.forcefullyCrashRenderer();
  });

  // Main reloads the page on its own; the stores rehydrate from agents.list.
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) => {
          const wc = BrowserWindow.getAllWindows()[0]!.webContents;
          const s = (globalThis as { __e2eReload?: { gone: boolean; loaded: boolean } }).__e2eReload;
          return { gone: s?.gone, loaded: s?.loaded, live: !wc.isCrashed() && !wc.isLoading() && wc.getURL().includes('index.html') };
        }),
      { timeout: 20_000 },
    )
    .toEqual({ gone: true, loaded: true, live: true });
  // Playwright keeps the Page marked as crashed (locators refuse to run), so the reloaded DOM is
  // read and driven through the window's webContents from main. Each call is capped at 3 s: a call
  // that lands on a frame being swapped can stay pending forever, which would stall a poll on its
  // first try instead of letting it try again.
  const inPage = <T,>(js: string) =>
    app.evaluate(
      ({ BrowserWindow }, code) =>
        Promise.race([
          BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(code) as Promise<T>,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('executeJavaScript timed out')), 3000)),
        ]),
      js,
    );
  const PROMPT = `document.querySelector('[role="group"][aria-label="Permission: Run npm test"]')`;
  // While the page is still swapping frames, executeJavaScript can throw; keep polling.
  await expect.poll(() => inPage<boolean>(`Boolean(${PROMPT})`).catch(() => false), { timeout: 20_000 }).toBe(true);

  // Same live process: the pending prompt is still answerable and the run completes.
  const list = await inPage<Array<{ id: string; status: string }>>(`window.oide.invoke('agents.list', undefined)`);
  expect(list.find((a) => a.id === agent!.id)?.status).toBe('needs-permission');
  await inPage(`[...${PROMPT}.querySelectorAll('button')].find((b) => /Allow once/.test(b.textContent)).click()`);
  await expect
    .poll(async () => (await inPage<Array<{ id: string; status: string }>>(`window.oide.invoke('agents.list', undefined)`)).find((a) => a.id === agent!.id)?.status, { timeout: 30_000 })
    .toBe('ready-for-review');

  // The crash is in the main log (rotating file log in <userData>/logs), redacted.
  await expect.poll(() => readFileSync(join(ctx.userData, 'logs', 'main.log'), 'utf8'), { timeout: 5000 }).toContain('renderer process gone');
  const mainLog = readFileSync(join(ctx.userData, 'logs', 'main.log'), 'utf8');
  expect(mainLog).not.toContain(homedir());
  expect(readFileSync(join(ctx.userData, 'logs', 'agents', `${agent!.id}.log`), 'utf8')).toMatch(/status .*needs-permission/);
});
