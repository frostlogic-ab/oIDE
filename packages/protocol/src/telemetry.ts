import { z } from 'zod';
import { ArchiveReason, Effort, PermissionMode, WorkIn } from './agent.js';
import { ArtifactKind } from './artifacts.js';
import { ScriptRunner } from './scripts.js';
import { UpdateChannel, UpdateInstallTrigger } from './updates.js';
import { WindowOpenTrigger } from './windows.js';

/**
 * Opt-in usage analytics and error reports (docs/wiki/pages/telemetry.md, ADR 0011).
 *
 * This file is the ONE allow-list. Main is the only sender: it drops any event whose name is not in
 * `TELEMETRY_EVENTS`, strips any property the event does not declare, and drops the event when a
 * declared property has a value outside its schema. Values are enums, booleans, bounded numbers and
 * buckets, never free text. To add an event: add it here (with the product question it answers),
 * emit it from main (or list it as `from: 'renderer'`), and add it to the wiki page in the same change.
 *
 * Never send: file paths, project / repo / branch names, agent titles or goals, prompts, model
 * output, tool inputs, commit messages, artifact contents, extension settings, env values, URLs the
 * user visits, Claude account information, or ids of custom / local extensions.
 */

// ------------------------------------------------------------------------------------ buckets

export const COUNT_BUCKETS = ['0', '1', '2-5', '6-20', '21-100', '100+'] as const;
export const CountBucket = z.enum(COUNT_BUCKETS);
export type CountBucket = z.infer<typeof CountBucket>;
export function countBucket(n: number): CountBucket {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 2) return '1';
  if (n <= 5) return '2-5';
  if (n <= 20) return '6-20';
  if (n <= 100) return '21-100';
  return '100+';
}

export const DURATION_BUCKETS = ['<10s', '10s-1m', '1-5m', '5-15m', '15-60m', '1h+'] as const;
export const DurationBucket = z.enum(DURATION_BUCKETS);
export type DurationBucket = z.infer<typeof DurationBucket>;
export function durationBucket(ms: number): DurationBucket {
  const s = Number.isFinite(ms) ? ms / 1000 : 0;
  if (s < 10) return '<10s';
  if (s < 60) return '10s-1m';
  if (s < 300) return '1-5m';
  if (s < 900) return '5-15m';
  if (s < 3600) return '15-60m';
  return '1h+';
}

export const TOKEN_BUCKETS = ['<10k', '10k-100k', '100k-1M', '1M-10M', '10M+'] as const;
export const TokenBucket = z.enum(TOKEN_BUCKETS);
export type TokenBucket = z.infer<typeof TokenBucket>;
export function tokenBucket(n: number): TokenBucket {
  if (!Number.isFinite(n) || n < 10_000) return '<10k';
  if (n < 100_000) return '10k-100k';
  if (n < 1_000_000) return '100k-1M';
  if (n < 10_000_000) return '1M-10M';
  return '10M+';
}

export const MEMORY_BUCKETS = ['<256MB', '256-512MB', '512MB-1GB', '1-2GB', '2GB+'] as const;
export const MemoryBucket = z.enum(MEMORY_BUCKETS);
export type MemoryBucket = z.infer<typeof MemoryBucket>;
export function memoryBucket(bytes: number): MemoryBucket {
  const mb = Number.isFinite(bytes) ? bytes / (1024 * 1024) : 0;
  if (mb < 256) return '<256MB';
  if (mb < 512) return '256-512MB';
  if (mb < 1024) return '512MB-1GB';
  if (mb < 2048) return '1-2GB';
  return '2GB+';
}

/** `2.1.325` → `2.1`; anything that is not a version → `unknown`. */
export const CliVersionBucket = z.string().regex(/^(?:\d{1,3}\.\d{1,3}|unknown|none)$/);
export function cliVersionBucket(v: string | undefined | null): string {
  const m = /^(\d{1,3})\.(\d{1,3})(?:\.|$)/.exec((v ?? '').trim());
  return m ? `${m[1]}.${m[2]}` : 'unknown';
}

/** Screen size rounded down to 100 px steps (`1920x1080` → `1900x1000`): enough for layout questions. */
export function screenBucket(width: number, height: number): string {
  const r = (n: number) =>
    Math.max(0, Math.min(99_900, Math.floor((Number.isFinite(n) ? n : 0) / 100) * 100));
  return `${r(width)}x${r(height)}`;
}

/** An app version such as `0.1.0` or `0.2.0-beta.3`. */
export const AppVersion = z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.]{1,20})?$/);
/** An app version, or `unknown` when the running build's version string is not one. */
export const AppVersionValue = z.union([AppVersion, z.literal('unknown')]);
/** The running app version as sent on events: `0.5.1` stays `0.5.1`; anything else → `unknown`. */
export function appVersionValue(v: string | undefined | null): string {
  const t = (v ?? '').trim();
  return AppVersion.safeParse(t).success ? t : 'unknown';
}

// ------------------------------------------------------------------------------- enum helpers

export const MODEL_FAMILY_VALUES = ['opus', 'sonnet', 'haiku', 'fable', 'custom', 'other'] as const;
export const ModelFamilyValue = z.enum(MODEL_FAMILY_VALUES);
export type ModelFamilyValue = z.infer<typeof ModelFamilyValue>;
/** `opus`, `claude-opus-5-5`, `claude-opus-5-5[1m]` → `opus`. Never the raw id of a custom model. */
export function modelFamilyOf(model: string | undefined, custom = false): ModelFamilyValue {
  if (custom) return 'custom';
  const m = /(opus|sonnet|haiku|fable)/i.exec(model ?? '');
  return m ? (m[1]!.toLowerCase() as ModelFamilyValue) : 'other';
}

/** Tool categories for permission answers. MCP tools are only ever `mcp` (never the server or tool name). */
export const TOOL_CATEGORIES = [
  'Bash',
  'Edit',
  'Write',
  'Read',
  'Search',
  'Web',
  'Task',
  'Plan',
  'Notebook',
  'mcp',
  'other',
] as const;
export const ToolCategory = z.enum(TOOL_CATEGORIES);
export type ToolCategory = z.infer<typeof ToolCategory>;
export function toolCategoryOf(toolName: string | undefined): ToolCategory {
  const t = toolName ?? '';
  if (t.startsWith('mcp__')) return 'mcp';
  if (t === 'Bash' || t === 'BashOutput' || t === 'KillShell' || t === 'KillBash') return 'Bash';
  if (t === 'Edit' || t === 'MultiEdit') return 'Edit';
  if (t === 'Write') return 'Write';
  if (t === 'Read') return 'Read';
  if (t === 'Glob' || t === 'Grep' || t === 'LS') return 'Search';
  if (t === 'WebFetch' || t === 'WebSearch') return 'Web';
  if (t === 'Task' || t === 'Agent') return 'Task';
  if (t === 'ExitPlanMode' || t === 'TodoWrite') return 'Plan';
  if (t === 'NotebookEdit') return 'Notebook';
  return 'other';
}

/** What kind of program held a worktree folder that could not be deleted (never its name or path). */
export const HOLDER_CATEGORIES = ['docker', 'editor', 'terminal', 'node', 'unknown'] as const;

/** Built-in command bar commands (renderer `lib/coreCommands.ts`). Extension commands are never sent. */
export const BUILTIN_COMMAND_IDS = [
  'oide.spawn',
  'oide.jumpToSession',
  'oide.nextNeedsYou',
  'oide.askAgent',
  'oide.go.wall',
  'oide.go.artifacts',
  'oide.go.files',
  'oide.files.search',
  'oide.go.sourceControl',
  'oide.go.marketplace',
  'oide.go.settings',
  'oide.go.usage',
  'oide.scope.all',
  'oide.openProject',
  'oide.cloneProject',
  'oide.newRepository',
  'oide.theme.next',
] as const;

/** Built-in Claude Code CLI slash commands. Skills, plugin and MCP commands are sent as `other`, never by name. */
export const BUILTIN_SLASH_COMMANDS = [
  'compact',
  'context',
  'init',
  'clear',
  'cost',
  'review',
  'security-review',
  'pr-comments',
  'release-notes',
  'model',
  'memory',
  'status',
  'todos',
  'usage',
  'help',
  'agents',
  'hooks',
  'mcp',
  'permissions',
  'doctor',
  'export',
  'add-dir',
] as const;
export function slashCommandOf(command: string): (typeof BUILTIN_SLASH_COMMANDS)[number] | 'other' {
  const name = /^\/?([a-z][\w-]*)/i.exec(command.trim())?.[1]?.toLowerCase() ?? '';
  return (BUILTIN_SLASH_COMMANDS as readonly string[]).includes(name)
    ? (name as (typeof BUILTIN_SLASH_COMMANDS)[number])
    : 'other';
}

/**
 * Settings whose changes are counted (`setting_changed` carries the key, never the value). Keys not
 * listed here (custom models, techniques, permission rules, paths, the marketplace URL's value…) are
 * not reported at all.
 */
export const TELEMETRY_SETTING_KEYS = [
  'claude.cliPath',
  'claude.defaultMode',
  'claude.allowBypass',
  'claude.extraFlags',
  'models.defaultPresetId',
  'models.defaultEffort',
  'models.versions',
  'agents.maxRunning',
  'agents.worktreeLocation',
  'agents.cleanup',
  'agents.contextWarnAt',
  'agents.contextSuggestCompactAt',
  'agents.notifications',
  'agents.fetchIntervalMinutes',
  'permissions.defaults',
  'ui.accent',
  'ui.crashReports',
  'ui.filesLegendHidden',
  'editor.npmVersions',
  'updates.channel',
  'updates.checkAutomatically',
  'updates.downloadAutomatically',
  'updates.installOnQuit',
  'marketplace.indexUrl',
  'keybindings',
] as const;
export type TelemetrySettingKey = (typeof TELEMETRY_SETTING_KEYS)[number];

/** Allow-listed setting keys a `settings.update` patch touches (most specific first, de-duplicated). */
export function settingKeysOf(patch: unknown): TelemetrySettingKey[] {
  const out = new Set<TelemetrySettingKey>();
  const walk = (v: unknown, path: string, depth: number) => {
    const hit = TELEMETRY_SETTING_KEYS.find((k) => k === path);
    if (hit) {
      out.add(hit);
      return;
    }
    if (depth >= 2 || !v || typeof v !== 'object' || Array.isArray(v)) return;
    for (const k of Object.keys(v as Record<string, unknown>))
      walk((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k, depth + 1);
  };
  walk(patch, '', 0);
  return [...out];
}

/** npm-style package names (marketplace ids). Only sent for extensions from the official index. */
export const MarketplaceExtensionId = z
  .string()
  .regex(/^(?:@[a-z0-9][a-z0-9._-]{0,50}\/)?[a-z0-9][a-z0-9._-]{0,80}$/);

/** CLI stream-json event types oIDE did not recognise (`system/foo`), counted per type. */
export const CliEventType = z.string().regex(/^[a-z][a-z0-9_]{0,39}(?:\/[a-z][a-z0-9_]{0,39})?$/);

// ---------------------------------------------------------------------------------- screens

/** Settings sections (renderer `screens/Settings/index.tsx`), for `/settings/<section>` pageviews. */
export const SETTINGS_SECTION_IDS = [
  'cli',
  'models',
  'agents',
  'tech',
  'perms',
  'projects',
  'artifacts',
  'ext',
  'keys',
  'look',
  'privacy',
  'updates',
  'diag',
] as const;
export const TELEMETRY_SCREENS = [
  'wall',
  'focus',
  'spawn',
  'source-control',
  'review',
  'files',
  'artifacts',
  'marketplace',
  'settings',
  'usage',
  'extension',
] as const;
export const TelemetryScreen = z.enum(TELEMETRY_SCREENS);
export type TelemetryScreen = z.infer<typeof TelemetryScreen>;

/** The synthetic pageview URL of a screen: `/wall`, `/settings/privacy`. Never ids or names. */
export function screenPath(screen: TelemetryScreen, section?: string): string {
  if (screen === 'settings')
    return (SETTINGS_SECTION_IDS as readonly string[]).includes(section ?? '')
      ? `/settings/${section}`
      : '/settings/cli';
  return `/${screen}`;
}
/** Every pageview path oIDE can send (docs and tests). */
export const TELEMETRY_PATHS: string[] = TELEMETRY_SCREENS.flatMap((s) =>
  s === 'settings' ? SETTINGS_SECTION_IDS.map((x) => `/settings/${x}`) : [`/${s}`],
);

// -------------------------------------------------------------------------------- catalogue

const Ms = z.number().int().min(0).max(86_400_000);
const SmallCount = z.number().int().min(0).max(10_000);

interface EventDef<S extends z.ZodObject> {
  /** Who may report it: main observes it itself, or the renderer reports it over `telemetry.track`. */
  from: 'main' | 'renderer';
  /** The product question this event answers (every event must answer one). */
  question: string;
  props: S;
}
const def = <S extends z.ZodObject>(d: EventDef<S>): EventDef<S> => d;

export const TELEMETRY_EVENTS = {
  app_started: def({
    from: 'main',
    question:
      'Which oIDE versions are people running, how fast does it start, on which CLI versions, and how big are real workspaces?',
    props: z.object({
      app_version: AppVersionValue,
      cold_start_ms: Ms,
      cli_found: z.boolean(),
      cli_version: CliVersionBucket,
      projects: CountBucket,
      agents: CountBucket,
    }),
  }),
  update_installed: def({
    from: 'main',
    question: 'Do people move to new versions, and from which ones?',
    props: z.object({ from_version: AppVersion, to_version: AppVersion }),
  }),
  update_install_started: def({
    from: 'main',
    question: 'How do people apply updates: from the header Update button, from Settings, or by quitting oIDE?',
    props: z.object({ trigger: UpdateInstallTrigger, channel: UpdateChannel }),
  }),
  window_opened: def({
    from: 'main',
    question: 'Do people work in more than one oIDE window, how do they open the extra windows, and how many do they keep open?',
    props: z.object({ trigger: WindowOpenTrigger, windows: CountBucket }),
  }),
  update_checked: def({
    from: 'main',
    question:
      'Does auto-update work in the field: do checks find releases, and when they fail, is it a missing release, a missing update file or something else?',
    props: z.object({
      outcome: z.enum(['available', 'not_available', 'no_release', 'feed_missing', 'error']),
      channel: UpdateChannel,
    }),
  }),
  telemetry_opt_in: def({
    from: 'main',
    question:
      'Where do people opt in (the first-run prompt or Settings)? Sent only on opt-in, never on opt-out.',
    props: z.object({ source: z.enum(['prompt', 'settings']), errors: z.boolean() }),
  }),
  agent_spawned: def({
    from: 'main',
    question:
      'Which models, efforts, permission modes and isolation do people pick, and do they use parallel attempts and attachments?',
    props: z.object({
      model: ModelFamilyValue,
      effort: z.union([Effort, z.literal('default')]),
      strategy: z.enum(['single', 'subagent-model', 'routed']),
      mode: PermissionMode,
      work_in: WorkIn,
      attempts: z.number().int().min(1).max(6),
      has_attachments: z.boolean(),
      has_context: z.boolean(),
      techniques: SmallCount,
      extensions: SmallCount,
      /** The title is a stand-in from the goal; the agent is asked to name the task (set_title). */
      auto_title: z.boolean().optional(),
      /** Runs on an extra Claude Code account, not the CLI's default config (ADR 0021). */
      other_account: z.boolean().optional(),
    }),
  }),
  agent_titled: def({
    from: 'main',
    question: 'Do agents asked to name their task do so, and how soon after they start?',
    props: z.object({ after: DurationBucket }),
  }),
  agent_finished: def({
    from: 'main',
    question:
      'How do agent runs end, how long do they take, how fast is the first output, and how many subagents and tokens do they use?',
    props: z.object({
      outcome: z.enum(['ready-for-review', 'done', 'error', 'stopped']),
      duration: DurationBucket,
      duration_ms: Ms,
      first_output_ms: Ms.optional(),
      subagents: CountBucket,
      tokens: TokenBucket,
      turns: CountBucket.optional(),
      error_code: z.enum(['auth', 'model_not_found', 'api_error', 'spawn', 'protocol', 'other']).optional(),
    }),
  }),
  permission_answered: def({
    from: 'main',
    question: 'Which kinds of tools ask for permission, how do people answer, and how long do agents wait?',
    props: z.object({
      decision: z.enum(['allow', 'always', 'deny']),
      tool: ToolCategory,
      wait: DurationBucket,
    }),
  }),
  agent_merged: def({
    from: 'main',
    question:
      'How often does agent work get merged locally, and how often does it conflict? How often were uncommitted main-checkout files in the way (stashed, and put back or kept in the stash)?',
    props: z.object({
      result: z.enum(['merged', 'conflicts']),
      local_changes: z.enum(['none', 'stashed_restored', 'stashed_kept']).optional(),
    }),
  }),
  merge_conflict_predicted: def({
    from: 'main',
    question:
      'How often does "Merge into main?" predict conflicts before merging, how many files, and how often are binary files or submodules involved? (Once per agent and pair of commits; never file names.)',
    props: z.object({ files: CountBucket, binary: z.boolean(), submodules: z.boolean() }),
  }),
  merge_conflict_sent_to_agent: def({
    from: 'main',
    question:
      'Do people hand merge conflicts back to the agent, from the prediction or from a merge that stopped, and does the agent have to be resumed or unarchived first?',
    props: z.object({
      source: z.enum(['prediction', 'merge']),
      files: CountBucket,
      agent: z.enum(['running', 'resumed', 'unarchived']),
    }),
  }),
  merge_conflict_resolved: def({
    from: 'main',
    question: 'How long does an agent take to resolve merge conflicts and submit for review again?',
    props: z.object({ duration: DurationBucket }),
  }),
  agent_discarded: def({
    from: 'main',
    question: 'How often is agent work thrown away rather than merged?',
    props: z.object({ worktree_deleted: z.boolean() }),
  }),
  agent_archived: def({
    from: 'main',
    question: 'Why do agents leave the Wall: merged, discarded, completed, or archived by hand?',
    props: z.object({ reason: ArchiveReason }),
  }),
  agent_unarchived: def({
    from: 'main',
    question: 'Do people bring archived agents back to the Wall?',
    props: z.object({}),
  }),
  agent_deleted: def({
    from: 'main',
    question: 'Do people delete archived agents for good?',
    props: z.object({}),
  }),
  pr_opened: def({
    from: 'main',
    question:
      'How often does agent work leave as a pull request instead of a local merge, and how often did one already exist? Do new PRs follow the project conventions (agent draft or project template) or go up as the plain summary?',
    props: z.object({ existing: z.boolean(), draft: z.enum(['agent', 'template', 'plain', 'given']).optional() }),
  }),
  pr_pushed: def({
    from: 'main',
    question:
      'Do people send follow-up work to a pull request that is already open (Push to PR), how many commits at a time, and how often were there uncommitted files that oIDE committed first?',
    props: z.object({ commits: CountBucket, committed: z.boolean() }),
  }),
  changes_reverted: def({
    from: 'main',
    question: 'Do people throw away uncommitted changes in the main checkout from Source control (Revert…), how many files, and all of them or a pick?',
    props: z.object({ files: CountBucket, all: z.boolean() }),
  }),
  file_changes_discarded: def({
    from: 'main',
    question: 'Do people throw away changes from the Files tree (right click › Discard changes), in the main checkout or an agent worktree, and how many files at once?',
    props: z.object({ files: CountBucket, checkout: z.enum(['main', 'worktree']) }),
  }),
  project_pulled: def({
    from: 'main',
    question: 'Do people bring a project up to date from the Pull button in the Projects sidebar (after a background fetch) or from Source control?',
    props: z.object({ from: z.enum(['sidebar', 'source_control']) }),
  }),
  pr_view_opened: def({
    from: 'main',
    question: 'Do people follow the pull request of an agent from oIDE (View PR)?',
    props: z.object({}),
  }),
  pr_merged_detected: def({
    from: 'main',
    question: 'How often does oIDE see the pull request of an agent merged (and archive the agent)?',
    props: z.object({}),
  }),
  pr_checks_finished: def({
    from: 'main',
    question: "Do agents' pull requests pass CI, as oIDE sees the checks on the PR finish (the tile's CI indicator)?",
    props: z.object({ result: z.enum(['success', 'failure']) }),
  }),
  pr_checks_opened: def({
    from: 'main',
    question: "Do people open a pull request's CI checks from the tile's CI indicator?",
    props: z.object({}),
  }),
  worktree_delete_failed: def({
    from: 'main',
    question:
      'How often can a worktree folder not be deleted, and what kind of program holds it (Docker Desktop, an editor, a terminal, a Node process)?',
    props: z.object({ holder: z.enum(HOLDER_CATEGORIES) }),
  }),
  worktree_delete_retried_ok: def({
    from: 'main',
    question: 'Does the background retry finish removing worktree folders, and after how many tries?',
    props: z.object({ attempts: CountBucket }),
  }),
  agent_mode_changed: def({
    from: 'main',
    question:
      'Do people change the permission mode of an agent after it started, and between which modes (Plan, then Manual after the plan is approved, then Auto or Bypass)?',
    props: z.object({ from: z.union([PermissionMode, z.literal('unknown')]), to: PermissionMode }),
  }),
  compact_requested: def({
    from: 'main',
    question: 'Do people compact context by hand (the context ring, /compact)?',
    props: z.object({}),
  }),
  slash_command_used: def({
    from: 'main',
    question: 'Which built-in CLI slash commands are used from the composer?',
    props: z.object({ command: z.enum([...BUILTIN_SLASH_COMMANDS, 'other']) }),
  }),
  attachments_sent: def({
    from: 'main',
    question: 'Do people attach images and files to prompts, and where?',
    props: z.object({
      where: z.enum(['spawn', 'message']),
      images: z.number().int().min(0).max(50),
      files: z.number().int().min(0).max(50),
    }),
  }),
  file_search_used: def({
    from: 'main',
    question:
      'Is Files search used (quick open by name, content search, replace), and does it find anything?',
    props: z.object({
      kind: z.enum(['name', 'content', 'replace']),
      results: CountBucket,
      queries: SmallCount,
      regex: z.boolean().optional(),
      engine: z.enum(['git-grep', 'scan', 'mixed']).optional(),
    }),
  }),
  files_markdown_view: def({
    from: 'renderer',
    question: 'Do people read Markdown files in the Files preview or switch to editing them beside it, and with the button or the shortcut?',
    props: z.object({ view: z.enum(['preview', 'edit']), via: z.enum(['button', 'shortcut']) }),
  }),
  files_diff_view: def({
    from: 'renderer',
    question: 'When a changed file opens on its changes in Files, do people read them unified, side by side, or switch to the plain editor?',
    props: z.object({ view: z.enum(['off', 'unified', 'split']) }),
  }),
  files_dependency_upgrade: def({
    from: 'renderer',
    question: 'Do people use the newer-version hints in package.json to start an upgrade agent, and for which size of upgrade?',
    props: z.object({
      /** How far the latest version is ahead of the one package.json asks for. */
      bump: z.enum(['major', 'minor', 'patch', 'prerelease']),
      via: z.enum(['click', 'menu']),
    }),
  }),
  file_managed: def({
    from: 'main',
    question: 'Do people manage files from the Files tree (new, rename, copy, move, delete), and which actions?',
    props: z.object({
      action: z.enum(['create_file', 'create_folder', 'rename', 'copy', 'move', 'delete']),
      /** The copy or move went to another checkout (main ↔ an agent worktree). */
      crossCheckout: z.boolean().optional(),
    }),
  }),
  script_run: def({
    from: 'main',
    question: 'Do people run project scripts from Files › Run, and for which kinds of project (npm, pnpm, make, cargo…)?',
    props: z.object({
      /** The tool that runs it, from a fixed list (never the script name or its command). */
      runner: ScriptRunner,
    }),
  }),
  language_server_started: def({
    from: 'main',
    question: 'Do the Files editor language servers start for people, for which languages, and how often is the server simply not installed?',
    props: z.object({
      /** The built-in Languages extension's language, from a fixed list; any other extension's is `other`. */
      language: z.enum(['typescript', 'python', 'rust', 'go', 'c_cpp', 'css', 'html', 'json', 'yaml', 'shell', 'other']),
      outcome: z.enum(['running', 'not_installed', 'failed']),
    }),
  }),
  language_server_install: def({
    from: 'renderer',
    question: 'When a language server is not installed, do people let oIDE install it (from the prompt or the server menu), or say No?',
    props: z.object({ choice: z.enum(['install', 'declined']), via: z.enum(['prompt', 'menu']) }),
  }),
  artifact_imported: def({
    from: 'main',
    question:
      'How do people bring artifacts in (a link with pasted content, one exported file, several files, a folder), which kinds, and how many are React?',
    props: z.object({
      source: z.enum(['link_content', 'file', 'files', 'folder']),
      kind: ArtifactKind,
      linked: z.boolean(),
      format: z.enum(['html', 'react', 'svg', 'markdown', 'excalidraw']),
      /** Files in the new artifact (multi-file imports, ADR 0014). */
      files: CountBucket.optional(),
    }),
  }),
  artifact_import_refused: def({
    from: 'main',
    question: 'Why are imports refused before anything is created (no content, a bad link, the wrong kind, too big, a file name that is not allowed)?',
    props: z.object({ reason: z.enum(['no_content', 'bad_link', 'wrong_kind', 'too_large', 'stub_content', 'bad_path', 'other']) }),
  }),
  artifact_retrieval_started: def({
    from: 'main',
    question: 'How often do people have an agent retrieve a linked claude.ai artifact (a new link, Update, Retry), and of which kind?',
    props: z.object({ trigger: z.enum(['import', 'update', 'retry']), kind: ArtifactKind }),
  }),
  artifact_retrieval_finished: def({
    from: 'main',
    question:
      'Do agent retrievals of claude.ai artifacts work: how many end ready, fail (no tool can read the link, bad files), are cancelled, or lose their agent, and how many files do they bring?',
    props: z.object({
      trigger: z.enum(['import', 'update', 'retry']),
      outcome: z.enum(['ready', 'failed', 'cancelled', 'agent_stopped']),
      kind: ArtifactKind,
      files: CountBucket,
    }),
  }),
  artifact_agent_started: def({
    from: 'main',
    question: 'Do people work on artifacts with an agent in the open view, on which kinds, and in which permission mode?',
    props: z.object({ kind: ArtifactKind, mode: PermissionMode }),
  }),
  artifact_agent_message: def({
    from: 'renderer',
    question: 'Do people point at the preview to give an artifact agent feedback, and how many comments do they send at once?',
    props: z.object({ kind: ArtifactKind, feedback: SmallCount, has_text: z.boolean() }),
  }),
  agent_model_changed: def({
    from: 'main',
    question: 'Do people switch the model or effort of a running agent, and to what?',
    props: z.object({ model: ModelFamilyValue, effort: z.union([Effort, z.literal('default')]), artifact_agent: z.boolean() }),
  }),
  project_added: def({
    from: 'main',
    question:
      'How do people start projects (open a repo, initialise git in a folder, clone from a URL or their GitHub list, create a new repository)?',
    props: z.object({
      method: z.enum(['open', 'init', 'clone', 'create']),
      /** Clones only: typed or pasted URL, or picked from the GitHub list. */
      source: z.enum(['url', 'github']).optional(),
    }),
  }),
  project_add_failed: def({
    from: 'main',
    question: 'Why do new projects fail (not a repo, sign-in, not found, network, folder exists, no git identity), so the dialog can explain it?',
    props: z.object({
      method: z.enum(['open', 'init', 'clone', 'create']),
      reason: z.enum(['not_a_repo', 'auth', 'not_found', 'network', 'exists', 'no_identity', 'forbidden_path', 'other']),
    }),
  }),
  extension_installed: def({
    from: 'main',
    question:
      'Which marketplace extensions do people install? (Official index only; custom and local extensions are never named.)',
    props: z.object({ extension: MarketplaceExtensionId, source: z.enum(['marketplace', 'builtin']) }),
  }),
  setting_changed: def({
    from: 'main',
    question: 'Which settings do people change? (The key only, never the value.)',
    props: z.object({ key: z.enum(TELEMETRY_SETTING_KEYS) }),
  }),
  cli_unknown_event: def({
    from: 'main',
    question: 'Which CLI stream-json events does oIDE not understand yet (protocol drift)?',
    props: z.object({ event_type: CliEventType, count: z.number().int().min(1).max(1_000_000) }),
  }),
  command_palette_used: def({
    from: 'renderer',
    question: 'Which built-in command bar commands are used?',
    props: z.object({ command: z.enum(BUILTIN_COMMAND_IDS) }),
  }),
  perf_summary: def({
    from: 'renderer',
    question:
      'Is the UI fast: IPC round trips, long tasks, memory, and Wall render time at a given number of agents?',
    props: z.object({
      window_min: z.number().int().min(1).max(1440),
      ipc_samples: SmallCount,
      ipc_p50_ms: Ms.optional(),
      ipc_p95_ms: Ms.optional(),
      long_tasks: SmallCount,
      memory: MemoryBucket.optional(),
      wall_render_ms: Ms.optional(),
      wall_agents: CountBucket.optional(),
    }),
  }),
} as const;

export type TelemetryEventName = keyof typeof TELEMETRY_EVENTS;
export type TelemetryEventProps<K extends TelemetryEventName> = z.input<
  (typeof TELEMETRY_EVENTS)[K]['props']
>;
export const TELEMETRY_EVENT_NAMES = Object.keys(TELEMETRY_EVENTS) as TelemetryEventName[];

export function isTelemetryEventName(name: unknown): name is TelemetryEventName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(TELEMETRY_EVENTS, name);
}

/** A value Umami event data may hold after validation. */
export type TelemetryValue = string | number | boolean;

/**
 * Validate one event against the catalogue. Returns the cleaned properties (unknown properties
 * removed), or null when the name is unknown, the event may not come from `from`, or a declared
 * property is invalid. Never throws.
 */
export function validateTelemetryEvent(
  name: unknown,
  props: unknown,
  from?: 'main' | 'renderer',
): { name: TelemetryEventName; props: Record<string, TelemetryValue> } | null {
  if (!isTelemetryEventName(name)) return null;
  const d = TELEMETRY_EVENTS[name];
  // The renderer may only report renderer events; main may emit any (it observes the rest itself).
  if (from === 'renderer' && d.from !== 'renderer') return null;
  const r = d.props.safeParse(props ?? {});
  if (!r.success) return null;
  const out: Record<string, TelemetryValue> = {};
  for (const [k, v] of Object.entries(r.data as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      out[k] = v;
  }
  return { name, props: out };
}

// ---------------------------------------------------------------------------- IPC contract

const Vital = z.number().nonnegative().max(60_000);

/** What the renderer may report (`telemetry.track`). Main validates again and decides; it may drop anything. */
export const TelemetryTrackInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pageview'), screen: TelemetryScreen, section: z.string().max(40).optional() }),
  z.object({
    type: z.literal('event'),
    name: z.string().min(1).max(50),
    props: z.record(z.string().max(50), z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
  }),
  z.object({
    type: z.literal('error'),
    source: z.enum(['window', 'unhandledrejection', 'boundary']),
    name: z.string().max(120),
    message: z.string().max(2000),
    stack: z.string().max(8000).optional(),
  }),
  /** Web vitals of one screen visit, as Umami's tracker measures them (`performance` payloads). */
  z.object({
    type: z.literal('vitals'),
    screen: TelemetryScreen,
    section: z.string().max(40).optional(),
    fcp: Vital.optional(),
    lcp: Vital.optional(),
    cls: z.number().nonnegative().max(100).optional(),
    inp: Vital.optional(),
    ttfb: Vital.optional(),
  }),
]);
export type TelemetryTrackInput = z.infer<typeof TelemetryTrackInput>;

/** Why telemetry cannot be turned on in this run. */
export const TelemetryUnavailableReason = z.enum(['compiled-out', 'do-not-track', 'env', 'test']);
export type TelemetryUnavailableReason = z.infer<typeof TelemetryUnavailableReason>;

export const TelemetryStatus = z.object({
  /** False when this build or run can never send (no endpoint compiled in, DO_NOT_TRACK, OIDE_TELEMETRY=0, tests). */
  available: z.boolean(),
  reason: TelemetryUnavailableReason.optional(),
  usageAnalytics: z.boolean(),
  errorReports: z.boolean(),
  /** Show the first-run question now (not answered yet, asked fewer than `MAX_CONSENT_PROMPTS` times). */
  showPrompt: z.boolean(),
});
export type TelemetryStatus = z.infer<typeof TelemetryStatus>;

/** `shown`: the question is on screen (counted once per launch); `later`: closed without choosing. */
export const TelemetryConsentInput = z.object({ choice: z.enum(['shown', 'accept', 'decline', 'later']) });
export type TelemetryConsentInput = z.infer<typeof TelemetryConsentInput>;

/** The first-run question is shown on at most this many launches when closed without a choice, then never again. */
export const MAX_CONSENT_PROMPTS = 2;
