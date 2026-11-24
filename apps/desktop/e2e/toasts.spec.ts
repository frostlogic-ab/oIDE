import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLAUDE, launchApp, type LaunchedApp } from './app';

/**
 * Conformance M2 and M3 in the real app: the needs-permission toast sits bottom-left (never over an
 * action column) and goes away when the prompt is answered; the status bar counts the agent live.
 */

let ctx: LaunchedApp;
let repo: string;

type Invoke = (command: string, input: unknown) => Promise<unknown>;

function gitIn(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'oide-e2e-toasts-'));
  gitIn(repo, 'init', '-q', '-b', 'main');
  gitIn(repo, 'config', 'user.name', 'oIDE E2E');
  gitIn(repo, 'config', 'user.email', 'e2e@oide.invalid');
  gitIn(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'init');
  // Test-only stand-ins for the folder pick (SEC-08) and the extra-flags confirmation (SEC-07).
  ctx = await launchApp({ OIDE_CLAUDE_PATH: FAKE_CLAUDE, OIDE_E2E_TRUST: 'trust', OIDE_E2E_OPEN_PATHS: repo, OIDE_E2E_CONFIRM: 'accept' });
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('needs-permission toast: bottom-left above the status bar, removed when the prompt is answered; live status counts', async () => {
  const { page } = ctx;
  const invoke = (command: string, input: unknown) =>
    page.evaluate(([c, i]) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke(c as string, i), [command, input] as const);

  await invoke('settings.update', { patch: { claude: { extraFlags: '--fake-scenario review' } } });
  const project = (await invoke('projects.open', { path: repo })) as { id: string };
  await invoke('agents.spawn', {
    projectId: project.id,
    title: 'Toast check',
    goal: 'Add feature.txt and run the tests',
    mode: 'acceptEdits',
    strategy: { kind: 'single', lead: { model: 'sonnet' } },
  });

  const toasts = page.getByTestId('toasts');
  const toast = toasts.getByText(/Toast check needs permission/);
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('status-counts')).toContainText('1 session');

  const box = (await toast.boundingBox())!;
  const status = (await page.locator('footer').last().boundingBox())!;
  const viewport = page.viewportSize() ?? { width: await page.evaluate(() => window.innerWidth), height: 0 };
  expect(box.x).toBeLessThan(viewport.width / 2);
  expect(box.y + box.height).toBeLessThanOrEqual(status.y);

  await page.getByRole('group', { name: 'Permission: Run npm test' }).getByRole('button', { name: /Allow once/ }).click();
  await expect(toasts.getByText(/Toast check needs permission/)).toHaveCount(0, { timeout: 10_000 });
});
