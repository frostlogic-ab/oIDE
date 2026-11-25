import { z } from 'zod';
import type { AgentEventDraft, TokenUsage } from '@oide/protocol';

/**
 * stream-json line parser. Raw shapes were verified against Claude Code CLI 2.1.325
 * (fixtures in tools/fake-claude/fixtures/real-*.jsonl, notes in docs/wiki/pages/cli-integration.md).
 * Every raw shape is a loose Zod object: unknown fields are kept, unknown types become `unknown` events.
 * The parser never throws.
 */

const RawUsage = z.looseObject({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
  cache_read_input_tokens: z.number().nullable().optional(),
  cache_creation_input_tokens: z.number().nullable().optional(),
});

const TextBlock = z.looseObject({ type: z.literal('text'), text: z.string() });
const ThinkingBlock = z.looseObject({ type: z.literal('thinking'), thinking: z.string().default('') });
const RedactedThinkingBlock = z.looseObject({ type: z.literal('redacted_thinking') });
const ToolUseBlock = z.looseObject({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() });
const ToolResultBlock = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
});

const RawInit = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  model: z.string().default(''),
  cwd: z.string().default(''),
  tools: z.array(z.string()).default([]),
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string().default('unknown') })).default([]),
  permissionMode: z.string().optional(),
  claude_code_version: z.string().optional(),
  /** Commands the session accepts (without "/"); a malformed list is dropped, never fatal. */
  slash_commands: z.array(z.unknown()).optional().catch(undefined),
});

const RawAssistant = z.looseObject({
  type: z.literal('assistant'),
  parent_tool_use_id: z.string().nullable().optional(),
  error: z.string().optional(),
  message: z.looseObject({
    id: z.string().optional(),
    model: z.string().optional(),
    content: z.array(z.unknown()).default([]),
    usage: RawUsage.nullable().optional(),
  }),
});

/** `/context`'s structured count on its synthetic assistant message (CLI 2.1.325). */
const RawContextUsage = z.looseObject({
  model: z.string().optional(),
  total_tokens: z.number().nonnegative(),
  raw_max_tokens: z.number().positive(),
  percentage: z.number().optional(),
  categories: z
    .array(z.looseObject({ name: z.string(), tokens: z.number(), kind: z.string().optional() }))
    .optional()
    .catch(undefined),
});

const RawUser = z.looseObject({
  type: z.literal('user'),
  parent_tool_use_id: z.string().nullable().optional(),
  isReplay: z.boolean().optional(),
  message: z.looseObject({ content: z.union([z.string(), z.array(z.unknown())]) }),
});

const RawResult = z.looseObject({
  type: z.literal('result'),
  subtype: z.string().default('unknown'),
  is_error: z.boolean().default(false),
  duration_ms: z.number().optional(),
  num_turns: z.number().optional(),
  total_cost_usd: z.number().optional(),
  result: z.string().optional(),
  usage: RawUsage.optional(),
  modelUsage: z.record(z.string(), z.looseObject({ contextWindow: z.number().optional() })).optional(),
  api_error_status: z.number().nullable().optional(),
  local_command: z.string().optional(),
  errors: z.array(z.string()).optional(),
  terminal_reason: z.string().optional(),
});

const RawStreamEvent = z.looseObject({
  type: z.literal('stream_event'),
  parent_tool_use_id: z.string().nullable().optional(),
  api_message_id: z.string().optional(),
  event: z.looseObject({
    type: z.string(),
    delta: z
      .looseObject({ type: z.string().optional(), text: z.string().optional(), thinking: z.string().optional(), partial_json: z.string().optional() })
      .optional(),
    message: z.looseObject({ id: z.string().optional() }).optional(),
  }),
});

const RawRateLimit = z.looseObject({
  type: z.literal('rate_limit_event'),
  rate_limit_info: z.looseObject({
    status: z.string().default('unknown'),
    resetsAt: z.number().optional(),
    rateLimitType: z.string().optional(),
    utilization: z.number().optional(),
    unifiedWindows: z.record(z.string(), z.looseObject({ utilization: z.number().optional() })).optional(),
  }),
});

const RawTask = z.looseObject({
  type: z.literal('system'),
  subtype: z.enum(['task_started', 'task_progress', 'task_updated', 'task_notification']),
  task_id: z.string(),
  tool_use_id: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  subagent_type: z.string().optional(),
  summary: z.string().optional(),
  last_tool_name: z.string().optional(),
  usage: z.looseObject({ total_tokens: z.number().optional() }).optional(),
  patch: z.looseObject({ status: z.string().optional() }).optional(),
});

const RawStatus = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('status'),
  status: z.string().nullable().optional(),
  permissionMode: z.string().optional(),
  compact_result: z.string().optional(),
});

const RawCompactBoundary = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('compact_boundary'),
  compact_metadata: z.looseObject({ pre_tokens: z.number().optional(), post_tokens: z.number().optional() }).optional(),
});

const RawBackgroundTasks = z.looseObject({
  type: z.literal('system'),
  subtype: z.literal('background_tasks_changed'),
  tasks: z.array(z.unknown()).default([]),
});

export const RawControlResponse = z.looseObject({
  type: z.literal('control_response'),
  response: z.looseObject({
    subtype: z.string(),
    request_id: z.string(),
    response: z.unknown().optional(),
    error: z.string().optional(),
  }),
});
export type RawControlResponse = z.infer<typeof RawControlResponse>;

export const RawControlRequest = z.looseObject({
  type: z.literal('control_request'),
  request_id: z.string(),
  request: z.looseObject({ subtype: z.string() }),
});
export type RawControlRequest = z.infer<typeof RawControlRequest>;

/** System subtypes that carry nothing oIDE shows. They are dropped silently (not `unknown`). */
const IGNORED_SYSTEM = new Set([
  'hook_started',
  'hook_progress',
  'hook_response',
  'commands_changed',
  'thinking_tokens',
]);
const IGNORED_TYPES = new Set(['keep_alive', 'prompt_suggestion']);
const IGNORED_STREAM = new Set(['message_start', 'content_block_start', 'content_block_stop', 'message_delta', 'message_stop', 'ping']);

export interface ParsedLine {
  /** The parsed JSON (null when the line was not JSON). Keep the raw line for storage. */
  json: unknown;
  events: AgentEventDraft[];
  control?: RawControlResponse;
  controlRequest?: RawControlRequest;
}

export type ParserLogger = (message: string, detail?: unknown) => void;

export function toTokenUsage(u: z.infer<typeof RawUsage> | null | undefined): TokenUsage {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheCreation: u?.cache_creation_input_tokens ?? 0,
  };
}

/** Text of a tool_result content (string, or an array of text/other blocks). */
export function toolResultText(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object' && 'text' in b && typeof (b as { text: unknown }).text === 'string') return (b as { text: string }).text;
        if (b && typeof b === 'object' && 'type' in b) return `[${String((b as { type: unknown }).type)}]`;
        return '';
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

const AUTH_HINT = /not logged in|please run \/login|invalid api key|authentication|oauth token/i;

function ptu(v: string | null | undefined): { parentToolUseId?: string } {
  return v ? { parentToolUseId: v } : {};
}

/** Parse one stdout line from `claude -p --output-format stream-json`. Never throws. */
export function parseLine(line: string, log?: ParserLogger): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { json: null, events: [] };
  let json: unknown;
  try {
    json = JSON.parse(trimmed);
  } catch {
    log?.('non-JSON stdout line', trimmed.slice(0, 200));
    return { json: null, events: [{ type: 'stderr', text: trimmed }] };
  }
  try {
    return { json, ...parseObject(json, log) };
  } catch (err) {
    log?.('parser failure', err);
    return { json, events: [{ type: 'unknown', rawType: rawTypeOf(json) }] };
  }
}

function rawTypeOf(json: unknown): string {
  if (json && typeof json === 'object') {
    const o = json as { type?: unknown; subtype?: unknown };
    return `${String(o.type ?? 'unknown')}${o.subtype ? `/${String(o.subtype)}` : ''}`;
  }
  return typeof json;
}

/** `slash_commands` → `{ slashCommands }`: strings only, leading "/" dropped, de-duplicated. */
function slashCommandsOf(list: unknown[] | undefined): { slashCommands?: string[] } {
  if (!list) return {};
  const names = [...new Set(list.filter((c): c is string => typeof c === 'string').map((c) => c.trim().replace(/^\//, '')).filter(Boolean))];
  return names.length ? { slashCommands: names } : {};
}

function parseObject(json: unknown, log?: ParserLogger): Omit<ParsedLine, 'json'> {
  const type = json && typeof json === 'object' ? (json as { type?: unknown }).type : undefined;
  const subtype = json && typeof json === 'object' ? (json as { subtype?: unknown }).subtype : undefined;
  const unknown = (why?: string): Omit<ParsedLine, 'json'> => {
    log?.(`unknown CLI event ${rawTypeOf(json)}${why ? `: ${why}` : ''}`);
    return { events: [{ type: 'unknown', rawType: rawTypeOf(json) }] };
  };

  switch (type) {
    case 'system': {
      if (typeof subtype === 'string' && IGNORED_SYSTEM.has(subtype)) return { events: [] };
      if (subtype === 'init') {
        const r = RawInit.safeParse(json);
        if (!r.success) return unknown(r.error.message);
        const m = r.data;
        return {
          events: [
            {
              type: 'init',
              sessionId: m.session_id,
              model: m.model,
              cwd: m.cwd,
              tools: m.tools,
              mcpServers: m.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
              ...(m.permissionMode ? { permissionMode: m.permissionMode } : {}),
              ...(m.claude_code_version ? { cliVersion: m.claude_code_version } : {}),
              ...slashCommandsOf(m.slash_commands),
            },
          ],
        };
      }
      if (subtype === 'status') {
        const r = RawStatus.safeParse(json);
        if (!r.success) return unknown(r.error.message);
        const events: AgentEventDraft[] = [];
        if (r.data.permissionMode) events.push({ type: 'mode-changed', mode: r.data.permissionMode });
        if (r.data.status === 'compacting') events.push({ type: 'compact', phase: 'started' });
        if (r.data.compact_result && r.data.compact_result !== 'success') events.push({ type: 'compact', phase: 'failed' });
        return { events };
      }
      if (subtype === 'compact_boundary') {
        const r = RawCompactBoundary.safeParse(json);
        if (!r.success) return unknown(r.error.message);
        const md = r.data.compact_metadata;
        return {
          events: [
            {
              type: 'compact',
              phase: 'done',
              ...(md?.pre_tokens !== undefined ? { preTokens: md.pre_tokens } : {}),
              ...(md?.post_tokens !== undefined ? { postTokens: md.post_tokens } : {}),
            },
          ],
        };
      }
      if (subtype === 'background_tasks_changed') {
        const r = RawBackgroundTasks.safeParse(json);
        if (!r.success) return unknown(r.error.message);
        return { events: [{ type: 'background-tasks', count: r.data.tasks.length }] };
      }
      if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_updated' || subtype === 'task_notification') {
        const r = RawTask.safeParse(json);
        if (!r.success) return unknown(r.error.message);
        const t = r.data;
        const phase = ({ task_started: 'started', task_progress: 'progress', task_updated: 'updated', task_notification: 'notification' } as const)[t.subtype];
        const status = t.status ?? t.patch?.status;
        return {
          events: [
            {
              type: 'subagent-task',
              phase,
              taskId: t.task_id,
              ...(t.tool_use_id ? { toolUseId: t.tool_use_id } : {}),
              ...(status ? { status } : {}),
              ...(t.description ? { description: t.description } : {}),
              ...(t.subagent_type ? { subagentType: t.subagent_type } : {}),
              ...(t.summary ? { summary: t.summary } : {}),
              ...(t.last_tool_name ? { lastToolName: t.last_tool_name } : {}),
              ...(t.usage?.total_tokens !== undefined ? { totalTokens: t.usage.total_tokens } : {}),
            },
          ],
        };
      }
      return unknown();
    }

    case 'stream_event': {
      const r = RawStreamEvent.safeParse(json);
      if (!r.success) return unknown(r.error.message);
      const { event } = r.data;
      if (IGNORED_STREAM.has(event.type)) return { events: [] };
      if (event.type !== 'content_block_delta' || !event.delta) return { events: [] };
      const base = { ...ptu(r.data.parent_tool_use_id), ...(r.data.api_message_id ? { messageId: r.data.api_message_id } : {}) };
      const d = event.delta;
      if (d.type === 'text_delta' && d.text !== undefined) return { events: [{ type: 'partial', kind: 'text', delta: d.text, ...base }] };
      if (d.type === 'thinking_delta') return { events: [{ type: 'partial', kind: 'thinking', delta: d.thinking ?? '', ...base }] };
      if (d.type === 'input_json_delta') return { events: [{ type: 'partial', kind: 'tool-input', delta: d.partial_json ?? '', ...base }] };
      return { events: [] };
    }

    case 'assistant': {
      const r = RawAssistant.safeParse(json);
      if (!r.success) return unknown(r.error.message);
      const m = r.data;
      const base = ptu(m.parent_tool_use_id);
      const messageId = m.message.id;
      const idPart = messageId ? { messageId } : {};
      const events: AgentEventDraft[] = [];
      for (const block of m.message.content) {
        const t = TextBlock.safeParse(block);
        if (t.success) {
          events.push({ type: 'assistant-text', text: t.data.text, ...idPart, ...base });
          continue;
        }
        const th = ThinkingBlock.safeParse(block);
        if (th.success) {
          events.push({ type: 'thinking', text: th.data.thinking, ...idPart, ...base });
          continue;
        }
        if (RedactedThinkingBlock.safeParse(block).success) {
          events.push({ type: 'thinking', text: '', ...idPart, ...base });
          continue;
        }
        const tu = ToolUseBlock.safeParse(block);
        if (tu.success) {
          events.push({ type: 'tool-use', toolUseId: tu.data.id, name: tu.data.name, input: tu.data.input ?? {}, ...base });
          continue;
        }
        log?.('unknown assistant content block', block);
      }
      const cu = RawContextUsage.safeParse((json as { context_usage?: unknown }).context_usage);
      if (cu.success) {
        const c = cu.data;
        events.push({
          type: 'context-usage',
          used: c.total_tokens,
          window: c.raw_max_tokens,
          ...(c.percentage !== undefined ? { percentage: c.percentage } : {}),
          ...(c.model ? { model: c.model } : {}),
          ...(c.categories ? { categories: c.categories.map((x) => ({ name: x.name, tokens: x.tokens, ...(x.kind ? { kind: x.kind } : {}) })) } : {}),
          ...base,
        });
      }
      const synthetic = m.message.model === '<synthetic>';
      if (m.message.usage && !synthetic) {
        events.push({
          type: 'usage',
          ...idPart,
          ...(m.message.model ? { model: m.message.model } : {}),
          usage: toTokenUsage(m.message.usage),
          ...base,
        });
      }
      if (m.error) {
        const text = events.find((e) => e.type === 'assistant-text');
        const message = text && text.type === 'assistant-text' ? text.text : m.error;
        if (m.error === 'rate_limit') events.push({ type: 'rate-limit', message, ...base });
        else events.push({ type: 'error', message, code: m.error === 'authentication_failed' || AUTH_HINT.test(message) ? 'auth' : m.error, ...base });
      }
      return { events };
    }

    case 'user': {
      const r = RawUser.safeParse(json);
      if (!r.success) return unknown(r.error.message);
      const m = r.data;
      const base = ptu(m.parent_tool_use_id);
      const events: AgentEventDraft[] = [];
      const content = m.message.content;
      if (typeof content === 'string') {
        events.push({ type: 'user-text', text: content, ...base });
        return { events };
      }
      for (const block of content) {
        const tr = ToolResultBlock.safeParse(block);
        if (tr.success) {
          events.push({ type: 'tool-result', toolUseId: tr.data.tool_use_id, isError: tr.data.is_error ?? false, content: toolResultText(tr.data.content), ...base });
          continue;
        }
        const t = TextBlock.safeParse(block);
        if (t.success) events.push({ type: 'user-text', text: t.data.text, ...base });
      }
      return { events };
    }

    case 'result': {
      const r = RawResult.safeParse(json);
      if (!r.success) return unknown(r.error.message);
      const m = r.data;
      const perModel: Record<string, number> = {};
      for (const [model, x] of Object.entries(m.modelUsage ?? {})) if (typeof x.contextWindow === 'number' && x.contextWindow > 0) perModel[model] = x.contextWindow;
      const windows = Object.values(perModel);
      const events: AgentEventDraft[] = [
        {
          type: 'result',
          subtype: m.subtype,
          isError: m.is_error,
          ...(m.duration_ms !== undefined ? { durationMs: m.duration_ms } : {}),
          ...(m.num_turns !== undefined ? { numTurns: m.num_turns } : {}),
          ...(m.total_cost_usd !== undefined ? { totalCostUsd: m.total_cost_usd } : {}),
          ...(m.result !== undefined ? { text: m.result } : {}),
          ...(m.usage ? { usage: toTokenUsage(m.usage) } : {}),
          ...(windows.length ? { contextWindow: Math.max(...windows), contextWindows: perModel } : {}),
          ...(m.local_command ? { localCommand: m.local_command } : {}),
          ...(m.api_error_status !== undefined ? { apiErrorStatus: m.api_error_status } : {}),
        },
      ];
      if (m.is_error) {
        const message = m.result ?? m.errors?.join('; ') ?? m.subtype;
        if (m.api_error_status === 429) events.push({ type: 'rate-limit', message });
        else if (m.api_error_status === 401 || AUTH_HINT.test(message)) events.push({ type: 'error', message, code: 'auth' });
      }
      return { events };
    }

    case 'rate_limit_event': {
      const r = RawRateLimit.safeParse(json);
      if (!r.success) return unknown(r.error.message);
      const info = r.data.rate_limit_info;
      const window = info.rateLimitType;
      const utilization = info.utilization ?? (window ? info.unifiedWindows?.[window]?.utilization : undefined);
      const resetsAt = info.resetsAt !== undefined ? info.resetsAt * 1000 : undefined;
      const events: AgentEventDraft[] = [
        {
          type: 'plan-usage',
          status: info.status,
          ...(window ? { window } : {}),
          ...(utilization !== undefined ? { utilization } : {}),
          ...(resetsAt !== undefined ? { resetsAt } : {}),
        },
      ];
      if (info.status === 'rejected') {
        events.push({ type: 'rate-limit', message: `Plan limit reached${window ? ` (${window})` : ''}`, ...(resetsAt !== undefined ? { resetAt: resetsAt } : {}) });
      }
      return { events };
    }

    case 'control_response': {
      const r = RawControlResponse.safeParse(json);
      if (!r.success) return unknown(r.error.message);
      return { events: [], control: r.data };
    }

    case 'control_request': {
      const r = RawControlRequest.safeParse(json);
      if (!r.success) return unknown(r.error.message);
      return { events: [], controlRequest: r.data };
    }

    case 'control_cancel_request':
      return { events: [] };

    default:
      if (typeof type === 'string' && IGNORED_TYPES.has(type)) return { events: [] };
      return unknown();
  }
}

/** Parse a whole recorded transcript (one JSON object per line). */
export function parseTranscript(text: string, log?: ParserLogger): AgentEventDraft[] {
  const out: AgentEventDraft[] = [];
  for (const line of text.split(/\r?\n/)) out.push(...parseLine(line, log).events);
  return out;
}
