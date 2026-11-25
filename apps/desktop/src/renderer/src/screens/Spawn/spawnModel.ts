/**
 * Spawn form model: defaults from Settings, focus presets, strategy ↔ slots, CLI feature gating,
 * and `buildSpec`, which turns the form into a protocol `AgentSpec` (Zod-validated) or errors.
 * Page: docs/wiki/pages/screen-spawn.md. No React here.
 */
import {
  AgentSpec,
  KNOWN_MODEL_VERSIONS,
  MODEL_FAMILIES,
  type CliInfo,
  type ContextChip,
  type CustomModel,
  type Effort,
  type FocusPreset,
  type InstalledExtension,
  type ModelFamily,
  type ModelSlot,
  type ModelStrategy,
  type PermissionMode,
  type Project,
  type Scope,
  type Settings,
  type Technique,
  type ToolRisk,
  type WorkIn,
} from '@oide/protocol';

export type StrategyKind = ModelStrategy['kind'];
export type SlotKey = 'lead' | 'subagents' | 'simple' | 'standard' | 'complex';
export type Slots = Record<SlotKey, ModelSlot>;

export interface SpawnForm {
  goal: string;
  context: ContextChip[];
  projectId: string;
  workIn: WorkIn;
  mode: PermissionMode;
  kind: StrategyKind;
  /** Every slot is kept so switching strategies does not lose choices. Custom models: `custom:<id>`. */
  slots: Slots;
  /** The user clicked "Custom" (keeps Custom selected even if the slots match a preset). */
  customPicked: boolean;
  techniques: Record<string, boolean>;
  extensions: Record<string, boolean>;
  attempts: number;
}

export const MAX_ATTEMPTS = 6;
export const CUSTOM_PREFIX = 'custom:';

/** Mirrors the built-in presets of packages/store (used only when Settings has none yet). */
export const FALLBACK_PRESETS: FocusPreset[] = [
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
    description: 'Opus leads and routes subagents by task size.',
    builtIn: true,
    strategy: {
      kind: 'routed',
      lead: { model: 'opus', effort: 'high' },
      simple: { model: 'haiku', effort: 'low' },
      standard: { model: 'sonnet', effort: 'medium' },
      complex: { model: 'opus', effort: 'high' },
    },
  },
  { id: 'quality', name: 'Quality', description: 'Opus for everything, at maximum effort.', builtIn: true, strategy: { kind: 'single', lead: { model: 'opus', effort: 'max' } } },
];

/** Card hints from Spawn.dc.html for the built-in presets (Settings descriptions are longer). */
export const PRESET_HINTS: Record<string, string> = {
  cheap: 'Lowest usage. Haiku does most subagent work.',
  balanced: 'Opus leads and routes subagents by task size.',
  quality: 'Opus at max effort for everything.',
};

export const MODE_OPTIONS: Array<{ mode: PermissionMode; label: string; desc: string }> = [
  { mode: 'default', label: 'Manual', desc: 'Asks before every edit.' },
  { mode: 'acceptEdits', label: 'Edit automatically', desc: 'Edits files without asking.' },
  { mode: 'plan', label: 'Plan', desc: 'Explores, then presents a plan first.' },
  { mode: 'auto', label: 'Auto', desc: 'Approves safe actions, pauses on risky ones.' },
  { mode: 'bypassPermissions', label: 'Bypass permissions', desc: 'Never asks. Use with care.' },
];

export const STRATEGY_OPTIONS: Array<{ kind: StrategyKind; label: string; desc: string }> = [
  { kind: 'single', label: 'One model', desc: 'Orchestrator and subagents use the same model.' },
  { kind: 'subagent-model', label: 'Separate subagent model', desc: 'Subagents always use their own model.' },
  { kind: 'routed', label: 'Routed by orchestrator', desc: 'The orchestrator picks a model per subagent task.' },
];

export const WORK_IN_OPTIONS: Array<{ value: WorkIn; label: string }> = [
  { value: 'worktree-from-main', label: 'New worktree from main' },
  { value: 'worktree-from-current', label: 'New worktree from current branch' },
  { value: 'project-folder', label: 'Project folder directly' },
];

export const EFFORTS: Array<{ value: Effort; label: string; short: string }> = [
  { value: 'low', label: 'Effort: Low', short: 'low' },
  { value: 'medium', label: 'Effort: Medium', short: 'medium' },
  { value: 'high', label: 'Effort: High', short: 'high' },
  { value: 'xhigh', label: 'Effort: X-High', short: 'x-high' },
  { value: 'max', label: 'Effort: Max', short: 'max' },
];

const FAMILY_LABEL: Record<ModelFamily, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };

// ---------- CLI features ----------

/** True unless the detected CLI explicitly lacks the feature (unknown CLI → show everything). */
export function hasFeature(cli: CliInfo | null | undefined, key: string): boolean {
  const f = cli?.features;
  if (!f || !Object.keys(f).length) return true;
  return f[key] === true;
}

export function availableEfforts(cli: CliInfo | null | undefined): Effort[] {
  const f = cli?.features ?? {};
  if (Object.keys(f).length && f.effort === false) return [];
  const listed = EFFORTS.filter((e) => f[`effort:${e.value}`]).map((e) => e.value);
  return listed.length ? listed : EFFORTS.map((e) => e.value);
}

export function availableModes(cli: CliInfo | null | undefined, allowBypass: boolean): PermissionMode[] {
  const f = cli?.features ?? {};
  const detected = Object.keys(f).some((k) => k.startsWith('mode:'));
  return MODE_OPTIONS.map((m) => m.mode).filter((m) => {
    if (m === 'bypassPermissions' && !allowBypass) return false;
    return !detected || f[`mode:${m}`] === true;
  });
}

export function availableStrategies(cli: CliInfo | null | undefined): StrategyKind[] {
  return STRATEGY_OPTIONS.map((s) => s.kind).filter((k) => k !== 'routed' || hasFeature(cli, 'agents'));
}

// ---------- models ----------

export function familyOf(model: string): ModelFamily | undefined {
  const m = model.toLowerCase();
  return MODEL_FAMILIES.find((f) => m === f || m.includes(f));
}

export function modelLabel(model: string, custom: CustomModel[] = []): string {
  if (model.startsWith(CUSTOM_PREFIX)) return custom.find((c) => CUSTOM_PREFIX + c.id === model)?.name ?? model.slice(CUSTOM_PREFIX.length);
  const fam = familyOf(model);
  return fam ? FAMILY_LABEL[fam] : model;
}

/** "latest" when the slot uses the family alias, else the pinned version ("5.5"). */
export function slotVersion(model: string): string {
  const fam = familyOf(model);
  if (!fam || model.toLowerCase() === fam) return 'latest';
  return KNOWN_MODEL_VERSIONS[fam].find((v) => v.id === model)?.version ?? 'latest';
}

/** Model value for a family at a version ("latest" → alias, else exact id). */
export function modelFor(family: ModelFamily, version: string): string {
  if (version === 'latest') return family;
  return KNOWN_MODEL_VERSIONS[family].find((v) => v.version === version)?.id ?? family;
}

/** Default value when a family pill is picked: follows Settings › Models › Model versions. */
export function defaultModelFor(family: ModelFamily, versions: Record<string, string> = {}): string {
  return modelFor(family, versions[family] ?? 'latest');
}

/**
 * Bare family aliases ("opus") → the version Settings › Models › Model versions pins (exact id),
 * or the alias itself when the family follows "Latest". The CLI gets exactly this as `--model`.
 */
export function applyVersions(slots: Slots, versions: Record<string, string> = {}): Slots {
  const out = { ...slots };
  for (const k of Object.keys(out) as SlotKey[]) {
    const m = out[k].model;
    const fam = familyOf(m);
    if (fam && m.toLowerCase() === fam) out[k] = { ...out[k], model: defaultModelFor(fam, versions) };
  }
  return out;
}

function sameSlot(a: ModelSlot | undefined, b: ModelSlot | undefined): boolean {
  if (!a || !b) return false;
  const fa = a.model.startsWith(CUSTOM_PREFIX) ? a.model : (familyOf(a.model) ?? a.model);
  const fb = b.model.startsWith(CUSTOM_PREFIX) ? b.model : (familyOf(b.model) ?? b.model);
  return fa === fb && (a.effort ?? null) === (b.effort ?? null);
}

// ---------- strategy ↔ slots ----------

const BASE_SLOTS: Slots = {
  lead: { model: 'opus', effort: 'high' },
  subagents: { model: 'haiku', effort: 'low' },
  simple: { model: 'haiku', effort: 'low' },
  standard: { model: 'sonnet', effort: 'medium' },
  complex: { model: 'opus', effort: 'high' },
};

export function slotsFromStrategy(strategy: ModelStrategy, base: Slots = BASE_SLOTS): Slots {
  const s: Slots = { ...base, lead: strategy.lead };
  if (strategy.kind === 'subagent-model') s.subagents = strategy.subagents;
  if (strategy.kind === 'routed') Object.assign(s, { simple: strategy.simple, standard: strategy.standard, complex: strategy.complex });
  return s;
}

export function toStrategy(kind: StrategyKind, slots: Slots): ModelStrategy {
  if (kind === 'single') return { kind, lead: slots.lead };
  if (kind === 'subagent-model') return { kind, lead: slots.lead, subagents: slots.subagents };
  return { kind, lead: slots.lead, simple: slots.simple, standard: slots.standard, complex: slots.complex };
}

export function presetsOf(settings: Settings | null | undefined): FocusPreset[] {
  const list = settings?.models.presets ?? [];
  return list.length ? list : FALLBACK_PRESETS;
}

/** The preset whose strategy matches the form (only the fields the strategy uses), else 'custom'. */
export function matchPreset(kind: StrategyKind, slots: Slots, presets: FocusPreset[]): string {
  for (const p of presets) {
    const st = p.strategy;
    if (st.kind !== kind || !sameSlot(st.lead, slots.lead)) continue;
    if (st.kind === 'subagent-model' && !sameSlot(st.subagents, slots.subagents)) continue;
    if (st.kind === 'routed' && !(sameSlot(st.simple, slots.simple) && sameSlot(st.standard, slots.standard) && sameSlot(st.complex, slots.complex))) continue;
    return p.id;
  }
  return 'custom';
}

export function slotRows(kind: StrategyKind): Array<{ key: SlotKey; label: string }> {
  if (kind === 'single') return [{ key: 'lead', label: 'All agents' }];
  if (kind === 'subagent-model')
    return [
      { key: 'lead', label: 'Orchestrator' },
      { key: 'subagents', label: 'Subagents' },
    ];
  return [
    { key: 'lead', label: 'Orchestrator' },
    { key: 'simple', label: 'Simple subagent tasks' },
    { key: 'standard', label: 'Standard subagent tasks' },
    { key: 'complex', label: 'Complex subagent tasks' },
  ];
}

/** "Orchestrator Opus (high) · subagents routed Haiku / Sonnet / Opus". */
export function strategySummary(kind: StrategyKind, slots: Slots, custom: CustomModel[] = [], showEffort = true): string {
  const name = (k: SlotKey) => modelLabel(slots[k].model, custom);
  const me = (k: SlotKey) => {
    const e = EFFORTS.find((x) => x.value === slots[k].effort)?.short;
    return showEffort && e ? `${name(k)} (${e})` : name(k);
  };
  if (kind === 'single') return `${me('lead')} for everything`;
  if (kind === 'subagent-model') return `Orchestrator ${me('lead')} · subagents ${me('subagents')}`;
  return `Orchestrator ${me('lead')} · subagents routed ${name('simple')} / ${name('standard')} / ${name('complex')}`;
}

// ---------- extensions ----------

export function extensionEnabledFor(ext: InstalledExtension, projectId: string): boolean {
  if (ext.enabledProjects.includes(projectId)) return true;
  return ext.enabledGlobally && !ext.disabledProjects.includes(projectId);
}

/** Tool names and risks an extension gives agents (minus tools the user turned off). */
export function extensionTools(ext: InstalledExtension): Array<{ name: string; risk: ToolRisk }> {
  const out: Array<{ name: string; risk: ToolRisk }> = [];
  for (const [server, def] of Object.entries(ext.manifest.oide.mcpServers)) {
    for (const [tool, t] of Object.entries(def.tools)) {
      if (!ext.disabledTools.includes(`mcp__${server}__${tool}`)) out.push({ name: tool, risk: t.risk });
    }
  }
  return out;
}

export function extensionRisk(ext: InstalledExtension): 'read' | 'ask' | 'none' {
  const tools = extensionTools(ext);
  if (!tools.length) return 'none';
  return tools.some((t) => t.risk === 'ask') ? 'ask' : 'read';
}

export function defaultExtensions(list: InstalledExtension[], projectId: string): Record<string, boolean> {
  return Object.fromEntries(list.filter((e) => extensionTools(e).length).map((e) => [e.id, extensionEnabledFor(e, projectId)]));
}

export function defaultTechniques(list: Technique[]): Record<string, boolean> {
  return Object.fromEntries(list.map((t) => [t.id, t.enabledByDefault]));
}

// ---------- initial form ----------

export interface InitialInput {
  settings: Settings | null;
  projects: Project[];
  scope: Scope;
  params: { projectId?: string; goal?: string; context?: ContextChip[] };
  cli: CliInfo | null;
  /** The chosen project's effective defaults (`settings.forProject`: `.oide/config.json` under trust). */
  projectDefaults?: { defaultMode?: PermissionMode; presetId?: string };
}

export function initialForm({ settings, projects, scope, params, cli, projectDefaults }: InitialInput): SpawnForm {
  const presets = presetsOf(settings);
  const preferred = projectDefaults?.presetId ?? settings?.models.defaultPresetId ?? 'balanced';
  const strategies = availableStrategies(cli);
  const preset = presets.find((p) => p.id === preferred && strategies.includes(p.strategy.kind)) ?? presets.find((p) => strategies.includes(p.strategy.kind));
  const strategy: ModelStrategy = (!preset || !presets.some((p) => p.id === preferred)) && settings?.models.lastUsedStrategy ? settings.models.lastUsedStrategy : (preset?.strategy ?? FALLBACK_PRESETS[1]!.strategy);
  const projectId =
    (params.projectId && projects.some((p) => p.id === params.projectId) && params.projectId) || (scope !== 'all' && projects.some((p) => p.id === scope) ? scope : projects[0]?.id) || '';
  const modes = availableModes(cli, settings?.claude.allowBypass ?? false);
  const wanted = projectDefaults?.defaultMode ?? settings?.claude.defaultMode ?? 'auto';
  const mode = modes.includes(wanted) ? wanted : modes.includes('auto') ? 'auto' : (modes[0] ?? 'default');
  return {
    goal: params.goal ?? '',
    context: params.context ? [...params.context] : [],
    projectId,
    workIn: 'worktree-from-main',
    mode,
    kind: strategy.kind,
    slots: applyVersions(slotsFromStrategy(strategy), settings?.models.versions),
    customPicked: false,
    techniques: defaultTechniques(settings?.techniques ?? []),
    extensions: {},
    attempts: 1,
  };
}

// ---------- build ----------

export type SpawnField = 'goal' | 'projectId' | 'mode' | 'workIn' | 'strategy' | 'attempts' | 'context' | 'form';
export type BuildResult = { ok: true; spec: AgentSpec } | { ok: false; errors: Partial<Record<SpawnField, string>> };

export interface BuildContext {
  allowBypass: boolean;
  customModels?: CustomModel[];
  /** Technique order from Settings (ids). Selected ids are emitted in this order. */
  techniqueOrder?: string[];
  newId?: () => string;
}

/** A 1-line title from the goal: first line or sentence, at most 80 characters. */
export function titleFromGoal(goal: string): string {
  const firstLine = goal.trim().split(/\r?\n/)[0] ?? '';
  const sentence = /^(.+?[.!?])(\s|$)/.exec(firstLine)?.[1] ?? firstLine;
  const t = sentence.replace(/[.!?]+$/, '').trim();
  return t.length > 80 ? `${t.slice(0, 79).trimEnd()}…` : t;
}

function randomId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildSpec(form: SpawnForm, ctx: BuildContext): BuildResult {
  const errors: Partial<Record<SpawnField, string>> = {};
  const goal = form.goal.trim();
  if (!goal) errors.goal = 'Describe what the agent should do.';
  if (!form.projectId) errors.projectId = 'Pick a project.';
  if (form.mode === 'bypassPermissions') {
    if (!ctx.allowBypass) errors.mode = 'Bypass is off. Turn on Settings › Claude Code › Allow Bypass to use it.';
    else if (form.workIn === 'project-folder') errors.mode = 'Bypass agents always run in their own worktree, never in the project folder.';
  }
  if (form.attempts > 1 && form.workIn === 'project-folder') errors.workIn = 'Parallel attempts need their own worktrees. Pick a new worktree, or run one attempt.';
  if (Object.keys(errors).length) return { ok: false, errors };

  // Custom models ("Your models") only apply to the lead; the supervisor sets their env per agent.
  const slots: Slots = { ...form.slots };
  let customModel: { id: string } | undefined;
  if (slots.lead.model.startsWith(CUSTOM_PREFIX)) {
    const id = slots.lead.model.slice(CUSTOM_PREFIX.length);
    const cm = ctx.customModels?.find((c) => c.id === id);
    customModel = { id };
    slots.lead = { ...slots.lead, model: cm?.model ?? id };
  }

  const order = ctx.techniqueOrder ?? Object.keys(form.techniques);
  const techniques = order.filter((id) => form.techniques[id]);
  const extensions = Object.entries(form.extensions)
    .filter(([, on]) => on)
    .map(([id]) => id);
  const attempts = Math.min(MAX_ATTEMPTS, Math.max(1, Math.round(form.attempts)));

  const parsed = AgentSpec.safeParse({
    projectId: form.projectId,
    title: titleFromGoal(goal) || 'Untitled agent',
    // A stand-in: the agent names the task itself (mcp__oide__set_title) once it starts.
    autoTitle: true,
    goal,
    context: form.context,
    workIn: form.workIn,
    mode: form.mode,
    strategy: toStrategy(form.kind, slots),
    ...(customModel ? { customModel } : {}),
    techniques,
    extensions,
    attempts,
    ...(attempts > 1 ? { attemptGroup: (ctx.newId ?? randomId)() } : {}),
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const head = String(issue.path[0] ?? 'form');
      const field: SpawnField = head === 'title' || head === 'goal' ? 'goal' : head === 'projectId' || head === 'mode' || head === 'workIn' || head === 'strategy' || head === 'attempts' || head === 'context' ? head : 'form';
      errors[field] ??= issue.message;
    }
    return { ok: false, errors };
  }
  return { ok: true, spec: parsed.data };
}
