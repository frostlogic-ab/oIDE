import type { ForkFn } from '@oide/extension-host';
import type { Cipher } from '@oide/store';
import type { TerminalService } from './terminals.js';

/**
 * Everything the services layer needs from Electron, injected so the whole layer runs in plain
 * Node (test/integration). `services/electron-platform.ts` is the real implementation.
 */
export interface Platform {
  /** `safeStorage` (writes refused when `available()` is false). */
  cipher: Cipher;
  /** Native folder picker; null when cancelled. */
  pickFolder(title?: string): Promise<string | null>;
  /** Native file picker; null when cancelled. */
  pickFile(title: string | undefined, filters: Array<{ name: string; extensions: string[] }>): Promise<string | null>;
  /** Native multi-file picker (Attach file); [] when cancelled. Without it, `pickFile` picks one. */
  pickFiles?(title: string | undefined): Promise<string[]>;
  /**
   * First open of a project: ask whether to trust it (native dialog). Resolves true/false; the
   * project is stored untrusted on false and the user can trust it later (`projects.trust`).
   */
  confirmTrust(project: { name: string; path: string }): Promise<boolean>;
  /** Desktop notification (Electron `Notification`); `onClick` focuses the window. */
  notify(title: string, body: string, onClick?: () => void): void;
  /** Open a local folder in the file manager (`shell.openPath`); resolves an error message or ''. */
  openPath?(path: string): Promise<string>;
  /** System browser (`shell.openExternal`); callers check the URL first. */
  openExternal(url: string): Promise<void>;
  /** Fork for extension host processes (`utilityProcessFork(utilityProcess)`); none = host code off. */
  forkHost?: ForkFn;
  /** Bundled host-process entry (`out/main/host-process.js`). */
  hostEntry?: string;
  /** Folders whose subfolders are built-in extensions. */
  builtinExtensionDirs: string[];
  /** `tools/marketplace-index/bundled/index.json` (or the packaged copy). */
  bundledIndexPath?: string;
  /**
   * Tests only: folders `projects.open({ path })` may open without a dialog pick (SEC-08). Set by
   * the integration harness, and by electron-platform from `OIDE_E2E_OPEN_PATHS` in unpackaged
   * builds only; never in a packaged app.
   */
  openablePaths?: string[];
  /** Path override for the CLI (`OIDE_CLAUDE_PATH`, tests); wins over Settings. */
  cliPathOverride?: string;
  /** Terminal service (node-pty), for the sign-in terminal. */
  terminals: Pick<TerminalService, 'create'>;
  /** Start background work (watchers, periodic fetch). Off in most unit tests. */
  background?: boolean;
  /** Fetch for third-party calls (custom model test, marketplace). Default global fetch. */
  fetch?: typeof fetch;
}
