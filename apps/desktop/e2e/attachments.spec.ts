import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { FAKE_CLAUDE, launchApp, type LaunchedApp } from './app';

/**
 * A screenshot pasted into the Focus composer reaches the CLI as a stream-json image content block
 * (tools/fake-claude records stdin and names the images it got in its reply), and the transcript
 * shows it as a thumbnail that opens larger.
 */

let ctx: LaunchedApp;
let repo: string;
let record: string;

type Invoke = (command: string, input: unknown) => Promise<unknown>;
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

test.beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'oide-e2e-attach-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'oIDE E2E');
  git('config', 'user.email', 'e2e@oide.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'README.md'), '# fixture\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  record = join(mkdtempSync(join(tmpdir(), 'oide-e2e-rec-')), 'stdin.jsonl');
  // OIDE_E2E_CONFIRM answers the native confirmation that extra CLI flags need (SEC-07).
  ctx = await launchApp({ OIDE_CLAUDE_PATH: FAKE_CLAUDE, OIDE_E2E_TRUST: 'trust', OIDE_E2E_OPEN_PATHS: repo, OIDE_E2E_CONFIRM: 'accept' });
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
});

test('paste a screenshot into the Focus composer → delivered to the CLI as an image block', async () => {
  const { page } = ctx;
  const invoke = (command: string, input: unknown) => page.evaluate(([c, i]) => (window as unknown as { oide: { invoke: Invoke } }).oide.invoke(c as string, i), [command, input] as const);

  // The agent env is allow-listed, so fake-claude's stdin recorder is switched on with a CLI flag.
  await invoke('settings.update', { patch: { claude: { extraFlags: `--fake-scenario basic --fake-record ${record.split('\\').join('/')}` } } });
  const project = (await invoke('projects.open', { path: repo })) as { id: string };
  const [agent] = (await invoke('agents.spawn', { projectId: project.id, title: 'E2E attach', goal: 'Say hello', mode: 'acceptEdits', strategy: { kind: 'single', lead: { model: 'sonnet' } } })) as Array<{ id: string }>;
  await expect
    .poll(async () => ((await invoke('agents.list', undefined)) as Array<{ id: string; status: string }>).find((a) => a.id === agent!.id)?.status, { timeout: 30_000 })
    .toBe('has-question');

  // A click on the tile (outside its controls) opens Focus.
  await page.getByRole('article', { name: 'E2E attach' }).getByRole('heading', { name: 'E2E attach' }).click();
  const composer = page.getByRole('combobox', { name: 'Message this agent' });
  await expect(composer).toBeEnabled();

  // A real paste event carrying an image file, as the OS clipboard gives a screenshot.
  await composer.focus();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/png' }));
    document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);
  const tray = page.getByRole('list', { name: 'Attachments' });
  await expect(tray).toContainText(/Pasted image \d+\.png/);
  await expect(tray).toContainText('70 B');

  await composer.fill('What does this screenshot show?');
  await composer.press('Enter');
  await expect(tray).toHaveCount(0);

  // fake-claude names the image it received in its reply.
  await expect(page.getByText('You said: What does this screenshot show? [1 image: image/png, 70 bytes]').first()).toBeVisible({ timeout: 30_000 });

  // Its stdin got the stream-json user message with the image block first, then the text.
  await expect.poll(() => existsSync(record) && readFileSync(record, 'utf8').includes('"type":"image"'), { timeout: 10_000 }).toBe(true);
  const sent = readFileSync(record, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { stdin?: { type?: string; message?: { content?: unknown } } })
    .map((r) => r.stdin)
    .find((m) => m?.type === 'user' && JSON.stringify(m.message?.content).includes('"type":"image"'));
  expect(sent!.message!.content).toEqual([
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
    { type: 'text', text: 'What does this screenshot show?' },
  ]);

  // The transcript shows the image (stored with the user-text event) and opens it larger.
  const thumb = page.getByRole('button', { name: /^Open Pasted image \d+\.png$/ });
  await expect(thumb).toBeVisible();
  await thumb.click();
  await expect(page.getByRole('dialog', { name: /Pasted image \d+\.png/ })).toBeVisible();
  await page.keyboard.press('Escape');

  const events = (await invoke('agents.events', { agentId: agent!.id, limit: 500 })) as Array<{ type: string; attachments?: Array<{ kind: string; dataBase64?: string }> }>;
  expect(events.filter((e) => e.type === 'user-text' && e.attachments?.length).map((e) => e.attachments![0]!.dataBase64)).toEqual([PNG_B64]);
});

test('no console errors', async () => {
  expect(ctx.consoleErrors.filter((m) => !/Content Security Policy/.test(m))).toEqual([]);
});
