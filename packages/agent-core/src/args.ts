import type { AgentSpec, CliInfo, CustomModel, Effort, ModelSlot, ModelStrategy, PermissionMode, Settings, SubagentTier, Technique } from '@oide/protocol';
import { describeContext, textMessage, type ArtifactResolver, type StreamJsonUserMessage } from './messages.js';

/**
 * buildLaunch: AgentSpec + context → the exact `claude` command line, env and first message.
 * See docs/wiki/pages/cli-integration.md for the verified flags.
 */

export interface ExtensionToolRef {
  /** MCP server name as it appears in mcp.json (tool names become `mcp__<server>__<tool>`). */
  server: string;
  tool: string;
  risk: 'read' | 'ask';
  enabled: boolean;
}

export interface LaunchContext {
  agentId: string;
  /** New agents: passed as `--session-id`. With `resume: true`, passed as `--resume`. */
  sessionId: string;
  resume?: boolean;
  /** The agent's worktree (or project folder). */
  cwd: string;
  branch?: string;
  cli: CliInfo;
  settings: Settings;
  /** Techniques available to this agent, in Settings order. `spec.techniques` picks which apply. */
  techniques?: Technique[];
  /** `.oide/permissions.json` of the project. Allow rules are ignored when the project is untrusted. */
  projectRules?: { allow: string[]; ask?: string[]; deny: string[] };
  trusted?: boolean;
  extensionTools?: ExtensionToolRef[];
  /** Path of the generated `<app-data>/agents/<id>/mcp.json` (written by the MCP server). */
  mcpConfigPath?: string;
  customModel?: CustomModel;
  /** The custom model's key from oIDE's keychain store. Never Claude credentials. */
  customModelSecret?: string;
  /** Source for the env allow-list. Defaults to process.env. Never copied wholesale. */
  baseEnv?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Name used in the `Oide-Agent:` commit trailer. Defaults to the spec title. */
  agentName?: string;
  resolveArtifact?: ArtifactResolver;
}

export interface LaunchPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** First stream-json user message; null on resume. */
  firstMessage: StreamJsonUserMessage | null;
  /** The `--mcp-config` path, when one was passed. */
  mcpConfig?: string;
  /** The `--agents` JSON for routed strategies. */
  agentsJson?: string;
  appendSystemPrompt: string;
  /** What was passed to `--model` and `--permission-mode`. */
  model: string;
  mode: string;
  warnings: string[];
}

export class LaunchError extends Error {
  override name = 'LaunchError';
}

// ---------------------------------------------------------------- env allow-list

/** Exact env names passed to the agent (matched case-insensitively, original casing kept). */
export const ENV_ALLOW_LIST: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'USERPROFILE',
  'USERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'HOMEDRIVE',
  'HOMEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'TERM',
  'COLORTERM',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_RUNTIME_DIR',
  'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'ALL_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
];
const ENV_ALLOW_UPPER = new Set(ENV_ALLOW_LIST.map((k) => k.toUpperCase()));

export function isAllowedEnvKey(key: string): boolean {
  const up = key.toUpperCase();
  return ENV_ALLOW_UPPER.has(up) || up.startsWith('LC_');
}

/** Build the agent env from an allow-list. Values are never logged. */
export function allowListEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && isAllowedEnvKey(k)) env[k] = v;
  return env;
}

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Env for a custom model ("Your models"). The key comes from oIDE's keychain store. */
export function customModelEnv(model: CustomModel, secret?: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(model.extraEnv ?? {})) if (ENV_KEY.test(k)) env[k] = v;
  switch (model.provider) {
    case 'compatible-api':
    case 'local':
      if (!model.baseUrl) throw new LaunchError(`Custom model "${model.name}" has no base URL`);
      env.ANTHROPIC_BASE_URL = model.baseUrl;
      env.ANTHROPIC_MODEL = model.model;
      if (secret) env.ANTHROPIC_AUTH_TOKEN = secret;
      break;
    case 'bedrock':
      env.CLAUDE_CODE_USE_BEDROCK = '1';
      env.ANTHROPIC_MODEL = model.model;
      break;
    case 'vertex':
      env.CLAUDE_CODE_USE_VERTEX = '1';
      env.ANTHROPIC_MODEL = model.model;
      break;
  }
  return env;
}

// ---------------------------------------------------------------- shell split for extra flags

/** POSIX-like word splitting without any expansion. Throws on an unterminated quote. */
export function shellSplit(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && (input[i + 1] === '"' || input[i + 1] === '\\')) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
      continue;
    }
    inWord = true;
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '\\' && i + 1 < input.length) cur += input[++i];
    else cur += ch;
  }
  if (quote) throw new LaunchError('Unterminated quote in extra CLI flags');
  if (inWord) out.push(cur);
  return out;
}

/** Flags oIDE controls itself; extra flags may not override them. Value = takes a value. */
const RESERVED_FLAGS: Record<string, boolean> = {
  '-p': false,
  '--print': false,
  '--input-format': true,
  '--output-format': true,
  '--session-id': true,
  '--resume': true,
  '-r': true,
  '--continue': false,
  '-c': false,
  '--permission-mode': true,
  '--permission-prompt-tool': true,
  '--permission-prompts': true,
  '--dangerously-skip-permissions': false,
  '--allow-dangerously-skip-permissions': false,
  '--model': true,
  '--bg': false,
  '--background': false,
  '--worktree': false,
  '-w': false,
  '--tmux': false,
  '--desktop': false,
  '--cloud': false,
  '--teleport': false,
  '--remote-control': false,
  '--no-session-persistence': false,
};

export function filterExtraFlags(raw: string, warnings: string[]): string[] {
  let words: string[];
  try {
    words = shellSplit(raw);
  } catch (e) {
    warnings.push(`Ignored extra CLI flags: ${(e as Error).message}`);
    return [];
  }
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const flag = w.includes('=') && w.startsWith('--') ? w.slice(0, w.indexOf('=')) : w;
    if (flag in RESERVED_FLAGS) {
      warnings.push(`Ignored extra CLI flag ${flag}: oIDE sets it itself`);
      if (RESERVED_FLAGS[flag] && !w.includes('=') && words[i + 1] !== undefined && !words[i + 1]!.startsWith('-')) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

// ---------------------------------------------------------------- features, modes, models

/** True when the CLI advertises a feature. Unknown (no detection yet) counts as supported. */
export function hasFeature(cli: CliInfo, feature: string): boolean {
  const f = cli.features ?? {};
  if (feature in f) return Boolean(f[feature]);
  return Object.keys(f).length === 0;
}

export function cliPermissionMode(mode: PermissionMode, cli: CliInfo, warnings: string[]): string {
  if (mode === 'auto' && !hasFeature(cli, 'mode:auto')) {
    warnings.push('This CLI has no auto permission mode; using default plus oIDE allow rules');
    return 'default';
  }
  return mode;
}

export const ROUTED_AGENT_NAMES = { simple: 'simple-task', standard: 'standard-task', complex: 'complex-task' } as const;

export interface SubagentDefinition {
  description: string;
  prompt: string;
  model: string;
  effort?: Effort;
}

const ROUTED_TEXT: Record<'simple' | 'standard' | 'complex', { description: string; prompt: string }> = {
  simple: {
    description: 'Use for small, well-defined tasks: reading or searching a few files, a one-line fix, running one command and reporting its output.',
    prompt: 'You handle small, well-defined tasks quickly. Do exactly what was asked, keep your report short, and do not widen the scope.',
  },
  standard: {
    description: 'Use for ordinary multi-step tasks: a focused feature or bug fix touching a few files, or writing tests for one module.',
    prompt: 'You handle ordinary multi-step coding tasks. Work carefully, run the relevant checks, and report what you changed and how you verified it.',
  },
  complex: {
    description: 'Use for hard tasks: cross-cutting changes, tricky debugging, design decisions, or anything that needs deep reasoning.',
    prompt: 'You handle hard engineering tasks. Investigate before changing code, reason about trade-offs, verify thoroughly, and report findings and risks clearly.',
  },
};

/** The `--agents` definitions for a routed strategy (simple-task / standard-task / complex-task). */
export function routedAgents(strategy: ModelStrategy): Record<string, SubagentDefinition> | undefined {
  if (strategy.kind !== 'routed') return undefined;
  const def = (tier: 'simple' | 'standard' | 'complex', slot: ModelSlot): SubagentDefinition => ({
    ...ROUTED_TEXT[tier],
    model: slot.model,
    ...(slot.effort ? { effort: slot.effort } : {}),
  });
  return {
    [ROUTED_AGENT_NAMES.simple]: def('simple', strategy.simple),
    [ROUTED_AGENT_NAMES.standard]: def('standard', strategy.standard),
    [ROUTED_AGENT_NAMES.complex]: def('complex', strategy.complex),
  };
}

/** subagent_type → tier/model/effort, used by SubagentTracker. */
export interface TierInfo {
  tier: SubagentTier;
  model?: string;
  effort?: Effort;
}
export function subagentTiers(strategy: ModelStrategy): Record<string, TierInfo> {
  const out: Record<string, TierInfo> = {};
  if (strategy.kind === 'routed') {
    for (const tier of ['simple', 'standard', 'complex'] as const) {
      const slot = strategy[tier];
      out[ROUTED_AGENT_NAMES[tier]] = { tier, model: slot.model, ...(slot.effort ? { effort: slot.effort } : {}) };
    }
  }
  return out;
}

/** Env var read by the CLI for the default subagent model ("separate subagent model" strategy). */
export const SUBAGENT_MODEL_ENV = 'CLAUDE_CODE_SUBAGENT_MODEL';

// ---------------------------------------------------------------- system prompt contract

export function oideContract(opts: { agentName: string; agentId: string; cwd: string; branch?: string; routed: boolean }): string {
  const lines = [
    `You are running inside oIDE as the agent "${opts.agentName}" (oIDE agent id ${opts.agentId}).`,
    `You work in ${opts.branch ? `your own git worktree on branch ${opts.branch}` : 'this directory'} (${opts.cwd}). Other agents work in parallel in their own worktrees; stay inside yours.`,
    '',
    'oIDE contract:',
    '- When the task is done, or you reach a point where the user should review your work, call the tool mcp__oide__submit_for_review with `summary` (what you changed and why, a few sentences) and `checks` (each check you ran: `name`, `status` one of passed / failed / warning / skipped, optional `detail`). Do this instead of only describing the result in prose. If the tool is deferred, load it with ToolSearch first.',
    '- If you cannot finish without an answer from the user, ask one clear question and end your turn without calling submit_for_review.',
    `- Commit your work as you go with clear messages. End every commit message with this trailer line: Oide-Agent: ${opts.agentName}`,
    '- oIDE artifacts (designs, docs, whiteboards) are available through mcp__oide__artifacts_list, mcp__oide__artifacts_read, mcp__oide__artifacts_write and mcp__oide__artifacts_create.',
  ];
  if (opts.routed) {
    lines.push(
      `- Delegate with the Agent tool by task size. Rate each sub-task and pick subagent_type "${ROUTED_AGENT_NAMES.simple}" for small, well-defined steps, "${ROUTED_AGENT_NAMES.standard}" for ordinary multi-step work, and "${ROUTED_AGENT_NAMES.complex}" for hard or cross-cutting work. Do trivial steps yourself.`,
    );
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------- command resolution

export interface CommandLine {
  command: string;
  args: string[];
}

/** `.mjs`/`.js` CLIs (fake-claude) run through the current Node; everything else is spawned directly. */
export function cliCommand(cliPath: string | undefined): CommandLine {
  const p = cliPath ?? 'claude';
  if (/\.(mjs|cjs|js)$/i.test(p)) return { command: process.execPath, args: [p] };
  return { command: p, args: [] };
}

// ---------------------------------------------------------------- buildLaunch

function uniq(xs: string[]): string[] {
  return [...new Set(xs.filter((x) => x.trim().length > 0))];
}

const OIDE_READ_TOOLS = ['mcp__oide__submit_for_review', 'mcp__oide__artifacts_list', 'mcp__oide__artifacts_read'];

export function buildLaunch(spec: AgentSpec, ctx: LaunchContext): LaunchPlan {
  const warnings: string[] = [];
  const { cli, settings } = ctx;
  const base = cliCommand(cli.path);
  const args = [...base.args, '-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  if (hasFeature(cli, 'include-partial-messages')) args.push('--include-partial-messages');
  if (hasFeature(cli, 'forward-subagent-text')) args.push('--forward-subagent-text');

  if (ctx.resume) args.push('--resume', ctx.sessionId);
  else args.push('--session-id', ctx.sessionId);

  // Model and effort
  const lead = spec.strategy.lead;
  const model = ctx.customModel ? ctx.customModel.model : lead.model;
  args.push('--model', model);
  const effort = lead.effort ?? settings.models.defaultEffort;
  if (effort) {
    if (hasFeature(cli, 'effort')) args.push('--effort', effort);
    else warnings.push('This CLI has no --effort flag; effort is not applied');
  }

  // Permission mode
  if (spec.mode === 'bypassPermissions') {
    if (!settings.claude.allowBypass) throw new LaunchError('Bypass mode is off in Settings › Allow Bypass permissions');
    if (spec.workIn === 'project-folder') throw new LaunchError('Bypass agents must run in a worktree, never in the project folder');
  }
  const mode = cliPermissionMode(spec.mode, cli, warnings);
  args.push('--permission-mode', mode);

  // MCP config and the permission prompt tool
  if (ctx.mcpConfigPath) {
    args.push('--mcp-config', ctx.mcpConfigPath);
    if (hasFeature(cli, 'permission-prompt-tool')) args.push('--permission-prompt-tool', 'mcp__oide__permission_prompt');
    else warnings.push('This CLI has no --permission-prompt-tool; prompts cannot reach oIDE');
  }

  // System prompt: oIDE contract, then system-prompt techniques in Settings order
  const picked = (ctx.techniques ?? []).filter((t) => spec.techniques.includes(t.id));
  const routed = spec.strategy.kind === 'routed';
  const agentName = ctx.agentName ?? spec.title;
  const systemParts = [
    oideContract({ agentName, agentId: ctx.agentId, cwd: ctx.cwd, ...(ctx.branch ? { branch: ctx.branch } : {}), routed }),
    ...picked.filter((t) => t.placement === 'system-prompt').map((t) => t.text.trim()),
  ];
  const appendSystemPrompt = systemParts.filter(Boolean).join('\n\n');
  args.push('--append-system-prompt', appendSystemPrompt);

  // Routed subagents
  let agentsJson: string | undefined;
  const defs = routedAgents(spec.strategy);
  if (defs) {
    agentsJson = JSON.stringify(defs);
    if (hasFeature(cli, 'agents')) args.push('--agents', agentsJson);
    else warnings.push('This CLI has no --agents flag; routed subagents are not available');
  }

  // Allowed / disallowed tools
  const ext = ctx.extensionTools ?? [];
  const toolName = (t: ExtensionToolRef) => `mcp__${t.server}__${t.tool}`;
  const askTools = new Set([...ext.filter((t) => t.risk === 'ask').map(toolName), ...(ctx.projectRules?.ask ?? [])]);
  const allow = uniq([
    ...(ctx.trusted !== false ? (ctx.projectRules?.allow ?? []) : []),
    ...settings.permissions.alwaysAllowed,
    ...ext.filter((t) => t.enabled && t.risk === 'read').map(toolName),
    ...OIDE_READ_TOOLS,
  ]).filter((r) => !askTools.has(r));
  const deny = uniq([...(ctx.projectRules?.deny ?? []), ...settings.permissions.alwaysDenied, ...ext.filter((t) => !t.enabled).map(toolName)]);
  if (ctx.trusted === false && ctx.projectRules?.allow.length) warnings.push('Untrusted project: .oide/permissions.json allow rules ignored');
  if (allow.length) args.push('--allowedTools', allow.join(','));
  if (deny.length) args.push('--disallowedTools', deny.join(','));

  // Extra flags from Settings › Claude Code
  args.push(...filterExtraFlags(settings.claude.extraFlags ?? '', warnings));

  // Env
  const env = allowListEnv(ctx.baseEnv ?? process.env);
  env.OIDE_AGENT_ID = ctx.agentId;
  if (spec.strategy.kind === 'subagent-model') env[SUBAGENT_MODEL_ENV] = spec.strategy.subagents.model;
  if (ctx.customModel) Object.assign(env, customModelEnv(ctx.customModel, ctx.customModelSecret));

  // First message: goal, then first-message techniques in Settings order, then context chips
  let firstMessage: StreamJsonUserMessage | null = null;
  if (!ctx.resume) {
    const parts = [spec.goal.trim(), ...picked.filter((t) => t.placement === 'first-message').map((t) => t.text.trim())];
    const context = describeContext(spec.context, ctx.resolveArtifact);
    if (context) parts.push(context);
    firstMessage = textMessage(parts.filter(Boolean).join('\n\n'));
  }

  return {
    command: base.command,
    args,
    env,
    firstMessage,
    ...(ctx.mcpConfigPath ? { mcpConfig: ctx.mcpConfigPath } : {}),
    ...(agentsJson ? { agentsJson } : {}),
    appendSystemPrompt,
    model,
    mode,
    warnings,
  };
}
