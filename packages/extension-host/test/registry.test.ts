import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectExtensions } from '@oide/protocol';
import { describe, expect, it } from 'vitest';
import { DevModeWatcher } from '../src/dev-mode.js';
import type { ProjectRef } from '../src/interfaces.js';
import { loadFromFolder } from '../src/installer.js';
import { ExtensionRegistry } from '../src/registry.js';
import { createHostServices, extensionSecretKey } from '../src/services.js';
import { memoryExtensionRepo, memorySecrets, samplePkg, tempDir } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoExtensions = path.resolve(here, '..', '..', '..', 'extensions');

function projects(map: Record<string, { trusted: boolean; ext: ProjectExtensions | null }>) {
  return {
    project: (id: string): ProjectRef | undefined => (map[id] ? { id, name: id, root: `/r/${id}`, trusted: map[id].trusted } : undefined),
    read: (id: string) => map[id]?.ext ?? null,
  };
}

describe('ExtensionRegistry', () => {
  it('discovers the built-in extensions from the repo folder, on globally', async () => {
    const repo = memoryExtensionRepo();
    const reg = new ExtensionRegistry({ repo, builtinDirs: [repoExtensions] });
    const list = await reg.load();
    expect(list.map((e) => e.name).sort()).toEqual(['@oide/ext-browser-preview', '@oide/ext-git', '@oide/ext-themes']);
    expect(list.every((e) => e.source === 'builtin' && e.reviewed && e.enabledGlobally)).toBe(true);
    expect(reg.resolved('@oide/ext-browser-preview')?.tools[0]?.tool).toBe('preview_url');
    await expect(reg.remove('@oide/ext-git')).rejects.toThrow(/built in/);
  });

  it('persists enable state per project and globally, and emits changes', async () => {
    const repo = memoryExtensionRepo();
    const reg = new ExtensionRegistry({ repo, builtinDirs: [repoExtensions] });
    await reg.load();
    const events: number[] = [];
    reg.onChange((l) => events.push(l.length));
    const id = '@oide/ext-git';
    await reg.setEnabled(id, false, 'p1');
    expect(await reg.isEnabledFor(reg.get(id)!, 'p1')).toBe(false);
    expect(await reg.isEnabledFor(reg.get(id)!, 'p2')).toBe(true);
    await reg.setEnabled(id, false);
    expect(await reg.isEnabledFor(reg.get(id)!, 'p2')).toBe(false);
    await reg.setEnabled(id, true, 'p2');
    expect(await reg.enablement(reg.get(id)!, 'p2')).toBe('project');
    expect(events).toHaveLength(3);
    expect(repo.items.get(id)?.enabledProjects).toEqual(['p2']);

    // Builtins keep their persisted enable state across restarts.
    const again = new ExtensionRegistry({ repo, builtinDirs: [repoExtensions] });
    await again.load();
    expect(again.get(id)?.enabledGlobally).toBe(false);
    expect(again.get(id)?.enabledProjects).toEqual(['p2']);
  });

  it('honours .oide/extensions.json version ranges only in trusted projects', async () => {
    const t = tempDir();
    try {
      const dir = path.join(t.dir, 'sample');
      mkdirSync(path.join(dir, 'dist'), { recursive: true });
      writeFileSync(path.join(dir, 'package.json'), JSON.stringify(samplePkg()));
      for (const f of ['host.js', 'mcp.js', 'panel.html']) writeFileSync(path.join(dir, 'dist', f), '');
      const { record, loaded } = loadFromFolder(dir);
      expect(record.reviewed).toBe(false);
      const reg = new ExtensionRegistry({
        repo: memoryExtensionRepo(),
        projects: projects({
          team: { trusted: true, ext: { version: 1, enabled: { '@oide-community/sample': '^1.0.0', '@x/missing': '^2' } } },
          old: { trusted: true, ext: { version: 1, enabled: { '@oide-community/sample': '^2.0.0' } } },
          cloned: { trusted: false, ext: { version: 1, enabled: { '@oide-community/sample': '*' } } },
        }),
      });
      await reg.load();
      const ext = await reg.add(record, loaded);
      expect(await reg.enablement(ext, 'team')).toBe('team');
      expect(await reg.enablement(ext, 'old')).toBe('team-version-mismatch');
      expect(await reg.enablement(ext, 'cloned')).toBe('off');
      expect(await reg.missingForProject('team')).toEqual([{ name: '@x/missing', range: '^2' }]);
      expect((await reg.enabledFor('team')).map((e) => e.name)).toEqual(['@oide-community/sample']);
    } finally {
      t.cleanup();
    }
  });
});

describe('createHostServices', () => {
  it('scopes secret settings per extension and filters agents by enabled projects', async () => {
    const repo = memoryExtensionRepo();
    const reg = new ExtensionRegistry({ repo, builtinDirs: [repoExtensions] });
    await reg.load();
    await reg.setEnabled('@oide/ext-git', false, 'p2');
    const secrets = memorySecrets();
    const plain = new Map<string, unknown>();
    const svc = createHostServices({
      extension: (n) => reg.getByName(n),
      isEnabledFor: (e, p) => reg.isEnabledFor(e, p),
      settings: { get: (k) => plain.get(k), set: (k, v) => void plain.set(k, v) },
      secrets,
      listAgents: () => [
        { id: 'a1', projectId: 'p1', title: '', status: 'running', model: '' },
        { id: 'a2', projectId: 'p2', title: '', status: 'running', model: '' },
      ],
      postMessage: () => undefined,
      openPanel: () => undefined,
      postPanelMessage: () => undefined,
      readArtifact: (id) => ({ id, title: '', kind: 'doc', content: '' }),
      log: () => undefined,
    });
    expect((await svc.listAgents('@oide/ext-git', {})).map((a) => a.id)).toEqual(['a1']);
    await expect(svc.postMessage('@oide/ext-git', 'a2', 'hi')).rejects.toThrow();
    expect(await svc.settingsGet('@oide/ext-git', 'git.ghPath')).toBe('gh');
    await svc.settingsSet('@oide/ext-git', 'git.ghPath', '/usr/bin/gh');
    expect(plain.get('extensions.@oide/ext-git.git.ghPath')).toBe('/usr/bin/gh');
    await expect(svc.settingsSet('@oide/ext-git', 'git.ghPath', 3)).rejects.toThrow(/string/);
    expect(secrets.data.has(extensionSecretKey('@oide/ext-git', 'git.ghPath'))).toBe(false);
  });
});

describe('DevModeWatcher', () => {
  it('only watches folders the user picked in developer mode, and reloads on change', async () => {
    const t = tempDir();
    try {
      mkdirSync(path.join(t.dir, 'dist'), { recursive: true });
      writeFileSync(path.join(t.dir, 'package.json'), JSON.stringify(samplePkg()));
      for (const f of ['host.js', 'mcp.js', 'panel.html']) writeFileSync(path.join(t.dir, 'dist', f), '');
      const reloads: string[][] = [];
      const w = new DevModeWatcher({ onReload: (r) => void reloads.push(r.files), debounceMs: 50 });
      const { record } = loadFromFolder(t.dir, { devMode: true });
      expect(() => w.watch({ ...record, source: 'marketplace' })).toThrow();
      expect(() => w.watch({ ...record, devMode: false })).toThrow();
      w.watch(record);
      await new Promise((r) => setTimeout(r, 50));
      writeFileSync(path.join(t.dir, 'dist', 'host.js'), 'export function activate() {}');
      const start = Date.now();
      while (!reloads.length && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 25));
      w.dispose();
      expect(reloads.length).toBeGreaterThan(0);
      expect(reloads.flat().some((f) => f.includes('host.js'))).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});
