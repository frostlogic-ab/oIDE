import { z } from 'zod';
import { Effort, Id, ModelStrategy, PermissionMode } from './agent.js';

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
    telemetry: z.boolean().default(false),
  }),
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
