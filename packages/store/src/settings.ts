import { FocusPreset, Settings, Technique, type ModelStrategy, type ProjectConfig, type ProjectExtensions, type ProjectPermissions } from '@oide/protocol';
import type { Database } from './db.js';
import { readAllOideFiles, readOideFile, writeOideFile } from './oide-files.js';
import { KvRepo } from './repos/misc.js';

/* ------------------------------------------------------------ built-ins */

/** Focus presets from Settings > Models (Settings.dc.html). Models are family aliases ("Latest"). */
export const BUILTIN_PRESETS: FocusPreset[] = [
  {
    id: 'cheap',
    name: 'Cheap',
    description: 'Sonnet leads; subagents always use Haiku.',
    builtIn: true,
    strategy: { kind: 'subagent-model', lead: { model: 'sonnet', effort: 'medium' }, subagents: { model: 'haiku', effort: 'low' } },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    description: 'Opus leads and routes subagents by task size: simple to Haiku, standard to Sonnet, complex to Opus.',
    builtIn: true,
    strategy: {
      kind: 'routed',
      lead: { model: 'opus', effort: 'high' },
      simple: { model: 'haiku', effort: 'low' },
      standard: { model: 'sonnet', effort: 'medium' },
      complex: { model: 'opus', effort: 'high' },
    },
  },
  {
    id: 'quality',
    name: 'Quality',
    description: 'Opus for everything, at maximum effort.',
    builtIn: true,
    strategy: { kind: 'single', lead: { model: 'opus', effort: 'max' } },
  },
];

/** Built-in techniques from Settings > Techniques (Settings.dc.html), all appended to the first message. */
export const BUILTIN_TECHNIQUES: Technique[] = [
  {
    id: 'review',
    name: 'Adversarial review',
    description: 'A reviewer subagent hunts for problems in the diff before the agent finishes.',
    text: 'When your changes are complete, start a separate reviewer subagent whose only job is to find bugs, regressions, security issues and missed requirements in your diff. Fix what it finds and repeat until it reports nothing significant.',
    placement: 'first-message',
    builtIn: true,
    enabledByDefault: true,
    scope: 'global',
  },
  {
    id: 'docs',
    name: 'Full docs and tests',
    description: 'Documentation and tests for everything changed, written at the end.',
    text: 'Before you finish, update or write documentation for everything you changed, and add tests that cover the new behaviour and its edge cases.',
    placement: 'first-message',
    builtIn: true,
    enabledByDefault: false,
    scope: 'global',
  },
  {
    id: 'gates',
    name: 'Quality gates must pass',
    description: 'Build, tests, lint and type checks all pass before the agent says it is done.',
    text: 'You are not done until the build, the full test suite, lint, type checks and every other quality gate in this project pass. Run them, fix any failures, and report the results.',
    placement: 'first-message',
    builtIn: true,
    enabledByDefault: true,
    scope: 'global',
  },
];

/** Protocol defaults plus the built-in presets and techniques. */
export function defaultSettings(): Settings {
  return Settings.parse({
    claude: {},
    models: { presets: structuredClone(BUILTIN_PRESETS) },
    agents: { notifications: {} },
    techniques: structuredClone(BUILTIN_TECHNIQUES),
    permissions: {},
    ui: {},
    updates: { channel: 'stable', checkAutomatically: true },
    keybindings: {},
  });
}

/* ---------------------------------------------------------- deep merge */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Deep-merge `patch` into `base`: objects merge recursively, arrays and scalars replace,
 * `null` deletes the key (so the default comes back on the next load).
 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(patch)) return (patch === undefined ? base : patch) as T;
  const out: Json = isObj(base) ? { ...base } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (v === null) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

/** Keep every built-in item (by id), in built-in order first, with the user's edits to it. */
function withBuiltIns<T extends { id: string; builtIn?: boolean }>(items: T[], builtIns: T[]): T[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const head = builtIns.map((b) => ({ ...(byId.get(b.id) ?? b), builtIn: true }));
  const tail = items.filter((i) => !builtIns.some((b) => b.id === i.id)).map((i) => ({ ...i, builtIn: false }));
  return [...head, ...tail];
}

/* ------------------------------------------------------------- service */

export interface EffectiveProjectSettings {
  /** Global settings with the project's overrides applied (default mode, preset). */
  settings: Settings;
  config: ProjectConfig;
  /** For untrusted projects `allow` is emptied (ask and deny still apply). */
  permissions: ProjectPermissions;
  /** Global techniques followed by the project's. */
  techniques: Technique[];
  extensions: ProjectExtensions;
  /** `.oide/setup` command; undefined for untrusted projects. */
  setup?: string;
  trusted: boolean;
  /** Problems reading `.oide/*.json` (shown in Settings, never fatal). */
  errors: string[];
}

export type SettingsListener = (settings: Settings) => void;

const KEY = 'global';

export class SettingsService {
  private readonly kv: KvRepo;
  private cache: Settings | undefined;
  private readonly listeners = new Set<SettingsListener>();
  /** Problems found loading the stored document (sections that no longer validate were reset). */
  loadErrors: string[] = [];

  constructor(opts: { db: Database }) {
    this.kv = new KvRepo(opts.db, 'settings');
  }

  get(): Settings {
    if (!this.cache) this.cache = this.load();
    return structuredClone(this.cache);
  }

  private load(): Settings {
    const defaults = defaultSettings();
    const stored = this.kv.get<Json>(KEY);
    this.loadErrors = [];
    let current: Json = defaults as unknown as Json;
    if (isObj(stored)) {
      // Section by section, so one bad section never wipes the rest.
      for (const [k, v] of Object.entries(stored)) {
        if (!(k in defaults)) continue;
        const candidate = { ...current, [k]: deepMerge((defaults as unknown as Json)[k], v) };
        const r = Settings.safeParse(candidate);
        if (r.success) current = candidate;
        else this.loadErrors.push(`settings.${k}: ${r.error.issues[0]?.message ?? 'invalid'}; reset to defaults`);
      }
    }
    const s = Settings.parse(current);
    s.models.presets = withBuiltIns(s.models.presets, BUILTIN_PRESETS);
    s.techniques = withBuiltIns(s.techniques, BUILTIN_TECHNIQUES).map((t) => ({ ...t, scope: 'global' as const }));
    return s;
  }

  /** Deep-merge a patch, validate, persist, notify. Throws a ZodError for invalid values. */
  update(patch: Record<string, unknown>): Settings {
    // Removed keys (null) fall back to defaults.
    const merged = deepMerge(defaultSettings() as unknown as Json, deepMerge(this.get() as unknown as Json, patch));
    const parsed = Settings.parse(merged);
    this.kv.set(KEY, parsed);
    this.cache = undefined;
    const next = this.get();
    for (const l of this.listeners) l(structuredClone(next));
    return next;
  }

  /** Back to defaults (all sections, or one). */
  reset(section?: keyof Settings): Settings {
    if (!section) {
      this.kv.delete(KEY);
      this.cache = undefined;
      const s = this.get();
      for (const l of this.listeners) l(structuredClone(s));
      return s;
    }
    return this.update({ [section]: null });
  }

  onChange(fn: SettingsListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /* presets */

  presets(): FocusPreset[] {
    return this.get().models.presets;
  }

  preset(id: string): FocusPreset | undefined {
    return this.presets().find((p) => p.id === id);
  }

  /** Strategy for a preset id; `custom` means the last strategy used in Spawn. Falls back to Balanced. */
  strategyFor(presetId?: string): ModelStrategy {
    const s = this.get();
    const id = presetId ?? s.models.defaultPresetId;
    if (id === 'custom' && s.models.lastUsedStrategy) return s.models.lastUsedStrategy;
    return (this.preset(id) ?? this.preset('balanced') ?? BUILTIN_PRESETS[1]!).strategy;
  }

  savePreset(preset: FocusPreset): FocusPreset {
    const p = FocusPreset.parse(preset);
    const list = this.presets();
    const i = list.findIndex((x) => x.id === p.id);
    if (i >= 0) list[i] = { ...p, builtIn: list[i]!.builtIn };
    else list.push({ ...p, builtIn: false });
    return this.update({ models: { presets: list } }).models.presets.find((x) => x.id === p.id)!;
  }

  resetPreset(id: string): FocusPreset | undefined {
    const b = BUILTIN_PRESETS.find((x) => x.id === id);
    if (!b) return undefined;
    return this.savePreset(structuredClone(b));
  }

  deletePreset(id: string): void {
    if (BUILTIN_PRESETS.some((b) => b.id === id)) throw new Error('Built-in presets can be reset, not deleted.');
    this.update({ models: { presets: this.presets().filter((p) => p.id !== id) } });
  }

  /* techniques */

  /** Global techniques (built-in + own), followed by the project's when `projectPath` is given. */
  async techniques(projectPath?: string): Promise<Technique[]> {
    const global = this.get().techniques;
    if (!projectPath) return global;
    const project = await readOideFile(projectPath, 'techniques');
    return [...global, ...project.value.techniques];
  }

  /** Save to global settings, or to `<repo>/.oide/techniques.json` when `projectPath` is given. */
  async saveTechnique(technique: Technique, projectPath?: string): Promise<Technique> {
    if (projectPath) {
      const t = Technique.parse({ ...technique, scope: 'project', builtIn: false });
      const cur = await readOideFile(projectPath, 'techniques');
      if (cur.errors.length && cur.exists) throw new Error(`Fix .oide/techniques.json first: ${cur.errors.join('; ')}`);
      const list = cur.value.techniques.filter((x) => x.id !== t.id);
      const idx = cur.value.techniques.findIndex((x) => x.id === t.id);
      if (idx >= 0) list.splice(idx, 0, t);
      else list.push(t);
      await writeOideFile(projectPath, 'techniques', { version: 1, techniques: list });
      return t;
    }
    const t = Technique.parse({ ...technique, scope: 'global' });
    const list = this.get().techniques;
    const i = list.findIndex((x) => x.id === t.id);
    if (i >= 0) list[i] = { ...t, builtIn: list[i]!.builtIn };
    else list.push({ ...t, builtIn: false });
    return this.update({ techniques: list }).techniques.find((x) => x.id === t.id)!;
  }

  async deleteTechnique(id: string, projectPath?: string): Promise<void> {
    if (projectPath) {
      const cur = await readOideFile(projectPath, 'techniques');
      await writeOideFile(projectPath, 'techniques', { version: 1, techniques: cur.value.techniques.filter((t) => t.id !== id) });
      return;
    }
    if (BUILTIN_TECHNIQUES.some((b) => b.id === id)) throw new Error('Built-in techniques can be reset or turned off, not deleted.');
    this.update({ techniques: this.get().techniques.filter((t) => t.id !== id) });
  }

  resetTechnique(id: string): Technique | undefined {
    const b = BUILTIN_TECHNIQUES.find((x) => x.id === id);
    if (!b) return undefined;
    const list = this.get().techniques.map((t) => (t.id === id ? structuredClone(b) : t));
    return this.update({ techniques: list }).techniques.find((x) => x.id === id);
  }

  /* projects */

  /**
   * Global settings with `<repo>/.oide/*.json` applied. Workspace trust: untrusted projects get no
   * setup command, no `allow` rules, no default-mode override, no enabled extensions, and their
   * techniques are off by default and limited to the first message.
   * A project can never turn on Bypass by itself.
   */
  async forProject(projectPath: string, opts: { trusted: boolean }): Promise<EffectiveProjectSettings> {
    const files = await readAllOideFiles(projectPath);
    const settings = this.get();
    const { config } = files;
    if (opts.trusted && config.defaultMode && (config.defaultMode !== 'bypassPermissions' || settings.claude.allowBypass)) {
      settings.claude.defaultMode = config.defaultMode;
    }
    if (config.presetId && settings.models.presets.some((p) => p.id === config.presetId)) settings.models.defaultPresetId = config.presetId;
    // Untrusted: project techniques are off, can't reach the system prompt, and are labelled by origin.
    // SEC-36: a launch picks techniques by id, so a project technique that reuses a global id
    // (`review`, on by default) or an extension's `ext:` id would ride along with it, even when the
    // project is untrusted and its techniques are meant to start off. Those are dropped.
    const globalIds = new Set(settings.techniques.map((t) => t.id));
    const projectTechniques = files.techniques.techniques.filter((t) => !globalIds.has(t.id) && !t.id.startsWith('ext:')).map((t) =>
      opts.trusted ? { ...t, scope: 'project' as const } : { ...t, scope: 'project' as const, enabledByDefault: false, placement: 'first-message' as const, name: `${t.name} (from untrusted project)` },
    );
    return {
      settings,
      config,
      permissions: opts.trusted ? files.permissions : { ...files.permissions, allow: [] },
      techniques: [...settings.techniques, ...projectTechniques],
      // Untrusted projects can't pre-enable extension tools (they are MCP servers).
      extensions: opts.trusted ? files.extensions : { ...files.extensions, enabled: {} },
      setup: opts.trusted ? config.setup : undefined,
      trusted: opts.trusted,
      errors: files.errors,
    };
  }

  /** Save `.oide/permissions.json` (Settings > Permissions for a project). */
  async saveProjectPermissions(projectPath: string, rules: { allow: string[]; ask: string[]; deny: string[] }): Promise<ProjectPermissions> {
    return writeOideFile(projectPath, 'permissions', { version: 1, ...rules });
  }

  async saveProjectConfig(projectPath: string, config: Partial<ProjectConfig>): Promise<ProjectConfig> {
    const cur = await readOideFile(projectPath, 'config');
    return writeOideFile(projectPath, 'config', { ...cur.value, ...config, version: 1 });
  }
}
