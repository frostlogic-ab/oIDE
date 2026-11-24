import { z } from 'zod';
import { AgentStatus, Id, PermissionRequest, ReviewSubmission, SubagentInfo, TodoItem, TokenUsage } from './agent.js';

/**
 * Normalized agent events. `packages/agent-core` parses raw CLI stream-json into these.
 * Raw CLI JSON is stored alongside (see store `events.raw`) so a newer parser can re-read old sessions.
 * Unknown CLI event types become `{ type: 'unknown' }` and are logged, never thrown.
 */

const base = {
  agentId: Id,
  /** Monotonic per agent. */
  seq: z.number().int().nonnegative(),
  ts: z.number(),
  /** Set when the event belongs to a subagent (the lead's Task tool_use id). */
  parentToolUseId: z.string().optional(),
};

export const AgentEvent = z.discriminatedUnion('type', [
  z.object({
    ...base,
    type: z.literal('init'),
    sessionId: z.string(),
    model: z.string(),
    cwd: z.string(),
    tools: z.array(z.string()).default([]),
    mcpServers: z.array(z.object({ name: z.string(), status: z.string() })).default([]),
    permissionMode: z.string().optional(),
    cliVersion: z.string().optional(),
  }),
  z.object({ ...base, type: z.literal('user-text'), text: z.string() }),
  z.object({ ...base, type: z.literal('assistant-text'), messageId: z.string().optional(), text: z.string() }),
  z.object({ ...base, type: z.literal('thinking'), messageId: z.string().optional(), text: z.string() }),
  /** Partial streaming delta (from --include-partial-messages). Not persisted. */
  z.object({
    ...base,
    type: z.literal('partial'),
    messageId: z.string().optional(),
    kind: z.enum(['text', 'thinking', 'tool-input']),
    delta: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('tool-use'),
    toolUseId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    ...base,
    type: z.literal('tool-result'),
    toolUseId: z.string(),
    isError: z.boolean().default(false),
    content: z.string(),
  }),
  z.object({
    ...base,
    type: z.literal('usage'),
    messageId: z.string().optional(),
    model: z.string().optional(),
    usage: TokenUsage,
  }),
  z.object({
    ...base,
    type: z.literal('result'),
    subtype: z.string(),
    isError: z.boolean(),
    durationMs: z.number().optional(),
    numTurns: z.number().optional(),
    totalCostUsd: z.number().optional(),
    text: z.string().optional(),
    usage: TokenUsage.optional(),
  }),
  z.object({ ...base, type: z.literal('status'), status: AgentStatus, detail: z.string().optional() }),
  z.object({ ...base, type: z.literal('permission-request'), request: PermissionRequest }),
  z.object({
    ...base,
    type: z.literal('permission-resolved'),
    requestId: z.string(),
    behavior: z.enum(['allow', 'deny']),
  }),
  z.object({ ...base, type: z.literal('todos'), todos: z.array(TodoItem) }),
  z.object({ ...base, type: z.literal('subagent'), subagent: SubagentInfo }),
  z.object({ ...base, type: z.literal('review-submitted'), review: ReviewSubmission }),
  z.object({
    ...base,
    type: z.literal('rate-limit'),
    resetAt: z.number().optional(),
    message: z.string(),
  }),
  z.object({ ...base, type: z.literal('stderr'), text: z.string() }),
  z.object({ ...base, type: z.literal('exit'), code: z.number().nullable(), signal: z.string().nullable() }),
  z.object({ ...base, type: z.literal('error'), message: z.string() }),
  z.object({ ...base, type: z.literal('unknown'), rawType: z.string() }),
]);
export type AgentEvent = z.infer<typeof AgentEvent>;
export type AgentEventType = AgentEvent['type'];

/** Distributive Omit so callers can build events without seq/ts. */
export type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type AgentEventDraft = DistributiveOmit<AgentEvent, 'seq' | 'ts' | 'agentId'>;
