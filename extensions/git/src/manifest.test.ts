import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CommandHandler, ExtensionContext } from '@oide/extension-api';
import { loadManifest, requireBundled } from '@oide/extension-host';
import { describe, expect, it } from 'vitest';
import { checkCwd, ghArgs } from '../dist/gh.js';
import { activate } from '../dist/host.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('git extension', () => {
  it('has a valid manifest: PR commands, no deploy targets, no agent tools', () => {
    const l = loadManifest(root);
    expect(requireBundled(l)).toEqual([]);
    expect(l.manifest.oide.contributes.commands.map((c) => c.id)).toEqual(['git.openPullRequest', 'git.viewPullRequest']);
    expect(l.manifest.oide.contributes.deployTargets).toEqual([]);
    expect(l.tools).toEqual([]);
    expect(l.activation).toEqual(['onCommand:git.openPullRequest', 'onCommand:git.viewPullRequest']);
  });

  it('builds gh arguments without a shell', () => {
    expect(ghArgs('open')).toEqual(['pr', 'create', '--web', '--fill']);
    expect(ghArgs('open', { base: 'main', draft: true })).toEqual(['pr', 'create', '--web', '--fill', '--base', 'main', '--draft']);
    expect(() => ghArgs('open', { base: 'main; rm -rf /' })).toThrow();
    expect(ghArgs('view')[0]).toBe('pr');
    expect(ghArgs('view')).toContain('--json');
    expect(ghArgs('view-web')).toEqual(['pr', 'view', '--web']);
  });

  it('needs an absolute, existing worktree folder', () => {
    expect(checkCwd(os.tmpdir())).toBe(os.tmpdir());
    expect(() => checkCwd('relative/dir')).toThrow();
    expect(() => checkCwd(path.join(os.tmpdir(), 'does-not-exist-oide'))).toThrow();
  });

  it('registers its commands and resolves an agent worktree', async () => {
    const commands = new Map<string, CommandHandler>();
    const ctx = {
      subscriptions: [],
      commands: { register: (id: string, fn: CommandHandler) => (commands.set(id, fn), { dispose() {} }) },
      settings: { get: async () => path.join(os.tmpdir(), 'no-such-gh-binary-oide') },
      agents: { list: async () => [{ id: 'a1', projectId: 'p', title: 't', status: 'running', model: 'm', worktreePath: os.tmpdir() }] },
    } as unknown as ExtensionContext;
    activate(ctx);
    expect([...commands.keys()]).toEqual(['git.openPullRequest', 'git.viewPullRequest']);
    await expect(commands.get('git.viewPullRequest')?.({ agentId: 'nope' })).rejects.toThrow(/no worktree/);
    await expect(commands.get('git.viewPullRequest')?.({ agentId: 'a1' })).rejects.toThrow(/not installed/);
  });
});
