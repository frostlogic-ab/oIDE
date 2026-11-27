import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUNDLED_LANGUAGE_SERVERS, bundledServerScript } from './index.js';

describe('bundledServerScript', () => {
  it('finds the script in the first node_modules folder that has it', () => {
    const have = new Set([join('/b', 'vscode-langservers-extracted', 'bin', 'vscode-css-language-server')]);
    expect(bundledServerScript('vscode-css-language-server', ['/a', '/b'], (p) => have.has(p))).toBe(join('/b', 'vscode-langservers-extracted', 'bin', 'vscode-css-language-server'));
    expect(bundledServerScript('vscode-css-language-server', ['/a'], (p) => have.has(p))).toBeUndefined();
  });

  it('knows only the shipped servers', () => {
    expect(bundledServerScript('gopls', ['/a'], () => true)).toBeUndefined();
    expect(bundledServerScript('constructor', ['/a'], () => true)).toBeUndefined();
    expect(Object.keys(BUNDLED_LANGUAGE_SERVERS).sort()).toEqual([
      'typescript-language-server',
      'vscode-css-language-server',
      'vscode-html-language-server',
      'vscode-json-language-server',
      'yaml-language-server',
    ]);
  });

  it('every shipped server resolves from the workspace node_modules', () => {
    const root = join(import.meta.dirname, '..', '..', '..', 'node_modules');
    for (const command of Object.keys(BUNDLED_LANGUAGE_SERVERS)) expect(bundledServerScript(command, [root]), command).toBeDefined();
  });
});
