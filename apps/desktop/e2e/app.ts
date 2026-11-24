import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';

const appDir = resolve(import.meta.dirname, '..');

export interface LaunchedApp {
  app: ElectronApplication;
  page: Page;
  consoleErrors: string[];
  close(): Promise<void>;
}

/** Launches the built app (out/main/index.js) with a throwaway userData folder. */
export async function launchApp(): Promise<LaunchedApp> {
  const userData = mkdtempSync(join(tmpdir(), 'oide-e2e-'));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RENDERER_URL') env[k] = v;
  env.OIDE_USER_DATA = userData;
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
    page,
    consoleErrors,
    close: async () => {
      await app.close();
      rmSync(userData, { recursive: true, force: true });
    },
  };
}
