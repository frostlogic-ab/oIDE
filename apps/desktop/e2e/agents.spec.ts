import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLAUDE, launchApp, type LaunchedApp } from './app';

/**
 * Real Electron main process + renderer, with tools/fake-claude as the CLI (OIDE_CLAUDE_PATH) and
 * the trust dialog answered by OIDE_E2E_TRUST. The project is opened at the IPC level because the
 * native folder picker cannot be driven from Playwright.
 */

let ctx: LaunchedApp;
let repo: string;

type Invoke = (command: string, input: unknown) => Promise<unknown>;

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'oide-e2e-repo-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'config', 'user.name', 'oIDE E2E');
  gitIn(repo, 'config', 'user.email', 'e2e@oide.invalid');
  gitIn(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  ctx = await launchApp({ OIDE_CLAUDE_PATH: FAKE_CLAUDE, OIDE_E2E_TRUST: 'trust' });
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('open project → spawn → tile shows the permission prompt → allow → ready for review', async () => {
  const { page } = ctx;
  const invoke = (command: string, input: unknown) =>
    page.evaluate(([c, i]) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke(c as string, i), [command, input] as const);

  const cli = (await invoke('cli.detect', undefined)) as { found: boolean; version?: string };
  expect(cli).toMatchObject({ found: true, version: '2.1.325' });

  await invoke('settings.update', { patch: { claude: { extraFlags: '--fake-scenario review' } } });
  const project = (await invoke('projects.open', { path: repo })) as { id: string; trusted: boolean; name: string };
  expect(project.trusted).toBe(true);

  const [agent] = (await invoke('agents.spawn', {
    projectId: project.id,
    title: 'E2E feature',
    goal: 'Add feature.txt and run the tests',
    mode: 'acceptEdits',
    strategy: { kind: 'single', lead: { model: 'sonnet' } },
  })) as Array<{ id: string }>;

  // The Wall tile shows the inline permission prompt from the oIDE MCP server.
  const prompt = page.getByRole('group', { name: 'Permission: Run npm test' });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await prompt.getByRole('button', { name: /Allow once/ }).click();

  await expect
    .poll(async () => ((await invoke('agents.list', undefined)) as Array<{ id: string; status: string }>).find((a) => a.id === agent!.id)?.status, { timeout: 30_000 })
    .toBe('ready-for-review');
  await expect(page.getByText('Ready for review').first()).toBeVisible();

  const diff = (await invoke('git.diff', { agentId: agent!.id })) as Array<{ path: string }>;
  expect(diff.map((d) => d.path)).toContain('feature.txt');
  const preview = (await invoke('artifacts.previewUrl', { id: ((await invoke('artifacts.create', { title: 'E2E page', kind: 'design', content: '<h1>ok</h1>' })) as { id: string }).id })) as { url: string };
  expect(preview.url).toMatch(/^oide-artifact:\/\/[^/]+\/index\.html$/);
});

test('artifact preview protocol serves the artifact and blocks network', async () => {
  const { page } = ctx;
  const result = await page.evaluate(async () => {
    const oide = (window as unknown as { oide: { invoke: Invoke } }).oide;
    const meta = (await oide.invoke('artifacts.create', { title: 'Preview test', kind: 'design', content: '<!doctype html><title>t</title><h1 id="h">served</h1>' })) as { id: string };
    const { url } = (await oide.invoke('artifacts.previewUrl', { id: meta.id })) as { url: string };
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts');
    frame.src = url;
    const loaded = new Promise<void>((r) => frame.addEventListener('load', () => r()));
    document.body.append(frame);
    await loaded;
    frame.remove();
    return { url, loaded: true };
  });
  expect(result.loaded).toBe(true);
  // The response carries the no-network CSP.
  const res = await ctx.app.evaluate(async ({ net }, url) => {
    const r = await net.fetch(url);
    return { status: r.status, csp: r.headers.get('content-security-policy'), body: await r.text() };
  }, result.url);
  expect(res.status).toBe(200);
  expect(res.body).toContain('served');
  expect(res.csp).toContain("connect-src 'none'");
  const escape = await ctx.app.evaluate(async ({ net }, url) => (await net.fetch(url.replace('index.html', '..%2F..%2Foide.db'))).status, result.url);
  expect(escape).toBe(404);
});

test('no console errors', async () => {
  expect(ctx.consoleErrors.filter((m) => !/Content Security Policy/.test(m))).toEqual([]);
});
