import { z } from 'zod';

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

/** Where an agent works. */
export const WorkIn = z.enum(['worktree-from-main', 'worktree-from-current', 'project-folder']);
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
  /** Technique ids, applied in Settings order. */
  techniques: z.array(Id).default([]),
  /** Extension ids whose tools this agent gets. */
  extensions: z.array(Id).default([]),
  attempts: z.number().int().min(1).max(6).default(1),
  /** Shared by parallel attempts. */
  attemptGroup: Id.optional(),
});
export type AgentSpec = z.infer<typeof AgentSpec>;
export type AgentSpecInput = z.input<typeof AgentSpec>;

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

/** What an agent sends through `oide.submit_for_review`. */
export const ReviewSubmission = z.object({
  agentId: Id,
  summary: z.string(),
  checks: z.array(CheckResult).default([]),
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
]);
export type UserMessage = z.infer<typeof UserMessage>;
