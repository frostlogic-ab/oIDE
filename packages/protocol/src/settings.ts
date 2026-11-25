import { z } from 'zod';
import { Effort, Id, ModelStrategy, PermissionMode } from './agent.js';
import { UpdateChannel } from './updates.js';

export const Technique = z.object({
  id: Id,
  name: z.string(),
  description: z.string().default(''),
  text: z.string(),
  /** `first-message` is appended to the goal; `system-prompt` goes to --append-system-prompt. */
  placement: z.enum(['first-message', 'system-prompt']),
  builtIn: z.boolean().default(false),
  enabledByDefault: z.boolean().default(false),
  scope: z.enum(['global', 'project']).default('global'),
  /** Display name of the extension that contributes it (`contributes.techniques`); read-only in Settings. */
  extension: z.string().optional(),
});
export type Technique = z.infer<typeof Technique>;

export const FocusPreset = z.object({
  id: Id,
  name: z.string(),
  description: z.string().default(''),
  strategy: ModelStrategy,
  /** Shipped with oIDE (Cheap, Balanced, Quality); can be edited and reset, not deleted. */
  builtIn: z.boolean().default(false),
});
export type FocusPreset = z.infer<typeof FocusPreset>;

export const CustomModel = z.object({
  id: Id,
  name: z.string(),
  provider: z.enum(['compatible-api', 'local', 'bedrock', 'vertex']),
  baseUrl: z.string().optional(),
  model: z.string(),
  /** True when a key is stored in the keychain. The key itself never crosses IPC. */
  hasKey: z.boolean().default(false),
  extraEnv: z.record(z.string(), z.string()).default({}),
});
export type CustomModel = z.infer<typeof CustomModel>;

export const Settings = z.object({
  claude: z.object({
    cliPath: z.string().optional(),
    defaultMode: PermissionMode.default('auto'),
    allowBypass: z.boolean().default(false),
    extraFlags: z.string().default(''),
  }),
  models: z.object({
    defaultPresetId: Id.default('balanced'),
    presets: z.array(FocusPreset).default([]),
    defaultEffort: Effort.optional(),
    custom: z.array(CustomModel).default([]),
    /** Model family (haiku, sonnet, opus, fable) → 'latest' or a pinned version from KNOWN_MODEL_VERSIONS. */
    versions: z.record(z.string(), z.string()).default({}),
    /** Strategy last used in Spawn, for the "Custom (last used)" default focus. */
    lastUsedStrategy: ModelStrategy.optional(),
  }),
  agents: z.object({
    maxRunning: z.number().int().min(1).max(32).default(3),
    worktreeLocation: z.enum(['app-data', 'sibling']).default('app-data'),
    cleanup: z.enum(['after-7-days', 'right-away', 'never']).default('after-7-days'),
    contextWarnAt: z.number().min(0).max(1).default(0.7),
    contextSuggestCompactAt: z.number().min(0).max(1).default(0.85),
    notifications: z.object({
      needsPermission: z.boolean().default(true),
      readyForReview: z.boolean().default(true),
      error: z.boolean().default(true),
    }),
    fetchIntervalMinutes: z.number().int().min(0).default(10),
  }),
  techniques: z.array(Technique).default([]),
  permissions: z.object({
    alwaysAllowed: z.array(z.string()).default([]),
    alwaysDenied: z.array(z.string()).default([]),
    /** Settings > Permissions > Defaults. Project rules override these. */
    defaults: z
      .object({
        editFiles: z.enum(['allow', 'ask']).default('allow'),
        shell: z.enum(['ask', 'allow']).default('ask'),
        network: z.enum(['ask', 'allow', 'block']).default('ask'),
      })
      .default({ editFiles: 'allow', shell: 'ask', network: 'ask' }),
  }),
  ui: z.object({
    accent: z.string().default('#7AA2F7'),
    /**
     * @deprecated Unused. oIDE collects no usage statistics and has no telemetry code; the Settings
     * switch was removed. Kept only so settings files saved by 0.1.x still parse. Nothing reads it.
     */
    telemetry: z.boolean().default(false),
    /** Settings › Privacy › Crash reports. Off by default; local only (never uploaded in v1). */
    crashReports: z.boolean().default(false),
  }),
  /** Settings › Updates (M7). Defaulted as a whole so settings saved before M7 still parse. */
  updates: z
    .object({
      channel: UpdateChannel.default('stable'),
      /** Look for updates at startup and every few hours. Downloading and installing always need a click. */
      checkAutomatically: z.boolean().default(true),
    })
    .default({ channel: 'stable', checkAutomatically: true }),
  /**
   * Settings › Extensions › Marketplace index URL. Empty (the default) means the index bundled with
   * the app is the only one: oIDE fetches no remote index. Setting an https URL needs a native
   * confirmation in main (`confirmExecSettings`). See packages/protocol/src/distribution.ts.
   */
  marketplace: z
    .object({ indexUrl: z.string().max(2048).default('') })
    .default({ indexUrl: '' }),
  /**
   * Settings › Keyboard shortcuts: the user's rebinds, action id → key combos ("Mod+K", "J").
   * Only changed actions are stored; a missing action uses the built-in default, `[]` unbinds it.
   */
  keybindings: z.record(z.string().min(1).max(100), z.array(z.string().min(1).max(40)).max(4)).default({}),
});
export type Settings = z.infer<typeof Settings>;

/** `<repo>/.oide/config.json` */
export const ProjectConfig = z.object({
  version: z.literal(1).default(1),
  defaultMode: PermissionMode.optional(),
  presetId: Id.optional(),
  setup: z.string().optional(),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** `<repo>/.oide/permissions.json` */
export const ProjectPermissions = z.object({
  version: z.literal(1).default(1),
  allow: z.array(z.string()).default([]),
  ask: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
});
export type ProjectPermissions = z.infer<typeof ProjectPermissions>;

/** `<repo>/.oide/techniques.json` */
export const ProjectTechniques = z.object({
  version: z.literal(1).default(1),
  techniques: z.array(Technique).default([]),
});
export type ProjectTechniques = z.infer<typeof ProjectTechniques>;

/** `<repo>/.oide/extensions.json` */
export const ProjectExtensions = z.object({
  version: z.literal(1).default(1),
  enabled: z.record(z.string(), z.string()).default({}),
});
export type ProjectExtensions = z.infer<typeof ProjectExtensions>;

export const CliInfo = z.object({
  found: z.boolean(),
  path: z.string().optional(),
  version: z.string().optional(),
  inTestedRange: z.boolean().default(false),
  signedIn: z.enum(['yes', 'no', 'unknown']).default('unknown'),
  /** Flags detected from `claude --help`, used to hide unsupported controls. */
  features: z.record(z.string(), z.boolean()).default({}),
});
export type CliInfo = z.infer<typeof CliInfo>;

/** Tested CLI range. Updated by the weekly fixture job. */
export const TESTED_CLI_RANGE = { min: '2.1.0', max: '2.99.99' } as const;

/** Context windows by model family, used for the context ring. */
export const CONTEXT_WINDOWS: Array<{ match: RegExp; tokens: number }> = [
  { match: /\[1m\]/i, tokens: 1_000_000 },
  { match: /opus|sonnet|haiku|fable|claude/i, tokens: 200_000 },
];
export function contextWindowFor(model: string | undefined): number {
  if (!model) return 200_000;
  for (const c of CONTEXT_WINDOWS) if (c.match.test(model)) return c.tokens;
  return 200_000;
}

/**
 * Model families Presets and Spawn refer to, and the versions oIDE knows for each (newest first).
 * Settings > Models > Model versions pins a family to one of these; "latest" passes the family alias
 * to the CLI so it follows new releases. Used when the CLI cannot list models itself.
 */
export const MODEL_FAMILIES = ['haiku', 'sonnet', 'opus', 'fable'] as const;
export type ModelFamily = (typeof MODEL_FAMILIES)[number];
export const KNOWN_MODEL_VERSIONS: Record<ModelFamily, Array<{ version: string; id: string }>> = {
  haiku: [{ version: '5.5', id: 'claude-haiku-5-5' }],
  sonnet: [{ version: '5.5', id: 'claude-sonnet-5-5' }],
  opus: [
    { version: '5.5', id: 'claude-opus-5-5' },
    { version: '5', id: 'claude-opus-5' },
    { version: '4.8', id: 'claude-opus-4-8' },
  ],
  fable: [{ version: '5.2', id: 'claude-fable-5-2' }],
};

/**
 * Turn a slot model ("opus", or an exact id) into what goes to `--model`: the family alias when the
 * family is on "latest" (or unknown), the pinned model id otherwise. Exact ids pass through.
 */
export function resolveModel(model: string, versions: Record<string, string> = {}): string {
  const fam = model.toLowerCase() as ModelFamily;
  if (!(MODEL_FAMILIES as readonly string[]).includes(fam)) return model;
  const pinned = versions[fam];
  if (!pinned || pinned === 'latest') return fam;
  return KNOWN_MODEL_VERSIONS[fam].find((v) => v.version === pinned || v.id === pinned)?.id ?? fam;
}

/**
 * A permission rule oIDE is willing to pass to `--allowedTools` / `--disallowedTools`:
 * a tool name (`Edit`, `mcp__srv__tool`) optionally followed by `(specifier)`. The specifier may not
 * contain rule or list syntax (`(`, `)`, `,`), quotes, backslashes or newlines, so one rule can never
 * turn into several (e.g. `Bash(x) Bash(*)`) when the CLI splits the list. A trailing `:*` prefix
 * wildcard is allowed only for rules a person typed; suggested rules never contain `*` (see
 * `isSafeSuggestedSpecifier`).
 */
export function isValidPermissionRule(rule: string): boolean {
  if (rule.length === 0 || rule.length > 300) return false;
  const m = /^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/.exec(rule);
  if (!m) return false;
  const spec = m[2];
  if (spec === undefined) return true;
  if (spec.trim() === '' || /[(),"'`\\\r\n]/.test(spec)) return false;
  // `*` only as the CLI's trailing prefix wildcard `:*`, or as a whole-specifier glob in paths like `src/**`.
  const withoutTrailing = spec.endsWith(':*') ? spec.slice(0, -2) : spec;
  if (/\*/.test(withoutTrailing) && !/^[A-Za-z0-9_./~-]+$/.test(withoutTrailing.replace(/\*/g, ''))) return false;
  return true;
}

/** Characters allowed in an exact command we suggest for "Always in <project>". */
export function isSafeSuggestedSpecifier(spec: string): boolean {
  return spec.length > 0 && spec.length <= 200 && !/[(),"'`*:\r\n]/.test(spec);
}
