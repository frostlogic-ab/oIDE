import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { launchApp, type LaunchedApp } from './app';

/**
 * Opt-in telemetry (ADR 0011). The app runs with a file sink (`OIDE_TELEMETRY_SINK`, unpackaged
 * builds only) instead of the network: every request main would make is one JSON line in the file.
 * No real network is used.
 */

interface SinkLine {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
const read = (file: string): SinkLine[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as SinkLine)
    : [];
const payloads = (lines: SinkLine[]) =>
  lines.flatMap((l) => (Array.isArray(l.body) ? l.body : [l.body])) as Array<{
    type: string;
    payload: Record<string, unknown>;
  }>;

const rail = (page: Page) => page.getByRole('navigation', { name: 'Primary' });
const sinkDir = mkdtempSync(join(tmpdir(), 'oide-e2e-telemetry-'));
const env = (sink: string) => ({ OIDE_TELEMETRY: '', DO_NOT_TRACK: '', OIDE_TELEMETRY_SINK: sink });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Help make oIDE better for you' });

let ctx: LaunchedApp | undefined;
test.afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});
test.afterAll(() => rmSync(sinkDir, { recursive: true, force: true }));

test('the first-run question appears on a fresh profile, and "No thanks" sends nothing', async () => {
  const sink = join(sinkDir, 'declined.jsonl');
  ctx = await launchApp(env(sink));
  const { page } = ctx;
  await expect(dialog(page)).toBeVisible({ timeout: 15_000 });
  await expect(dialog(page)).toContainText(
    'No personal data, code, prompts or project information is ever sent',
  );
  await dialog(page).getByText('What’s included').click();
  await expect(dialog(page)).toContainText('Crash and error reports');
  await dialog(page).getByRole('button', { name: 'No thanks' }).click();
  await expect(dialog(page)).toBeHidden();

  // Use the app a little: screens, Settings sections.
  await rail(page).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Privacy' }).click();
  await expect(page.getByRole('switch', { name: 'Share anonymous usage analytics' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await expect(page.getByRole('switch', { name: 'Send crash and error reports' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.waitForTimeout(1500);
  expect(read(sink)).toEqual([]);
  expect(
    existsSync(join(ctx.userData, 'telemetry.json'))
      ? JSON.parse(readFileSync(join(ctx.userData, 'telemetry.json'), 'utf8')).installId
      : undefined,
  ).toBeUndefined();
});

test('opt in, then switching both off in Settings › Privacy stops sending', async () => {
  const sink = join(sinkDir, 'accepted.jsonl');
  ctx = await launchApp(env(sink));
  const { page } = ctx;
  await expect(dialog(page)).toBeVisible({ timeout: 15_000 });
  await dialog(page).getByRole('button', { name: 'Share usage and crash reports' }).click();
  await expect(dialog(page)).toBeHidden();

  await rail(page).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('navigation', { name: 'Settings' }).getByRole('button', { name: 'Privacy' }).click();
  await expect
    .poll(
      () =>
        payloads(read(sink)).filter(
          (p) => p.type === 'event' && p.payload.url === '/settings/privacy' && !p.payload.name,
        ).length,
      { timeout: 10_000 },
    )
    .toBeGreaterThan(0);

  const sent = payloads(read(sink));
  const optIn = sent.find((p) => p.payload.name === 'telemetry_opt_in');
  expect(optIn?.payload).toMatchObject({ hostname: 'oide-dev', data: { source: 'prompt', errors: true } });
  expect(sent.some((p) => p.type === 'identify')).toBe(true);
  for (const line of read(sink))
    expect(line.url).toMatch(/^https:\/\/data\.frostlogic\.se\/api\/(batch|send)$/);
  // Synthetic screen paths only; nothing that looks like a file path or user data.
  const text = JSON.stringify(sent);
  expect(text).not.toMatch(/[A-Za-z]:\\\\|\/Users\/|\/home\/|oide-e2e-/);
  const installId = sent[0]!.payload.id;
  expect(installId).toMatch(/^[0-9a-f-]{36}$/);
  // One Umami session per install: usage payloads pin the fingerprint (umami.ts, SESSION_IP).
  for (const p of sent.filter((x) => x.type !== 'error'))
    expect(p.payload).toMatchObject({
      id: installId,
      ip: '127.0.0.1',
      userAgent: expect.stringMatching(/^Mozilla\/5\.0 /),
    });

  await page.getByRole('switch', { name: 'Share anonymous usage analytics' }).click();
  await expect(page.getByRole('switch', { name: 'Share anonymous usage analytics' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.getByRole('switch', { name: 'Send crash and error reports' }).click();
  await expect(page.getByRole('switch', { name: 'Send crash and error reports' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.waitForTimeout(800);
  const before = read(sink).length;

  // Keep using the app: nothing more may be sent.
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('button', { name: 'Appearance' })
    .click();
  await rail(page).getByRole('button', { name: 'Files' }).click();
  await rail(page).getByRole('button', { name: 'Settings' }).click();
  await page.waitForTimeout(1500);
  expect(read(sink).length).toBe(before);
  // Off deletes the install id.
  expect(JSON.parse(readFileSync(join(ctx.userData, 'telemetry.json'), 'utf8')).installId).toBeUndefined();
});

test('every other e2e launch has telemetry off: no question, nothing written', async () => {
  const sink = join(sinkDir, 'default.jsonl');
  ctx = await launchApp({ OIDE_TELEMETRY_SINK: sink });
  await ctx.page.waitForTimeout(2500);
  await expect(dialog(ctx.page)).toHaveCount(0);
  expect(read(sink)).toEqual([]);
});
