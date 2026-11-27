import { z } from 'zod';
import { AccountId } from './accounts.js';

/**
 * Agent-level schemas shared by main, renderer and extensions.
 * See docs/wiki/pages/agent-supervisor.md and the build brief (raw/build-brief.md).
 */

export const Id = z.string().min(1).max(128);

/** A git ref, branch or sha safe on a git command line: no leading '-', no whitespace or '..' (SEC-21). */
export const GitRef = z.string().regex(/^(?!-)(?!.*\.\.)[A-Za-z0-9._/@{}~^+-]{1,255}$/, 'Not a valid git ref');
export type Id = z.infer<typeof Id>;

/** Permission modes as shown in Spawn. Values are the CLI's `--permission-mode` values. */
export const PermissionMode = z.enum(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
export type PermissionMode = z.infer<typeof PermissionMode>;

export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Manual',
  acceptEdits: 'Edit automatically',
  plan: 'Plan',
  auto: 'Auto',
  bypassPermissions: 'Bypass',
};

export const Effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof Effort>;

/**
 * Where an agent works. `artifact-folder`: an artifact agent (Artifacts › open view) works in an
 * empty scratch folder of its own under oIDE's app data, never in a repo; it edits its artifact
 * through oIDE's MCP artifact tools.
 */
export const WorkIn = z.enum(['worktree-from-main', 'worktree-from-current', 'project-folder', 'artifact-folder']);
export type WorkIn = z.infer<typeof WorkIn>;

export const ModelSlot = z.object({
  /** Alias ("opus", "sonnet", "haiku") for "Latest", or an exact model id when pinned. */
  model: z.string().min(1),
  effort: Effort.optional(),
});
export type ModelSlot = z.infer<typeof ModelSlot>;

export const ModelStrategy = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('single'), lead: ModelSlot }),
  z.object({ kind: z.literal('subagent-model'), lead: ModelSlot, subagents: ModelSlot }),
  z.object({
    kind: z.literal('routed'),
    lead: ModelSlot,
    simple: ModelSlot,
    standard: ModelSlot,
    complex: ModelSlot,
  }),
]);
export type ModelStrategy = z.infer<typeof ModelStrategy>;

export const ContextChip = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('artifact'), id: Id, title: z.string() }),
  z.object({ kind: z.literal('file'), path: z.string(), title: z.string().optional() }),
  z.object({ kind: z.literal('url'), url: z.string().url(), title: z.string().optional() }),
]);
export type ContextChip = z.infer<typeof ContextChip>;

/**
 * Attachments on a user message (Focus composer, Wall reply, Spawn goal). Images travel as
 * stream-json image content blocks (verified on CLI 2.1.325); other files are copied into the
 * agent's folder under `.oide/attachments/` and named in the text. Main re-checks every limit.
 */
export const ATTACHMENT_LIMITS = {
  /** Decoded bytes per image (the API's own per-image limit). */
  imageBytes: 5 * 1024 * 1024,
  /** Decoded image bytes in one message (keeps the request under the API's request size). */
  imagesTotalBytes: 20 * 1024 * 1024,
  fileBytes: 25 * 1024 * 1024,
  count: 10,
} as const;

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export const ImageMediaType = z.enum(IMAGE_MEDIA_TYPES);
export type ImageMediaType = z.infer<typeof ImageMediaType>;

/** Decoded size of a base64 string (no whitespace). */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const AttachmentName = z.string().min(1).max(255);

export const ImageAttachment = z.object({
  kind: z.literal('image'),
  mediaType: ImageMediaType,
  dataBase64: z
    .string()
    .min(4)
    .max(Math.ceil(ATTACHMENT_LIMITS.imageBytes / 3) * 4)
    .refine((s) => s.length % 4 === 0 && BASE64.test(s), 'Image data is not valid base64'),
  name: AttachmentName.optional(),
});
export type ImageAttachment = z.infer<typeof ImageAttachment>;

export const FileAttachment = z.object({
  kind: z.literal('file'),
  /** From the renderer: the absolute path picked or dropped. Once delivered: the copy's path relative to the agent's folder. */
  path: z.string().min(1).max(4096),
  name: AttachmentName,
  size: z.number().int().nonnegative().max(ATTACHMENT_LIMITS.fileBytes),
});
export type FileAttachment = z.infer<typeof FileAttachment>;

export const MessageAttachment = z.discriminatedUnion('kind', [ImageAttachment, FileAttachment]);
export type MessageAttachment = z.infer<typeof MessageAttachment>;
export const MessageAttachments = z.array(MessageAttachment).max(ATTACHMENT_LIMITS.count, `At most ${ATTACHMENT_LIMITS.count} attachments per message`);

/** A custom model endpoint ("Your models"). The secret lives in the keychain, referenced by id. */
export const CustomModelRef = z.object({ id: Id });
export type CustomModelRef = z.infer<typeof CustomModelRef>;

/** Everything Spawn collects. The supervisor turns this into flags, env and the first message. */
export const AgentSpec = z.object({
  projectId: Id,
  title: z.string().min(1).max(200),
  /**
   * The title is only a stand-in made from the start of the goal (Spawn): the agent is asked to name
   * the task itself through `mcp__oide__set_title`. Cleared once it has. Unset when a title was given.
   */
  autoTitle: z.boolean().optional(),
  goal: z.string().min(1).max(100_000),
  context: z.array(ContextChip).default([]),
  /** Images and files sent with the first message (not persisted with the spec; see supervisor). */
  attachments: MessageAttachments.optional(),
  workIn: WorkIn.default('worktree-from-main'),
  /** Start the worktree from this branch or ref instead of the one `workIn` picks (reconcile agents). */
  baseRef: GitRef.optional(),
  mode: PermissionMode.default('auto'),
  strategy: ModelStrategy,
  customModel: CustomModelRef.optional(),
  /**
   * Claude Code account the agent runs on (its own CLAUDE_CONFIG_DIR, ADR 0021). Unset = the CLI's
   * default config. Fixed for the agent's life: its sessions live in that account's folder.
   */
  accountId: AccountId.optional(),
  /** Technique ids, applied in Settings order. */
  techniques: z.array(Id).default([]),
  /** Extension ids whose tools this agent gets. */
  extensions: z.array(Id).default([]),
  attempts: z.number().int().min(1).max(6).default(1),
  /** Shared by parallel attempts. */
  attemptGroup: Id.optional(),
  /**
   * An artifact agent: it lives in the artifact's open view and edits this artifact's files (only
   * this one) through oIDE's MCP artifact tools. Set by main (`artifacts.startAgent`), with
   * `workIn: 'artifact-folder'`; refused from Spawn.
   */
  artifactId: Id.optional(),
});
export type AgentSpec = z.infer<typeof AgentSpec>;
export type AgentSpecInput = z.input<typeof AgentSpec>;

/** Longest title an agent may give itself (`mcp__oide__set_title`). */
export const AGENT_TITLE_MAX = 80;

/**
 * Clean a title an agent proposed: one line, no control characters, no wrapping quotes or trailing
 * full stop, at most AGENT_TITLE_MAX characters. Undefined when nothing is left.
 */
export function cleanAgentTitle(raw: string): string | undefined {
  let t = raw
    // eslint-disable-next-line no-control-regex -- stripping control and bidi characters is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ')
    .replace(/[\u00ad\u061c\u180e\u2060-\u2064\u3164\ufeff\u{e0000}-\u{e007f}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const pairs: Record<string, string> = { '"': '"', "'": "'", '`': '`', '\u201c': '\u201d', '\u2018': '\u2019', '*': '*', _: '_' };
  for (;;) {
    const label = t.replace(/^title:\s*/i, '');
    const inner = t.slice(1, -1);
    const bold = /^(\*\*|__)(.+)\1$/.exec(t);
    // Strip a wrapping pair only when it is not also used inside ("`a` and `b`" stays as it is).
    if (label !== t) t = label;
    else if (bold && bold[2]!.trim() && !bold[2]!.includes(bold[1]!)) t = bold[2]!.trim();
    else if (t.length >= 2 && pairs[t[0]!] === t[t.length - 1] && inner.trim() && !inner.includes(t[0]!) && !inner.includes(t[t.length - 1]!)) t = inner.trim();
    else break;
  }
  t = t.replace(/[.\s]+$/, '');
  const chars = [...t];
  if (chars.length > AGENT_TITLE_MAX) t = `${chars.slice(0, AGENT_TITLE_MAX - 1).join('').trimEnd()}…`;
  return t || undefined;
}

export const AgentStatus = z.enum([
  'queued',
  'starting',
  'running',
  'needs-permission',
  'has-question',
  'ready-for-review',
  'paused',
  'stopped',
  'rate-limited',
  'error',
  'done',
]);
export type AgentStatus = z.infer<typeof AgentStatus>;

/** Statuses that count as "Needs you" on the Wall. */
export const NEEDS_YOU: ReadonlySet<AgentStatus> = new Set(['needs-permission', 'has-question', 'error', 'rate-limited']);

export const SubagentTier = z.enum(['simple', 'standard', 'complex', 'custom']);
export type SubagentTier = z.infer<typeof SubagentTier>;

export const SubagentStatus = z.enum(['queued', 'running', 'needs-permission', 'done', 'error', 'stopped']);
export type SubagentStatus = z.infer<typeof SubagentStatus>;

export const TokenUsage = z.object({
  input: z.number().int().nonnegative().default(0),
  output: z.number().int().nonnegative().default(0),
  cacheRead: z.number().int().nonnegative().default(0),
  cacheCreation: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof TokenUsage>;

export const SubagentInfo = z.object({
  /** The lead's Task tool_use id. */
  id: Id,
  agentId: Id,
  name: z.string(),
  task: z.string(),
  subagentType: z.string().optional(),
  tier: SubagentTier.optional(),
  model: z.string().optional(),
  effort: Effort.optional(),
  status: SubagentStatus,
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  usage: TokenUsage.optional(),
  contextUsed: z.number().optional(),
  /** The subagent model's own context window, when its model is known (else the lead's applies). */
  contextWindow: z.number().positive().optional(),
  report: z.string().optional(),
});
export type SubagentInfo = z.infer<typeof SubagentInfo>;

export const PermissionRequest = z.object({
  /** Unique id of this pending request; answers must quote it exactly. */
  requestId: Id,
  agentId: Id,
  subagentId: Id.optional(),
  /** The CLI's tool_use id for the call being approved (from the prompt tool's `tool_use_id`). */
  toolUseId: z.string().optional(),
  toolName: z.string(),
  input: z.unknown(),
  /** Short human summary, e.g. "Run npm test". */
  summary: z.string(),
  /** Suggested rule for "Always in <project>", e.g. "Bash(npm test)". */
  suggestedRule: z.string().optional(),
  createdAt: z.number(),
});
export type PermissionRequest = z.infer<typeof PermissionRequest>;

export const PermissionAnswer = z.discriminatedUnion('behavior', [
  z.object({
    requestId: Id,
    behavior: z.literal('allow'),
    always: z.boolean().default(false),
    updatedInput: z.unknown().optional(),
  }),
  z.object({ requestId: Id, behavior: z.literal('deny'), message: z.string().default('Denied by user') }),
]);
export type PermissionAnswer = z.infer<typeof PermissionAnswer>;

export const CheckResult = z.object({
  name: z.string(),
  status: z.enum(['passed', 'failed', 'warning', 'skipped']),
  detail: z.string().optional(),
});
export type CheckResult = z.infer<typeof CheckResult>;

/**
 * The pull request an agent drafted for its branch, written to the project's own conventions (PR
 * template, title rules). oIDE opens the PR with it when the user clicks Open pull request.
 */
export const PrDraft = z.object({
  title: z.string().min(1).max(300),
  body: z.string().max(60_000).default(''),
});
export type PrDraft = z.infer<typeof PrDraft>;

/** What an agent sends through `oide.submit_for_review`. */
export const ReviewSubmission = z.object({
  agentId: Id,
  summary: z.string(),
  checks: z.array(CheckResult).default([]),
  pr: PrDraft.optional(),
  submittedAt: z.number(),
});
export type ReviewSubmission = z.infer<typeof ReviewSubmission>;

export const TodoItem = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
  activeForm: z.string().optional(),
});
export type TodoItem = z.infer<typeof TodoItem>;

export const DiffStat = z.object({
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffStat = z.infer<typeof DiffStat>;

/**
 * Why an agent left the Wall for the Archived view: its branch was merged, it was discarded (Source
 * control › Remove worktree), it finished (`done`), or the user archived it by hand.
 */
export const ArchiveReason = z.enum(['merged', 'discarded', 'completed', 'archived-by-user']);
export type ArchiveReason = z.infer<typeof ArchiveReason>;

/** Set on an archived agent's summary. Its row, summary and transcript stay in the database. */
export const AgentArchiveInfo = z.object({
  at: z.number(),
  reason: ArchiveReason,
  /** The merge commit in the main checkout (reason `merged`). */
  mergeCommit: z.string().optional(),
  /** The worktree folder was deleted (Settings › Agents › Clean up, or Remove worktree). */
  worktreeRemoved: z.boolean().default(false),
});
export type AgentArchiveInfo = z.infer<typeof AgentArchiveInfo>;

/**
 * An agent whose process was gone after oIDE restarted while it was working: a normal quit
 * (`restart`), a crash of oIDE (`crash`), or not resumed because oIDE's MCP server was down
 * (`mcp-down`). Shown on the Wall as "Interrupted" with Resume; cleared once it runs again.
 */
export const AgentInterruption = z.object({ at: z.number(), reason: z.enum(['restart', 'crash', 'mcp-down']) });
export type AgentInterruption = z.infer<typeof AgentInterruption>;

/**
 * The pull request for an agent's branch (opened from oIDE or anywhere else), from the user's own
 * `gh`. An open or draft PR is polled; once merged the agent is archived (reason `merged`).
 */
/**
 * The PR head's CI checks (GitHub's status check rollup: check runs and commit statuses), counted.
 * `pending` while any check has not finished; `failure` once all finished and at least one failed;
 * `success` when all finished without a failure (skipped and neutral count as passed).
 */
export const AgentPrChecks = z.object({
  state: z.enum(['pending', 'success', 'failure']),
  total: z.number().int().positive().max(10_000),
  /** Checks that finished (passed or failed). */
  completed: z.number().int().nonnegative().max(10_000),
  /** Finished checks that failed (failure, error, cancelled, timed out, action required). */
  failed: z.number().int().nonnegative().max(10_000),
});
export type AgentPrChecks = z.infer<typeof AgentPrChecks>;

export const AgentPrInfo = z.object({
  number: z.number().int().positive(),
  url: z.string().url(),
  state: z.enum(['open', 'draft', 'merged', 'closed']),
  /** The merge commit on the base branch, when gh reports it (merged PRs). */
  mergeCommit: z.string().optional(),
  /** CI checks on the PR's head commit; absent when the PR has none (or gh is too old to say). */
  checks: AgentPrChecks.optional(),
  /** When oIDE last saw this state. */
  checkedAt: z.number().optional(),
});
export type AgentPrInfo = z.infer<typeof AgentPrInfo>;

/**
 * Set while the agent is resolving merge conflicts that oIDE sent it ("Ask <agent> to resolve" in
 * Review's merge dialog). Cleared when it submits for review again; the user then merges by hand.
 */
export const AgentMergeConflict = z.object({
  /** The branch it merges in (the main checkout's branch), or the commit on a detached HEAD. */
  target: z.string().min(1).max(255),
  /** The target's commit when the conflicts were sent. */
  targetSha: z.string().regex(/^[0-9a-f]{7,64}$/),
  /** Conflicted paths (as predicted, or as the merge reported them). */
  files: z.array(z.string()).max(1000).default([]),
  sentAt: z.number(),
});
export type AgentMergeConflict = z.infer<typeof AgentMergeConflict>;

/** Compact per-agent state the Wall renders. Reduced from the event stream in main. */
export const AgentSummary = z.object({
  id: Id,
  projectId: Id,
  title: z.string(),
  status: AgentStatus,
  mode: PermissionMode,
  model: z.string(),
  sessionId: z.string().optional(),
  branch: z.string().optional(),
  worktreePath: z.string().optional(),
  baseRef: z.string().optional(),
  /** Where it works (from its spec), so the UI offers Bypass only where main accepts it. */
  workIn: WorkIn.optional(),
  /** The artifact an artifact agent edits (from its spec). */
  artifactId: Id.optional(),
  /** The lead's effort (from its spec), when one was picked; else the CLI's default applies. */
  effort: Effort.optional(),
  attemptGroup: Id.optional(),
  /** Last few activity lines ("Read src/x.ts", "Thinking…"). */
  activity: z.array(z.string()).default([]),
  contextUsed: z.number().nonnegative().default(0),
  contextWindow: z.number().positive().default(200_000),
  /**
   * Context of the session's first lead request: system prompt, CLAUDE.md, tool and MCP definitions
   * and the first prompt. Shown in the ring tooltip so a high starting value is explained.
   */
  contextBaseline: z.number().nonnegative().optional(),
  usage: TokenUsage.default({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }),
  diff: DiffStat.optional(),
  pendingPermission: PermissionRequest.optional(),
  subagents: z.array(SubagentInfo).default([]),
  todos: z.array(TodoItem).default([]),
  review: ReviewSubmission.optional(),
  lastMessage: z.string().optional(),
  error: z.string().optional(),
  rateLimitResetAt: z.number().optional(),
  exitCode: z.number().nullable().optional(),
  /** Plan text from plan mode (ExitPlanMode input), shown in the Plan tab. Added by agent-core. */
  planText: z.string().optional(),
  /**
   * The prompt that was still waiting for an answer when oIDE quit (it was denied then). Cleared when
   * the user sends the agent a message. Tile and Focus say "send a message to continue".
   */
  interruptedPermission: z.object({ toolName: z.string(), summary: z.string().optional(), at: z.number() }).optional(),
  /** Background subagent tasks still running after the lead's turn ended (`system/background_tasks_changed`). */
  backgroundTasks: z.number().int().nonnegative().default(0),
  /** Archived agents only (Archived view); never set on the Wall. */
  archived: AgentArchiveInfo.optional(),
  /** Stopped by an oIDE restart or crash while working (see AgentInterruption). */
  interrupted: AgentInterruption.optional(),
  /** Why Resume cannot work, e.g. the worktree was deleted. Resume is hidden while this is set. */
  resumeBlocked: z.string().optional(),
  /** The branch's pull request, when there is one (tile "View PR #12", Focus, Review). */
  pr: AgentPrInfo.optional(),
  /** Resolving merge conflicts oIDE sent it (tile badge "Resolving merge conflicts"). */
  mergeConflict: AgentMergeConflict.optional(),
  /** Cost the CLI reported (`total_cost_usd`), summed over the agent's processes. */
  costUsd: z.number().nonnegative().optional(),
  /** Latest plan usage window from the CLI's `rate_limit_event` (utilization is 0..1 when reported). */
  planUsage: z
    .object({
      status: z.string(),
      window: z.string().optional(),
      utilization: z.number().optional(),
      resetsAt: z.number().optional(),
    })
    .optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type AgentSummary = z.infer<typeof AgentSummary>;

export interface SummaryRepair {
  /** The summary, valid against the current contract, or undefined when it cannot be repaired. */
  summary?: AgentSummary;
  /** Top-level fields or list items that were dropped to make it valid ("diff", "activity[3]"). */
  dropped: string[];
  /** The contract issues of the original value (empty when it was valid). */
  issues: string[];
}

/**
 * Parse a stored or live summary that may not match the current contract (written by an older
 * build, or a reducer bug). Drops what is invalid where the contract allows it: optional and
 * defaulted fields, and single bad items of the activity, subagents and todos lists. Required
 * fields (id, projectId, title, status, mode, model, createdAt, updatedAt) cannot be dropped.
 * One bad agent must never hide the others (2026-11-25).
 */
export function repairAgentSummary(value: unknown): SummaryRepair {
  const first = AgentSummary.safeParse(value);
  if (first.success) return { summary: first.data, dropped: [], issues: [] };
  const issues = first.error.issues.slice(0, 10).map((i) => `${i.path.join('.') || '(summary)'}: ${i.message}`);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { dropped: [], issues };
  const shape = AgentSummary.shape as Record<string, z.ZodType>;
  const draft: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  const dropped: string[] = [];
  let last = first.error;
  for (let pass = 0; pass < 5; pass++) {
    let changed = false;
    // Delete list items from the end so earlier indexes stay valid.
    const items = last.issues
      .filter((i) => i.path.length >= 2 && typeof i.path[1] === 'number' && Array.isArray(draft[i.path[0] as string]))
      .map((i) => ({ key: String(i.path[0]), index: i.path[1] as number }))
      .sort((a, b) => b.index - a.index);
    const seen = new Set<string>();
    for (const { key, index } of items) {
      if (seen.has(`${key}[${index}]`)) continue;
      seen.add(`${key}[${index}]`);
      draft[key] = (draft[key] as unknown[]).filter((_, i) => i !== index);
      dropped.push(`${key}[${index}]`);
      changed = true;
    }
    for (const i of last.issues) {
      const key = i.path[0];
      if (typeof key !== 'string' || !(key in draft) || seen.has(key)) continue;
      if (i.path.length >= 2 && typeof i.path[1] === 'number' && Array.isArray(draft[key])) continue;
      const field = shape[key];
      if (!field || !field.safeParse(undefined).success) continue;
      delete draft[key];
      seen.add(key);
      dropped.push(key);
      changed = true;
    }
    const next = AgentSummary.safeParse(draft);
    if (next.success) return { summary: next.data, dropped, issues };
    if (!changed) break;
    last = next.error;
  }
  return { dropped, issues };
}

/**
 * Merge conflicts oIDE hands back to the agent (Review › Merge › "Ask <agent> to resolve"). Built in
 * main only: `agents.send` refuses this kind, so the transcript's "Sent by oIDE" is always true.
 */
export const MergeConflictsMessage = z.object({
  kind: z.literal('merge-conflicts'),
  /** The main checkout's branch (e.g. `main`), or the commit on a detached HEAD. */
  target: z.string().min(1).max(255),
  targetSha: z.string().regex(/^[0-9a-f]{7,64}$/),
  /** What the agent passes to `git merge` (the branch name, or the commit). */
  mergeRef: z.string().min(1).max(255),
  /** The target is a remote-tracking ref: fetch before merging. */
  fetchFirst: z.boolean().default(false),
  /** Conflicted paths; empty when they could not be predicted. */
  files: z.array(z.string()).max(1000).default([]),
  binary: z.array(z.string()).max(1000).default([]),
  submodules: z.array(z.string()).max(1000).default([]),
});
export type MergeConflictsMessage = z.infer<typeof MergeConflictsMessage>;

/** User → agent messages, delivered as stream-json user messages. */
export const UserMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().min(1), attachments: MessageAttachments.optional() }),
  z.object({ kind: z.literal('command'), command: z.string().regex(/^\//) }),
  z.object({
    kind: z.literal('review-feedback'),
    comments: z.array(z.object({ path: z.string(), line: z.number().int().optional(), side: z.enum(['old', 'new']).optional(), body: z.string() })),
    note: z.string().optional(),
  }),
  z.object({ kind: z.literal('artifact'), artifactId: Id, note: z.string().optional(), attachments: MessageAttachments.optional() }),
  MergeConflictsMessage,
]);
export type UserMessage = z.infer<typeof UserMessage>;
