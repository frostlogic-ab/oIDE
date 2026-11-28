import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');

export interface LaunchedApp {
  app: ElectronApplication;
  userData: string;
  page: Page;
  consoleErrors: string[];
  close(): Promise<void>;
}

/** tools/fake-claude, so agent tests never need a real CLI or a login. */
export const FAKE_CLAUDE = resolve(appDir, '../../tools/fake-claude/bin', process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude.mjs');

/**
 * Launches the built app (out/main/index.js) with a throwaway userData folder. `env` adds variables,
 * e.g. `OIDE_CLAUDE_PATH` (CLI override) and `OIDE_E2E_TRUST=trust` (answers the trust dialog).
 */
export async function launchApp(extraEnv: Record<string, string> = {}, opts: { userDataPrefix?: string } = {}): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), opts.userDataPrefix ?? 'oide-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env.OIDE_USER_DATA = userData;
  // Telemetry is always off in e2e (no first-run question, no network) unless a test opts in with a file sink.
  env.OIDE_TELEMETRY = '0';
  // No npm registry lookups from an open package.json (tests never reach the network).
  env.OIDE_NPM_REGISTRY = 'off';
  Object.assign(env, extraEnv);
  const app = await electron.launch({
    args: [join(appDir, 'out/main/index.js'), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    cwd: appDir,
    env,
  });
  const page = await app.firstWindow();
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  await page.waitForLoadState('domcontentloaded');
  return {
    app,
    userData,
    page,
    consoleErrors,
    close: async () => {
      await app.close();
      // fs.promises.rm: some Node builds' rmSync silently skips non-ASCII paths on Windows.
      await rm(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}
