import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Settings } from '@oide/protocol';
import { resolveModel } from '@oide/protocol';
import {
  BUILTIN_PRESETS,
  BUILTIN_TECHNIQUES,
  KvRepo,
  SettingsService,
  deepMerge,
  defaultSettings,
  openDatabase,
  parseOideFile,
  readAllOideFiles,
  readOideFile,
  writeOideFile,
  buildOideSchemas,
} from '../src/index.js';
import { cleanup, tempDir } from './helpers.js';

afterAll(cleanup);

describe('defaults', () => {
  it('has the built-in presets and techniques from the Settings design', () => {
    const s = defaultSettings();
    expect(Settings.parse(s)).toEqual(s);
    expect(s.models.defaultPresetId).toBe('balanced');
    expect(s.models.presets.map((p) => p.id)).toEqual(['cheap', 'balanced', 'quality']);
    const balanced = s.models.presets.find((p) => p.id === 'balanced')!;
    expect(balanced.strategy).toEqual({
      kind: 'routed',
      lead: { model: 'opus', effort: 'high' },
      simple: { model: 'haiku', effort: 'low' },
      standard: { model: 'sonnet', effort: 'medium' },
      complex: { model: 'opus', effort: 'high' },
    });
    expect(s.techniques.map((t) => [t.id, t.name, t.enabledByDefault, t.placement])).toEqual([
      ['review', 'Adversarial review', true, 'first-message'],
      ['docs', 'Full docs and tests', false, 'first-message'],
      ['gates', 'Quality gates must pass', true, 'first-message'],
    ]);
    expect(s.agents).toMatchObject({ maxRunning: 3, worktreeLocation: 'app-data', cleanup: 'after-7-days', fetchIntervalMinutes: 10 });
    expect(s.claude).toMatchObject({ defaultMode: 'auto', allowBypass: false });
    expect(s.permissions.defaults).toEqual({ editFiles: 'allow', shell: 'ask', network: 'ask' });
  });

  it('resolves model versions', () => {
    expect(resolveModel('opus')).toBe('opus');
    expect(resolveModel('opus', { opus: 'latest' })).toBe('opus');
    expect(resolveModel('opus', { opus: '4.8' })).toBe('claude-opus-4-8');
    expect(resolveModel('Sonnet', { sonnet: '5.5' })).toBe('claude-sonnet-5-5');
    expect(resolveModel('claude-opus-5', { opus: '4.8' })).toBe('claude-opus-5');
    expect(resolveModel('local-coder')).toBe('local-coder');
  });
});

describe('deepMerge', () => {
  it('merges objects, replaces arrays, deletes on null, ignores prototype keys', () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, l: [1, 2] }, { a: { c: 3 }, l: [9] })).toEqual({ a: { b: 1, c: 3 }, l: [9] });
    expect(deepMerge({ a: { b: 1 } }, { a: null })).toEqual({});
    const polluted = deepMerge({}, JSON.parse('{"__proto__": {"x": 1}}'));
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(polluted).toEqual({});
  });
});

describe('SettingsService', () => {
  it('patches, persists, validates and notifies', () => {
    const db = openDatabase(':memory:');
    const svc = new SettingsService({ db });
    const seen: number[] = [];
    const off = svc.onChange((s) => seen.push(s.agents.maxRunning));
    const s = svc.update({ agents: { maxRunning: 5 }, ui: { accent: '#7FC8A9' } });
    expect(s.agents.maxRunning).toBe(5);
    expect(s.agents.notifications.error).toBe(true);
    expect(() => svc.update({ agents: { maxRunning: 0 } })).toThrow();
    expect(new SettingsService({ db }).get().ui.accent).toBe('#7FC8A9');
    off();
    svc.update({ agents: { maxRunning: 4 } });
    expect(seen).toEqual([5]);
    expect(svc.update({ agents: null }).agents.maxRunning).toBe(3);
  });

  it('updates (M7): defaults to stable with automatic checks, persists the channel, refuses unknown channels', () => {
    const db = openDatabase(':memory:');
    const svc = new SettingsService({ db });
    expect(svc.get().updates).toEqual({ channel: 'stable', checkAutomatically: true });
    expect(svc.update({ updates: { channel: 'beta' } }).updates).toEqual({ channel: 'beta', checkAutomatically: true });
    expect(new SettingsService({ db }).get().updates.channel).toBe('beta');
    expect(() => svc.update({ updates: { channel: 'nightly' } })).toThrow();
    // Settings saved before M7 have no `updates` key and still parse.
    expect(Settings.parse({ claude: {}, models: {}, agents: { notifications: {} }, techniques: [], permissions: {}, ui: {} }).updates.channel).toBe('stable');
  });

  it('keeps keyboard shortcut rebinds per action; null resets one, [] unbinds, bad combos are refused', () => {
    const db = openDatabase(':memory:');
    const svc = new SettingsService({ db });
    expect(svc.get().keybindings).toEqual({});
    svc.update({ keybindings: { 'agent.next': ['L'], 'commandBar.open': ['Mod+P'] } });
    svc.update({ keybindings: { 'agent.prev': [] } });
    expect(new SettingsService({ db }).get().keybindings).toEqual({ 'agent.next': ['L'], 'commandBar.open': ['Mod+P'], 'agent.prev': [] });
    expect(svc.update({ keybindings: { 'agent.next': null } }).keybindings).toEqual({ 'commandBar.open': ['Mod+P'], 'agent.prev': [] });
    expect(() => svc.update({ keybindings: { 'agent.next': [''] } })).toThrow();
    expect(svc.update({ keybindings: null }).keybindings).toEqual({});
  });

  it('keeps sidebar widths across restarts; null resets one or all, bad widths are refused', () => {
    const db = openDatabase(':memory:');
    const svc = new SettingsService({ db });
    expect(svc.get().ui.panelWidths).toEqual({});
    svc.update({ ui: { panelWidths: { 'wall.projects': 320 } } });
    svc.update({ ui: { panelWidths: { 'focus.inspector': 420 } } });
    // A fresh service over the same database is what the next launch sees.
    const reopened = new SettingsService({ db }).get().ui;
    expect(reopened.panelWidths).toEqual({ 'wall.projects': 320, 'focus.inspector': 420 });
    expect(reopened.accent).toBe('#7AA2F7');
    expect(svc.update({ ui: { panelWidths: { 'wall.projects': null } } }).ui.panelWidths).toEqual({ 'focus.inspector': 420 });
    // Bad widths never get stored (they are dropped, not saved).
    expect(svc.update({ ui: { panelWidths: { 'wall.projects': 10, 'files.tree': 'wide', 'Bad Id': 300 } } }).ui.panelWidths).toEqual({ 'focus.inspector': 420 });
    expect(svc.update({ ui: { panelWidths: null } }).ui.panelWidths).toEqual({});
    expect(new SettingsService({ db }).get().ui.panelWidths).toEqual({});
  });

  it('a stale stored sidebar width is dropped on load without resetting the rest of ui', () => {
    const db = openDatabase(':memory:');
    new KvRepo(db, 'settings').set('global', { ui: { accent: '#7FC8A9', crashReports: true, panelWidths: { 'wall.projects': 5, 'focus.inspector': 400, ['__proto__']: 300 } } });
    const svc = new SettingsService({ db });
    const ui = svc.get().ui;
    expect(svc.loadErrors).toEqual([]);
    expect(ui.accent).toBe('#7FC8A9');
    expect(ui.crashReports).toBe(true);
    expect(ui.panelWidths).toEqual({ 'focus.inspector': 400 });
  });

  it('keeps built-ins when presets/techniques arrays are replaced, and supports reset', async () => {
    const db = openDatabase(':memory:');
    const svc = new SettingsService({ db });
    svc.update({ techniques: [] });
    expect(svc.get().techniques.map((t) => t.id)).toEqual(BUILTIN_TECHNIQUES.map((t) => t.id));
    const edited = await svc.saveTechnique({ ...BUILTIN_TECHNIQUES[1]!, enabledByDefault: true });
    expect(edited).toMatchObject({ id: 'docs', enabledByDefault: true, builtIn: true });
    await svc.saveTechnique({ id: 'mine', name: 'Mine', description: '', text: 'Be brief.', placement: 'system-prompt', builtIn: true, enabledByDefault: false, scope: 'global' });
    expect(svc.get().techniques.find((t) => t.id === 'mine')).toMatchObject({ builtIn: false, placement: 'system-prompt' });
    await expect(svc.deleteTechnique('review')).rejects.toThrow(/Built-in/);
    await svc.deleteTechnique('mine');
    expect(svc.resetTechnique('docs')?.enabledByDefault).toBe(false);

    const q = svc.preset('quality')!;
    svc.savePreset({ ...q, strategy: { kind: 'single', lead: { model: 'sonnet', effort: 'high' } } });
    expect(svc.strategyFor('quality')).toEqual({ kind: 'single', lead: { model: 'sonnet', effort: 'high' } });
    expect(svc.resetPreset('quality')?.strategy).toEqual(BUILTIN_PRESETS[2]!.strategy);
    expect(() => svc.deletePreset('balanced')).toThrow();
    expect(svc.strategyFor().kind).toBe('routed');
    svc.update({ models: { defaultPresetId: 'custom', lastUsedStrategy: { kind: 'single', lead: { model: 'haiku' } } } });
    expect(svc.strategyFor()).toEqual({ kind: 'single', lead: { model: 'haiku' } });
  });

  it('recovers section by section from a stored document that no longer validates', () => {
    const db = openDatabase(':memory:');
    db.db.prepare("INSERT INTO settings (key, data, updated_at) VALUES ('global', ?, 1)").run(JSON.stringify({ agents: { maxRunning: 'lots' }, ui: { accent: '#C4A7E7' } }));
    const svc = new SettingsService({ db });
    const s = svc.get();
    expect(s.agents.maxRunning).toBe(3);
    expect(s.ui.accent).toBe('#C4A7E7');
    expect(svc.loadErrors[0]).toMatch(/settings.agents/);
  });

  it('applies .oide project overrides with workspace trust', async () => {
    const repo = tempDir();
    await writeOideFile(repo, 'config', { defaultMode: 'acceptEdits', presetId: 'quality', setup: 'pnpm install' });
    await writeOideFile(repo, 'permissions', { allow: ['Bash(npm test)'], ask: ['Bash(git push:*)'], deny: ['Bash(rm -rf:*)'] });
    await writeOideFile(repo, 'extensions', { enabled: { '@evil/tools': '^1.0.0' } });
    await writeOideFile(repo, 'techniques', { techniques: [{ id: 'team', name: 'Team style', text: 'Use tabs.', placement: 'system-prompt', enabledByDefault: true }] });
    const svc = new SettingsService({ db: openDatabase(':memory:') });

    const trusted = await svc.forProject(repo, { trusted: true });
    expect(trusted.settings.claude.defaultMode).toBe('acceptEdits');
    expect(trusted.settings.models.defaultPresetId).toBe('quality');
    expect(trusted.setup).toBe('pnpm install');
    expect(trusted.permissions.allow).toEqual(['Bash(npm test)']);
    expect(trusted.techniques.at(-1)).toMatchObject({ id: 'team', scope: 'project', enabledByDefault: true, builtIn: false });
    expect(trusted.errors).toEqual([]);

    const untrusted = await svc.forProject(repo, { trusted: false });
    expect(untrusted.setup).toBeUndefined();
    expect(untrusted.permissions).toMatchObject({ allow: [], ask: ['Bash(git push:*)'], deny: ['Bash(rm -rf:*)'] });
    expect(untrusted.settings.claude.defaultMode).toBe('auto');
    expect(untrusted.techniques.at(-1)).toMatchObject({ enabledByDefault: false, placement: 'first-message', name: 'Team style (from untrusted project)' });
    expect(untrusted.extensions.enabled).toEqual({});
    expect(trusted.extensions.enabled).toEqual({ '@evil/tools': '^1.0.0' });

    await writeOideFile(repo, 'config', { defaultMode: 'bypassPermissions' });
    expect((await svc.forProject(repo, { trusted: true })).settings.claude.defaultMode).toBe('auto');
    svc.update({ claude: { allowBypass: true } });
    expect((await svc.forProject(repo, { trusted: true })).settings.claude.defaultMode).toBe('bypassPermissions');

    await svc.saveTechnique({ id: 'team2', name: 'T2', description: '', text: 'x', placement: 'first-message', builtIn: false, enabledByDefault: false, scope: 'global' }, repo);
    expect((await svc.techniques(repo)).map((t) => t.id).slice(-2)).toEqual(['team', 'team2']);
    await svc.deleteTechnique('team', repo);
    expect((await readOideFile(repo, 'techniques')).value.techniques.map((t) => t.id)).toEqual(['team2']);
    await svc.saveProjectPermissions(repo, { allow: [], ask: [], deny: ['WebFetch'] });
    expect((await readOideFile(repo, 'permissions')).value.deny).toEqual(['WebFetch']);
  });
});

describe('.oide files', () => {
  it('returns defaults for missing files and errors for invalid ones', async () => {
    const repo = tempDir();
    expect(await readOideFile(repo, 'config')).toEqual({ value: { version: 1 }, exists: false, errors: [] });
    mkdirSync(join(repo, '.oide'));
    writeFileSync(join(repo, '.oide', 'permissions.json'), '{ "allow": [1] }');
    writeFileSync(join(repo, '.oide', 'extensions.json'), '{ nope');
    writeFileSync(join(repo, '.oide', 'config.json'), '{ "version": 2 }');
    writeFileSync(join(repo, '.oide', 'techniques.json'), '﻿{ "version": 1, "techniques": [] }');
    const all = await readAllOideFiles(repo);
    expect(all.permissions).toEqual({ version: 1, allow: [], ask: [], deny: [] });
    expect(all.errors).toHaveLength(3);
    expect(all.errors.join('\n')).toMatch(/permissions.json: allow.0/);
    expect(all.errors.join('\n')).toMatch(/extensions.json: invalid JSON/);
    expect(all.errors.join('\n')).toMatch(/config.json: unsupported version 2/);
  });

  it('writes with version, keeps an existing $schema, validates input', async () => {
    const repo = tempDir();
    await writeOideFile(repo, 'extensions', { enabled: { 'oide-git': '^1.0.0' } });
    const text = readFileSync(join(repo, '.oide', 'extensions.json'), 'utf8');
    expect(JSON.parse(text)).toEqual({ version: 1, enabled: { 'oide-git': '^1.0.0' } });
    writeFileSync(join(repo, '.oide', 'extensions.json'), JSON.stringify({ $schema: '../schemas/x.json', version: 1, enabled: {} }));
    await writeOideFile(repo, 'extensions', { enabled: { a: '1' } });
    expect(JSON.parse(readFileSync(join(repo, '.oide', 'extensions.json'), 'utf8')).$schema).toBe('../schemas/x.json');
    await expect(writeOideFile(repo, 'permissions', { allow: [3] } as never)).rejects.toThrow();
    expect(parseOideFile('techniques', '{"techniques":[{"id":"x","name":"x","text":"t","placement":"first-message","builtIn":true}]}').value.techniques[0]).toMatchObject({ scope: 'project', builtIn: false });
  });

  it('JSON Schemas in packages/protocol/schemas are up to date (pnpm --filter @oide/store gen:schemas)', () => {
    const dir = join(import.meta.dirname, '..', '..', 'protocol', 'schemas');
    for (const [name, text] of Object.entries(buildOideSchemas())) {
      const p = join(dir, name);
      expect(existsSync(p), `${name} missing`).toBe(true);
      expect(readFileSync(p, 'utf8').replace(/\r\n/g, '\n')).toBe(text);
    }
  });
});
