import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FAKE_CLAUDE, launchApp, type LaunchedApp } from './app';

/**
 * 2026-11-25: a live agent vanished from the Wall after the window reloaded. Reloading the window
 * (`webContents.reload()`) must bring every tile back from main. Then the Archived view: archive a
 * finished agent from its tile, find it in Wall › Archived, unarchive it back onto the Wall.
 */

let ctx: LaunchedApp;
let repo: string;
type Invoke = (command: string, input: unknown) => Promise<unknown>;

const invokeIn = (page: Page) => (command: string, input: unknown) =>
  page.evaluate(([c, i]) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke(c as string, i), [command, input] as const);

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'oide-e2e-archive-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'config', 'user.name', 'oIDE E2E');
  gitIn(repo, 'config', 'user.email', 'e2e@oide.invalid');
  gitIn(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  ctx = await launchApp({ OIDE_CLAUDE_PATH: FAKE_CLAUDE, OIDE_E2E_TRUST: 'trust', OIDE_E2E_OPEN_PATHS: repo, OIDE_E2E_CONFIRM: 'accept' });
});

test.afterAll(async () => {
  await ctx?.close();
  await rm(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('reloading the window rehydrates every tile, including a live working agent', async () => {
  const { page, app } = ctx;
  const invoke = invokeIn(page);
  await invoke('settings.update', { patch: { claude: { extraFlags: '--fake-scenario basic' } } });
  const project = (await invoke('projects.open', { path: repo })) as { id: string };
  // One agent stays at work (waiting on its permission prompt), one finishes its turn.
  const [working] = (await invoke('agents.spawn', { projectId: project.id, title: 'Live worker', goal: 'Run the tests [fake-scenario:permission]', mode: 'acceptEdits', strategy: { kind: 'single', lead: { model: 'sonnet' } } })) as Array<{ id: string }>;
  const [idle] = (await invoke('agents.spawn', { projectId: project.id, title: 'Idle helper', goal: 'Say hi', mode: 'acceptEdits', strategy: { kind: 'single', lead: { model: 'sonnet' } } })) as Array<{ id: string }>;
  await expect(page.getByRole('group', { name: 'Permission: Run npm test' })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(`article[data-agent-id="${idle!.id}"][data-status="has-question"]`)).toBeVisible({ timeout: 30_000 });

  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.reload());
  await page.waitForLoadState('domcontentloaded');

  await expect(page.locator(`article[data-agent-id="${working!.id}"]`)).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(`article[data-agent-id="${idle!.id}"]`)).toBeVisible();
  await expect(page.getByRole('group', { name: 'Permission: Run npm test' })).toBeVisible();
  await expect(page.getByText('No agents yet')).toHaveCount(0);
  // Same live process: still waiting on the same prompt in main.
  const list = (await invokeIn(page)('agents.list', undefined)) as Array<{ id: string; status: string }>;
  expect(list.find((a) => a.id === working!.id)?.status).toBe('needs-permission');
});

test('archive from a tile and from Focus → Wall › Archived → search → unarchive back onto the Wall', async () => {
  const { page } = ctx;
  const invoke = invokeIn(page);
  const all = (await invoke('agents.list', undefined)) as Array<{ id: string; title: string }>;
  const idle = all.find((a) => a.title === 'Idle helper')!;
  // A stopped tile has Archive in its footer.
  const worker = all.find((a) => a.title === 'Live worker')!;
  await invoke('agents.stop', { agentId: worker.id });
  const workerTile = page.locator(`article[data-agent-id="${worker.id}"]`);
  await workerTile.getByRole('button', { name: `Archive ${worker.title}` }).click();
  await expect(workerTile).toHaveCount(0);
  const tile = page.locator(`article[data-agent-id="${idle.id}"]`);
  // The question tile's footer is its reply box: open Focus (click the title) and archive from its header.
  await tile.locator('h2').click();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  // Focus stays on it, now read-only.
  await expect(page.getByText(/This agent is archived; its transcript is read-only/)).toBeVisible();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(tile).toHaveCount(0);

  const archivedTab = page.getByRole('radio', { name: 'Archived (2)' });
  await expect(archivedTab).toBeVisible();
  await archivedTab.click();
  const row = page.getByRole('article', { name: /Idle helper, Archived/ });
  await expect(row).toBeVisible();
  await page.getByLabel('Search archived agents').fill('nothing like this');
  await expect(page.getByText(/No archived agents match/)).toBeVisible();
  await page.getByLabel('Search archived agents').fill('idle');
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: `Unarchive ${idle.title}` }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole('radio', { name: /^Active/ }).click();
  await expect(tile).toBeVisible();
  expect(((await invoke('agents.listArchived', {})) as { total: number }).total).toBe(1);
});

test('no console errors', async () => {
  expect(ctx.consoleErrors.filter((m) => !/Content Security Policy/.test(m))).toEqual([]);
});
