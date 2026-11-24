import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from './app';

/**
 * Native confirmations in main (review-security SEC-04, SEC-06) inside the real Electron build:
 * `OIDE_E2E_CONFIRM=deny` answers "Cancel" without showing the dialog, so a renderer call that
 * would run code is refused and nothing runs.
 */
let ctx: LaunchedApp;
const scratch = mkdtempSync(join(tmpdir(), 'oide-e2e-confirm-'));

test.beforeAll(async () => {
  ctx = await launchApp({ OIDE_E2E_CONFIRM: 'deny' });
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(scratch, { recursive: true, force: true });
});

test('a declined confirmation stops custom.probeCommand and extensions.addFromGit', async () => {
  const marker = join(scratch, 'pwned');
  const res = await ctx.page.evaluate(
    async ({ marker }) => {
      const oide = (window as unknown as { oide: { invoke(c: string, i: unknown): Promise<unknown> } }).oide;
      const attempt = async (c: string, i: unknown) => {
        try {
          await oide.invoke(c, i);
          return 'succeeded';
        } catch (e) {
          return (e as Error).message;
        }
      };
      return {
        probe: await attempt('custom.probeCommand', { command: 'node', args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], env: {} }),
        git: await attempt('extensions.addFromGit', { url: 'https://git.example.invalid/evil.git' }),
      };
    },
    { marker },
  );
  expect(res.probe).toMatch(/^\[forbidden\]/);
  expect(res.git).toMatch(/^\[forbidden\]/);
  expect(existsSync(marker)).toBe(false);
});

test('an accepted confirmation lets the probe run (the Electron dialog path is live)', async () => {
  const accepted = await launchApp({ OIDE_E2E_CONFIRM: 'accept' });
  try {
    const r = await accepted.page.evaluate(async () => {
      const oide = (window as unknown as { oide: { invoke(c: string, i: unknown): Promise<unknown> } }).oide;
      return (await oide.invoke('custom.probeCommand', { command: 'node', args: ['-e', 'process.exit(0)'], env: {} })) as { started: boolean };
    });
    expect(r.started).toBe(false); // it ran and exited without speaking MCP
  } finally {
    await accepted.close();
  }
});
