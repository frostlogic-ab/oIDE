import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { app, dialog, Notification, protocol, safeStorage, shell, utilityProcess } from 'electron';
import { utilityProcessFork } from '@oide/extension-host';
import type { ArtifactStore } from '@oide/store';
import type { MainContext } from '../context.js';
import { trustPromptText } from '../security/confirm.js';
import { ARTIFACT_CSP, ARTIFACT_SCHEME, resolveArtifactUrl } from './core.js';
import { EXTENSION_SCHEME, resolveExtensionUrl, type ExtensionUiLookup } from './extension-ui.js';
import type { Platform } from './platform.js';
import type { TerminalService } from './terminals.js';

/** Must run before `app.whenReady()`: the artifact preview and extension UI schemes (one call registers both). */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true, bypassCSP: false } },
    { scheme: EXTENSION_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: true, bypassCSP: false } },
  ]);
}

/**
 * Serve `oide-ext://<origin>/<file>`: panel and artifact-viewer files of one extension, only from
 * inside its folder, with a CSP that blocks network access (see extension-ui.ts). The renderer shows
 * them in `<iframe sandbox="allow-scripts">`.
 */
export function handleExtensionScheme(lookup: ExtensionUiLookup): void {
  protocol.handle(EXTENSION_SCHEME, async (req) => {
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const hit = resolveExtensionUrl(lookup, req.url);
    if (!hit) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const body = await readFile(hit.file);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': hit.mime,
        'content-security-policy': hit.csp,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'cross-origin-resource-policy': 'same-site',
        'referrer-policy': 'no-referrer',
      },
    });
  });
}

/**
 * Serve `oide-artifact://<id>/<file>`: only files inside that artifact's folder, with a CSP that
 * blocks all network access. The renderer shows it in `<iframe sandbox="allow-scripts">`.
 */
export function handleArtifactScheme(artifacts: ArtifactStore): void {
  protocol.handle(ARTIFACT_SCHEME, async (req) => {
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    const hit = resolveArtifactUrl(artifacts, req.url);
    if (!hit) return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    const body = await readFile(hit.file);
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': hit.mime,
        'content-security-policy': ARTIFACT_CSP,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        'cross-origin-resource-policy': 'same-site',
      },
    });
  });
}

const TRUST_DETAIL =
  'A trusted project may run its .oide/setup command when an agent starts, pre-approve tool calls with .oide/permissions.json allow rules, ' +
  "start the MCP servers in .mcp.json, and have Claude Code load its .claude settings (hooks, permissions, plugins). oIDE's git calls also " +
  'honour its git config and hooks, and it is watched and fetched in the background.\n\n' +
  'An untrusted project gets none of this: agents only load your own Claude Code settings and oIDE\'s MCP servers, git runs with the ' +
  "repository's hooks, filters and other programs switched off, and nothing runs in the background. CLAUDE.md, skills and commands in the " +
  'repo can still reach the agent as text. You can change this later in the project menu.';

/**
 * The monorepo root in unpackaged builds (dev and e2e). `app.getAppPath()` is `apps/desktop` under
 * `electron-vite dev` but `apps/desktop/out/main` when launched as `electron out/main/index.js`, so
 * walk up to the folder that holds `pnpm-workspace.yaml`.
 */
export function devRepoRoot(start: string): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(start, '..', '..');
    dir = up;
  }
}

export function electronPlatform(ctx: MainContext, terminals: TerminalService): Platform {
  const win = () => {
    const w = ctx.getWindow();
    return w && !w.isDestroyed() ? w : undefined;
  };
  const repoRoot = app.isPackaged ? '' : devRepoRoot(app.getAppPath());
  // E2E only (unpackaged builds): answer the trust dialog without showing it.
  const autoTrust = !app.isPackaged ? process.env.OIDE_E2E_TRUST : undefined;
  // E2E only (unpackaged builds): folders projects.open may open by path (SEC-08).
  const openable = !app.isPackaged && process.env.OIDE_E2E_OPEN_PATHS ? process.env.OIDE_E2E_OPEN_PATHS.split(delimiter).filter(Boolean) : undefined;
  return {
    cipher: {
      encrypt: (s) => safeStorage.encryptString(s),
      decrypt: (b) => safeStorage.decryptString(Buffer.from(b)),
      available: () => safeStorage.isEncryptionAvailable(),
    },
    pickFolder: async (title) => {
      const w = win();
      const options: Electron.OpenDialogOptions = { title: title ?? 'Choose a folder', properties: ['openDirectory', 'createDirectory'] };
      const r = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    pickFile: async (title, filters) => {
      const w = win();
      const options: Electron.OpenDialogOptions = { title: title ?? 'Choose a file', properties: ['openFile'], filters };
      const r = w ? await dialog.showOpenDialog(w, options) : await dialog.showOpenDialog(options);
      return r.canceled ? null : (r.filePaths[0] ?? null);
    },
    confirmTrust: async ({ name, path }) => {
      if (autoTrust) return autoTrust === 'trust';
      const options: Electron.MessageBoxOptions = {
        type: 'question',
        title: 'Trust this project?',
        ...trustPromptText(name, path, TRUST_DETAIL),
        buttons: ['Trust project', 'Not now'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const w = win();
      const r = w ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
      return r.response === 0;
    },
    notify: (title, body, onClick) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title, body });
      if (onClick) n.on('click', onClick);
      n.show();
    },
    openExternal: (url) => shell.openExternal(url),
    openPath: (path) => shell.openPath(path),
    forkHost: utilityProcessFork(utilityProcess),
    hostEntry: join(import.meta.dirname, 'host-process.js'),
    builtinExtensionDirs: app.isPackaged ? [join(process.resourcesPath, 'extensions')] : [join(repoRoot, 'extensions')],
    bundledIndexPath: app.isPackaged ? join(process.resourcesPath, 'marketplace', 'index.json') : join(repoRoot, 'tools', 'marketplace-index', 'bundled', 'index.json'),
    ...(process.env.OIDE_CLAUDE_PATH ? { cliPathOverride: process.env.OIDE_CLAUDE_PATH } : {}),
    ...(openable ? { openablePaths: openable } : {}),
    terminals,
    background: true,
  };
}
