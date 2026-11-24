import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { FAKE_CLAUDE, launchApp, type LaunchedApp } from './app';

/**
 * Milestone gates, the UI-visible part (the full flows run in plain Node in test/gates/*). Real
 * Electron main + renderer, tools/fake-claude as the CLI. Projects are opened over IPC (the native
 * folder picker cannot be driven); everything asserted here is what the user sees.
 */

let ctx: LaunchedApp;
const repos: string[] = [];
/**
 * Repo folders are fixed before launch: OIDE_E2E_OPEN_PATHS (the test-only stand-in for a
 * folder-picker pick, SEC-08) lists the exact paths `projects.open` may take.
 */
const REPO_SLOTS = 8;
const root = mkdtempSync(join(tmpdir(), 'oide-e2e-gates-'));
const slots = Array.from({ length: REPO_SLOTS }, (_, i) => join(root, `repo-${i}`));

type Invoke = (command: string, input: unknown) => Promise<unknown>;
type Agent = { id: string; status: string; title: string; pendingPermission?: { requestId: string } };

function makeRepo(_prefix: string, files: Record<string, string> = {}): string {
  const repo = slots[repos.length];
  if (!repo) throw new Error(`gates.spec: more than ${REPO_SLOTS} repos; raise REPO_SLOTS`);
  mkdirSync(repo);
  repos.push(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'oIDE E2E');
  git('config', 'user.email', 'e2e@oide.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return repo;
}

const invoker = (page: Page) => (command: string, input: unknown) =>
  page.evaluate(([c, i]) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke(c as string, i), [
    command,
    input,
  ] as const);

async function agents(page: Page): Promise<Agent[]> {
  return (await invoker(page)('agents.list', undefined)) as Agent[];
}

/** Poll until the agent has `status`, allowing prompts over IPC (the Wall's own prompt is covered by agents.spec). */
async function settle(page: Page, id: string, status: string): Promise<void> {
  const seen = new Set<string>();
  await expect
    .poll(
      async () => {
        const a = (await agents(page)).find((x) => x.id === id);
        const p = a?.pendingPermission;
        if (a?.status === 'needs-permission' && p && !seen.has(p.requestId)) {
          seen.add(p.requestId);
          await invoker(page)('agents.answerPermission', {
            agentId: id,
            answer: { requestId: p.requestId, behavior: 'allow' },
          }).catch(() => undefined);
        }
        return a?.status;
      },
      { timeout: 30_000 },
    )
    .toBe(status);
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });

test.beforeAll(async () => {
  // OIDE_E2E_CONFIRM answers the native confirmation that extra CLI flags need (SEC-07).
  ctx = await launchApp({ OIDE_CLAUDE_PATH: FAKE_CLAUDE, OIDE_E2E_TRUST: 'trust', OIDE_E2E_OPEN_PATHS: slots.join(delimiter), OIDE_E2E_CONFIRM: 'accept' });
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('M4: Settings › Permissions shows the rules committed in the project .oide/', async () => {
  const { page } = ctx;
  const invoke = invoker(page);
  const repo = makeRepo('oide-e2e-m4-', {
    '.oide/permissions.json': JSON.stringify({
      version: 1,
      allow: ['Bash(npm test)'],
      ask: [],
      deny: ['Bash(rm -rf *)'],
    }),
  });
  const project = (await invoke('projects.open', { path: repo })) as {
    id: string;
    name: string;
    trusted: boolean;
  };
  expect(project.trusted).toBe(true);
  await rail(page).getByRole('button', { name: 'Settings' }).click();
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Permissions' })
    .click();
  await page.getByRole('combobox', { name: 'Rules for' }).selectOption({ label: project.name });
  await expect(page.getByRole('list', { name: `Always allowed in ${project.name}` })).toContainText(
    'npm test',
  );
  await expect(page.getByRole('list', { name: `Always denied in ${project.name}` })).toContainText(
    'rm -rf *',
  );
  await invoke('projects.remove', { projectId: project.id });
});

test('M6: a doc artifact written by an agent appears in Artifacts with "Agents using it", and the user edit is version 2', async () => {
  const { page } = ctx;
  const invoke = invoker(page);
  await invoke('settings.update', { patch: { claude: { extraFlags: '--fake-scenario artifacts' } } });
  const repo = makeRepo('oide-e2e-m6-');
  const project = (await invoke('projects.open', { path: repo })) as { id: string };
  const design = (await invoke('artifacts.create', {
    title: 'Landing page',
    kind: 'design',
    projectId: project.id,
    content: '<h1>Hero</h1><h2>Pricing</h2>',
  })) as { id: string; title: string };
  const [agent] = (await invoke('agents.spawn', {
    projectId: project.id,
    title: 'E2E doc writer',
    goal: 'Write a doc from the design',
    context: [{ kind: 'artifact', id: design.id, title: design.title }],
    mode: 'default',
    strategy: { kind: 'single', lead: { model: 'sonnet' } },
  })) as Agent[];

  // Creating an artifact asks first: the user allows it on the Wall tile.
  await rail(page).getByRole('button', { name: 'Agents' }).click();
  const tile = page.locator(`article[data-agent-id="${agent!.id}"]`);
  const prompt = tile.getByRole('group', { name: /^Permission:/ });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await prompt.getByRole('button', { name: /Allow once/ }).click();
  await settle(page, agent!.id, 'has-question');

  await rail(page).getByRole('button', { name: 'Artifacts' }).click();
  const grid = page.getByRole('tabpanel', { name: 'Artifacts' });
  const card = grid.getByRole('button', { name: /Notes on Landing page/ });
  await expect(card).toBeVisible();
  await card.click();
  const details = page.getByRole('complementary', { name: 'Artifact details' });
  const users = details.getByRole('region', { name: 'Agents using it' });
  await expect(users.getByRole('link', { name: /E2E doc writer/ })).toBeVisible();
  await expect(users).toContainText('writes');

  // The user edits it (Viewer save goes through artifacts.save): History shows two versions.
  const doc = (
    (await invoke('artifacts.list', { projectId: project.id, kind: 'doc' })) as Array<{ id: string }>
  )[0]!;
  const got = (await invoke('artifacts.get', { id: doc.id })) as { content: string };
  expect(
    (
      (await invoke('artifacts.save', { id: doc.id, content: `${got.content}\nEdited.\n` })) as {
        version: number;
      }
    ).version,
  ).toBe(2);
  await rail(page).getByRole('button', { name: 'Agents' }).click();
  await rail(page).getByRole('button', { name: 'Artifacts' }).click();
  await grid.getByRole('button', { name: /Notes on Landing page/ }).click();
  // One entry per version (the region also holds "Compare versions").
  await expect(details.getByRole('region', { name: 'History' }).getByRole('listitem')).toHaveCount(2);

  // The design shows the agent as a reader.
  await grid
    .getByRole('button', { name: /Landing page/ })
    .filter({ hasNotText: 'Notes on' })
    .click();
  await expect(details.getByRole('region', { name: 'Agents using it' })).toContainText('reads');
});

test('M3: Review lists the agent commit and its uncommitted change', async () => {
  const { page } = ctx;
  const invoke = invoker(page);
  await invoke('settings.update', {
    patch: { claude: { extraFlags: '--fake-scenario commit-work,address-feedback' } },
  });
  const repo = makeRepo('oide-e2e-m3-');
  const project = (await invoke('projects.open', { path: repo })) as { id: string };
  const [agent] = (await invoke('agents.spawn', {
    projectId: project.id,
    title: 'E2E committer',
    goal: 'Commit one file, leave one',
    mode: 'acceptEdits',
    strategy: { kind: 'single', lead: { model: 'sonnet' } },
  })) as Agent[];
  await settle(page, agent!.id, 'ready-for-review');

  await rail(page).getByRole('button', { name: 'Agents' }).click();
  await page
    .locator(`article[data-agent-id="${agent!.id}"]`)
    .getByRole('heading', { name: 'E2E committer' })
    .click();
  await page.getByRole('tab', { name: 'Changes' }).click();
  await page.getByRole('button', { name: 'Review all changes' }).click();
  const files = page
    .getByRole('complementary', { name: 'Changed files' })
    .getByRole('list', { name: 'Files' });
  await expect(files).toContainText('committed.txt');
  await expect(files).toContainText('pending.txt');
  await expect(page.getByRole('button', { name: /Merge worktree into .* locally/ })).toBeVisible();
});

test('M2: six agents across three projects; beyond Max running 3 they queue on the Wall', async () => {
  const { page } = ctx;
  const invoke = invoker(page);
  for (const a of await agents(page)) await invoke('agents.remove', { agentId: a.id, deleteWorktree: true });
  await invoke('settings.update', {
    patch: { claude: { extraFlags: '--fake-scenario slow' }, agents: { maxRunning: 3 } },
  });
  const projects = [];
  for (let i = 0; i < 3; i++)
    projects.push(
      (await invoke('projects.open', { path: makeRepo(`oide-e2e-m2-${i}-`) })) as {
        id: string;
        name: string;
      },
    );
  await invoke('scope.set', { scope: 'all' });
  const ids: string[] = [];
  for (let i = 0; i < 6; i++) {
    const [a] = (await invoke('agents.spawn', {
      projectId: projects[i % 3]!.id,
      title: `Wall agent ${i + 1}`,
      goal: 'Count slowly',
      mode: 'acceptEdits',
      strategy: { kind: 'single', lead: { model: 'sonnet' } },
    })) as Agent[];
    ids.push(a!.id);
  }
  // Spawned over IPC (not from the Spawn screen): main publishes every summary, queued ones too,
  // so all six tiles appear without a reload.
  await rail(page).getByRole('button', { name: 'Agents' }).click();
  const tiles = page.locator('article[data-agent-id]');
  await expect(tiles).toHaveCount(6);
  await expect(page.locator('article[data-agent-id][data-status="running"]')).toHaveCount(3, {
    timeout: 20_000,
  });
  await expect(page.locator('article[data-agent-id][data-status="queued"]')).toHaveCount(3);
  for (const p of projects)
    await expect(page.getByText(basename(repos.find((r) => basename(r) === p.name)!)).first()).toBeVisible();
  for (const id of ids) await invoke('agents.stop', { agentId: id });
});

test('M5: the Marketplace lists the built-in extensions', async () => {
  const { page } = ctx;
  const invoke = invoker(page);
  const installed = (await invoke('extensions.installed', undefined)) as Array<{
    source: string;
    displayName: string;
  }>;
  const builtins = installed.filter((e) => e.source === 'builtin');
  // Unpackaged builds find the built-ins from the repo root (review-conformance M4, fixed).
  expect(builtins.length).toBeGreaterThan(0);
  await rail(page).getByRole('button', { name: 'Extension marketplace' }).click();
  await page.getByRole('navigation', { name: 'Your extensions' }).getByRole('button', { name: /^Installed/ }).click();
  const list = page.getByRole('main').getByRole('list');
  for (const b of builtins)
    await expect(list.getByRole('button').filter({ hasText: `${b.displayName} ·` }).first()).toBeVisible();
});

test('no console errors', async () => {
  expect(ctx.consoleErrors.filter((m) => !/Content Security Policy/.test(m))).toEqual([]);
});
