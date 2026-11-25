import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FAKE_CLAUDE, launchApp, type LaunchedApp } from './app';

/**
 * Merge conflicts go back to the agent, as the user sees it: real Electron main + renderer with
 * tools/fake-claude. A change on main conflicts with the agent's commit; the merge dialog predicts
 * it, "Ask <agent> to resolve" sends the conflicts as a message from oIDE, the fake agent merges
 * main in its worktree (resolve-conflicts scenario) and submits again, and the dialog then
 * predicts a clean merge. Nothing is merged until the user clicks Merge.
 */

let ctx: LaunchedApp;
let repo: string;

type Invoke = (command: string, input: unknown) => Promise<unknown>;
type Agent = { id: string; status: string; title: string; pendingPermission?: { requestId: string }; mergeConflict?: { files: string[] } };

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'oide-e2e-conflicts-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'oIDE E2E');
  git('config', 'user.email', 'e2e@oide.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  ctx = await launchApp({ OIDE_CLAUDE_PATH: FAKE_CLAUDE, OIDE_E2E_TRUST: 'trust', OIDE_E2E_OPEN_PATHS: repo, OIDE_E2E_CONFIRM: 'accept' });
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

const invoker = (page: Page) => (command: string, input: unknown) =>
  page.evaluate(([c, i]) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke(c as string, i), [command, input] as const);

async function agentOf(page: Page, id: string): Promise<Agent | undefined> {
  return ((await invoker(page)('agents.list', undefined)) as Agent[]).find((a) => a.id === id);
}

/** Poll until `status`, allowing the agent's tool calls over IPC (the Wall's own prompt is covered by agents.spec). */
async function settle(page: Page, id: string, status: string): Promise<void> {
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        const a = await agentOf(page, id);
        const p = a?.pendingPermission;
        if (a?.status === 'needs-permission' && p && !seen.has(p.requestId)) {
          seen.add(p.requestId);
          await invoker(page)('agents.answerPermission', { agentId: id, answer: { requestId: p.requestId, behavior: 'allow' } }).catch(() => undefined);
        }
        return a?.status;
      },
      { timeout: 45_000 },
    )
    .toBe(status);
}

async function openReview(page: Page, id: string, title: string) {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Agents' }).click();
  await page.locator(`article[data-agent-id="${id}"]`).getByRole('heading', { name: title }).click();
  await page.getByRole('tab', { name: 'Changes' }).click();
  await page.getByRole('button', { name: 'Review all changes' }).click();
}

test('a predicted conflict goes back to the agent, which resolves it; then the merge is predicted clean', async () => {
  const { page } = ctx;
  const invoke = invoker(page);
  await invoke('settings.update', { patch: { claude: { extraFlags: '--fake-scenario commit-work' } } });
  const project = (await invoke('projects.open', { path: repo })) as { id: string };
  const [agent] = (await invoke('agents.spawn', {
    projectId: project.id,
    title: 'Conflicting work',
    goal: 'Commit one file',
    mode: 'acceptEdits',
    strategy: { kind: 'single', lead: { model: 'sonnet' } },
  })) as Agent[];
  await settle(page, agent!.id, 'ready-for-review');

  // Meanwhile main gets its own version of the file the agent committed.
  writeFileSync(join(repo, 'committed.txt'), 'main has its own version\n');
  git('add', 'committed.txt');
  git('commit', '-q', '-m', 'main: committed.txt');
  const head = git('rev-parse', 'HEAD');

  await openReview(page, agent!.id, 'Conflicting work');
  await page.getByRole('button', { name: /Merge worktree into main locally/ }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Merging will conflict in 1 file: committed.txt.');
  await expect(dialog.getByRole('button', { name: 'Merge anyway' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Ask Conflicting work to resolve' }).click();
  await expect(dialog).toBeHidden();

  // The message went to the agent, marked as sent by oIDE, and the agent is working on it.
  await expect.poll(async () => (await agentOf(page, agent!.id))?.status, { timeout: 15_000 }).not.toBe('ready-for-review');
  const events = (await invoke('agents.events', { agentId: agent!.id, limit: 5000 })) as Array<{ type: string; text?: string; origin?: string }>;
  const sent = events.find((e) => e.type === 'user-text' && e.origin === 'oide');
  expect(sent?.text).toContain(`\`main\` @ ${head.slice(0, 7)}`);
  expect(sent?.text).toContain('- "committed.txt"');
  expect(sent?.text).toContain('run `git merge main` inside your own worktree');

  // The fake agent merges main, keeps both sides, commits and submits again.
  await settle(page, agent!.id, 'ready-for-review');
  expect((await agentOf(page, agent!.id))?.mergeConflict).toBeUndefined();
  // Nothing was merged into main on its own.
  expect(git('rev-parse', 'HEAD')).toBe(head);

  // The user clicks Merge again: the dialog now predicts a clean merge.
  await page.getByRole('button', { name: /Merge worktree into main locally/ }).click();
  await expect(dialog).toContainText(`merges cleanly into main @ ${head.slice(0, 7)}`);
  await expect(dialog.getByRole('button', { name: /to resolve/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Merge', exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: /Merge status: Up to date with main/ })).toBeVisible();
});

test('no console errors', async () => {
  expect(ctx.consoleErrors.filter((m) => !/Content Security Policy/.test(m))).toEqual([]);
});
