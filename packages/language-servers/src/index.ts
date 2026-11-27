import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Language servers shipped with oIDE, so the most used languages work without installing anything
 * (ADR 0020). They are plain npm packages: the release copies this package's production
 * dependencies to `<resources>/language-servers/node_modules` (`pnpm deploy`), and in development
 * they resolve from the workspace's `node_modules`. They run with the user's own Node.js; a server
 * the user installed on PATH (or in the checkout's `node_modules/.bin`) always comes first.
 *
 * Keyed by the command the built-in Languages extension declares (`extensions/languages`).
 */
export const BUNDLED_LANGUAGE_SERVERS: Readonly<Record<string, { pkg: string; script: string }>> = {
  'typescript-language-server': { pkg: 'typescript-language-server', script: 'lib/cli.mjs' },
  'vscode-css-language-server': { pkg: 'vscode-langservers-extracted', script: 'bin/vscode-css-language-server' },
  'vscode-html-language-server': { pkg: 'vscode-langservers-extracted', script: 'bin/vscode-html-language-server' },
  'vscode-json-language-server': { pkg: 'vscode-langservers-extracted', script: 'bin/vscode-json-language-server' },
  'yaml-language-server': { pkg: 'yaml-language-server', script: 'bin/yaml-language-server' },
};

/** The script of the bundled server for `command`, from the first `node_modules` folder that has it. */
export function bundledServerScript(command: string, nodeModulesDirs: readonly string[], exists: (p: string) => boolean = existsSync): string | undefined {
  const entry = Object.prototype.hasOwnProperty.call(BUNDLED_LANGUAGE_SERVERS, command) ? BUNDLED_LANGUAGE_SERVERS[command] : undefined;
  if (!entry) return undefined;
  for (const dir of nodeModulesDirs) {
    const p = join(dir, entry.pkg, ...entry.script.split('/'));
    if (exists(p)) return p;
  }
  return undefined;
}
