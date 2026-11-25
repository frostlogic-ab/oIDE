import { describe, expect, it } from 'vitest';
import { contextWindowFor, type AgentEvent, type AgentEventDraft } from '@oide/protocol';
import { fixture, fixtureEvents } from '../test/helpers.js';
import { ContextWindowBook } from './context-window.js';
import { parseLine } from './parser.js';
import { AgentReducer, createSummary } from './reducer.js';

/**
 * Context ring accuracy against the CLI's own `/context` (CLI 2.1.325). Each real-context-*.jsonl
 * fixture is one simple prompt followed by `/context`; the synthetic assistant message of `/context`
 * carries `context_usage {total_tokens, raw_max_tokens, percentage}`, which is the ground truth here.
 * `*-mcp` ran with the user's full MCP setup (59 servers, 439 MCP tools, deferred by the CLI);
 * `haiku-strict` with `--strict-mcp-config` and no servers.
 */
const FIXTURES = [
  { file: 'real-context-sonnet-mcp.jsonl', model: 'sonnet' },
  { file: 'real-context-opus-mcp.jsonl', model: 'opus' },
  { file: 'real-context-haiku-mcp.jsonl', model: 'haiku' },
  { file: 'real-context-haiku-strict.jsonl', model: 'haiku' },
];

function cliContext(file: string): { used: number; window: number; percentage: number } {
  for (const l of fixture(file).split('\n')) {
    if (!l.includes('"context_usage"')) continue;
    const cu = (JSON.parse(l) as { context_usage: { total_tokens: number; raw_max_tokens: number; percentage: number } }).context_usage;
    return { used: cu.total_tokens, window: cu.raw_max_tokens, percentage: cu.percentage };
  }
  throw new Error(`no /context in ${file}`);
}

const fresh = (model: string) => createSummary({ id: 'agent-1', projectId: 'p1', title: 'T', mode: 'auto', model, status: 'starting', now: 0 });
const pct = (s: { contextUsed: number; contextWindow: number }) => (100 * s.contextUsed) / s.contextWindow;

let seq = 5000;
const ev = (d: AgentEventDraft): AgentEvent => ({ ...d, agentId: 'agent-1', seq: seq++, ts: seq }) as AgentEvent;

describe('context ring vs the CLI /context (real fixtures)', () => {
  for (const { file, model } of FIXTURES) {
    it(`${file}: first turn, before any result, matches /context within 1 point`, () => {
      const truth = cliContext(file);
      const r = new AgentReducer(fresh(model));
      const events = fixtureEvents(file);
      const firstResult = events.findIndex((e) => e.type === 'result');
      for (const e of events.slice(0, firstResult)) r.apply(e);
      // Before the fix: 36.7k drawn against the 200k fallback = 18% while the CLI said 4%.
      expect(r.summary.contextWindow).toBe(truth.window);
      expect(Math.abs(pct(r.summary) - (100 * truth.used) / truth.window)).toBeLessThan(1);
      expect(Math.round(pct(r.summary))).toBe(truth.percentage);
      expect(r.summary.contextBaseline).toBe(r.summary.contextUsed);
    });

    it(`${file}: after the turn and /context, the ring equals the CLI's count exactly`, () => {
      const truth = cliContext(file);
      const r = new AgentReducer(fresh(model));
      for (const e of fixtureEvents(file)) r.apply(e);
      expect(r.summary.contextUsed).toBe(truth.used);
      expect(r.summary.contextWindow).toBe(truth.window);
      expect(Math.round(pct(r.summary))).toBe(truth.percentage);
    });
  }

  it('the MCP setup barely moves the first-turn count (the CLI defers MCP tool definitions)', () => {
    const mcp = cliContext('real-context-haiku-mcp.jsonl');
    const strict = cliContext('real-context-haiku-strict.jsonl');
    expect(Math.abs(mcp.used - strict.used)).toBeLessThan(2_000); // 37,473 vs 36,556
  });

  it('parses /context into a context-usage event and ignores its synthetic zero usage', () => {
    const line = fixture('real-context-sonnet-mcp.jsonl')
      .split('\n')
      .find((l) => l.includes('"context_usage"'))!;
    const { events } = parseLine(line);
    const cu = events.find((e) => e.type === 'context-usage');
    expect(cu).toMatchObject({ type: 'context-usage', used: 36_652, window: 1_000_000, percentage: 4, model: 'claude-sonnet-5-5' });
    expect(cu && cu.type === 'context-usage' ? cu.categories?.find((c) => c.name === 'MCP tools (deferred)')?.kind : undefined).toBe('deferred');
    expect(events.some((e) => e.type === 'usage')).toBe(false);
  });
});

describe('context window selection', () => {
  it('the table knows the 5.5 models are 1M (what the CLI reports) and keeps 200k for unverified ones', () => {
    for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'opus', 'sonnet', 'haiku', 'claude-opus-4-8[1m]']) expect(contextWindowFor(m)).toBe(1_000_000);
    for (const m of ['claude-opus-4-8', 'claude-fable-5-2', 'something-else']) expect(contextWindowFor(m)).toBe(200_000);
  });

  it("long first turn on opus (the user's 75%/92% report): 84.8k first request reads 8%, not 42%", () => {
    // Numbers from the user's real oIDE session: first lead request 84,799 tokens, no result yet.
    const r = new AgentReducer(fresh('opus'));
    r.apply(ev({ type: 'init', sessionId: 's', model: 'claude-opus-5-5', cwd: 'C:\\work\\repo', tools: [], mcpServers: [] }));
    r.apply(ev({ type: 'usage', messageId: 'm1', model: 'claude-opus-5-5', usage: { input: 2, output: 8, cacheRead: 0, cacheCreation: 84_797 } }));
    expect(Math.round(pct(r.summary))).toBe(8);
    expect(r.summary.contextBaseline).toBe(84_799);
    r.apply(ev({ type: 'usage', messageId: 'm2', model: 'claude-opus-5-5', usage: { input: 2, output: 16, cacheRead: 148_928, cacheCreation: 1_000 } }));
    expect(Math.round(pct(r.summary))).toBe(15); // was 75% against 200k
    expect(r.summary.contextBaseline).toBe(84_799);
  });

  it("subagent messages never move the lead's ring; the subagent gets its own ring and window", () => {
    const r = new AgentReducer(fresh('claude-opus-4-8'));
    r.apply(ev({ type: 'usage', messageId: 'm1', usage: { input: 2, output: 4, cacheRead: 40_000, cacheCreation: 2_000 } }));
    r.apply(ev({ type: 'tool-use', toolUseId: 'toolu_sub', name: 'Agent', input: { description: 'Look', prompt: 'look', subagent_type: 'Explore' } }));
    const res = r.apply(ev({ type: 'usage', messageId: 's1', parentToolUseId: 'toolu_sub', model: 'claude-haiku-5-5', usage: { input: 5, output: 5, cacheRead: 0, cacheCreation: 12_000 } }));
    expect(r.summary.contextUsed).toBe(42_002);
    expect(r.summary.contextWindow).toBe(200_000);
    const sub = res.subagents.find((x) => x.id === 'toolu_sub')!;
    expect(sub.contextUsed).toBe(12_005);
    expect(sub.contextWindow).toBe(1_000_000);
  });

  it("a result listing several models uses the lead model's window, not the largest", () => {
    const r = new AgentReducer(fresh('claude-opus-4-8'));
    r.apply(ev({ type: 'init', sessionId: 's', model: 'claude-opus-4-8', cwd: '', tools: [], mcpServers: [] }));
    r.apply(ev({ type: 'result', subtype: 'success', isError: false, contextWindow: 1_000_000, contextWindows: { 'claude-opus-4-8': 200_000, 'claude-haiku-5-5': 1_000_000 } }));
    expect(r.summary.contextWindow).toBe(200_000);
  });

  it('[1m] variants match their modelUsage key and the table', () => {
    const r = new AgentReducer(fresh('claude-opus-4-8[1m]'));
    expect(r.summary.contextWindow).toBe(1_000_000);
    r.apply(ev({ type: 'init', sessionId: 's', model: 'claude-opus-4-8[1m]', cwd: '', tools: [], mcpServers: [] }));
    r.apply(ev({ type: 'result', subtype: 'success', isError: false, contextWindows: { 'claude-opus-4-8': 1_000_000, 'claude-haiku-5-5': 1_000_000 } }));
    expect(r.summary.contextWindow).toBe(1_000_000);
  });

  it('a window learned from one agent applies to the next agent before its first result', () => {
    const book = new ContextWindowBook();
    const a = new AgentReducer(fresh('fable'), { windows: book });
    a.apply(ev({ type: 'init', sessionId: 's', model: 'claude-fable-5-2', cwd: '', tools: [], mcpServers: [] }));
    expect(a.summary.contextWindow).toBe(200_000);
    a.apply(ev({ type: 'result', subtype: 'success', isError: false, contextWindows: { 'claude-fable-5-2': 1_000_000 } }));
    expect(a.summary.contextWindow).toBe(1_000_000);
    const b = new AgentReducer(fresh('fable'), { windows: book });
    b.apply(ev({ type: 'init', sessionId: 's2', model: 'claude-fable-5-2', cwd: '', tools: [], mcpServers: [] }));
    expect(b.summary.contextWindow).toBe(1_000_000);
  });

  it('a restored agent keeps the window the CLI reported last time when its turn starts again', () => {
    const restored = { ...fresh('claude-fable-5-2'), contextWindow: 1_000_000, contextUsed: 300_000 };
    const r = new AgentReducer(restored);
    r.apply(ev({ type: 'init', sessionId: 's', model: 'claude-fable-5-2', cwd: '', tools: [], mcpServers: [] }));
    expect(r.summary.contextWindow).toBe(1_000_000);
    // A stale 200k stored by an older build for a 1M model does not stick.
    const stale = new AgentReducer({ ...fresh('claude-opus-5-5'), contextWindow: 200_000 });
    stale.apply(ev({ type: 'init', sessionId: 's', model: 'claude-opus-5-5', cwd: '', tools: [], mcpServers: [] }));
    expect(stale.summary.contextWindow).toBe(1_000_000);
  });

  it('/context refreshes used and window (authoritative, e.g. after compaction)', () => {
    const r = new AgentReducer(fresh('claude-opus-5-5'));
    r.apply(ev({ type: 'usage', messageId: 'm1', usage: { input: 2, output: 4, cacheRead: 300_000, cacheCreation: 2_000 } }));
    r.apply(ev({ type: 'compact', phase: 'done', postTokens: 21_000 }));
    r.apply(ev({ type: 'context-usage', used: 24_500, window: 1_000_000, percentage: 2, model: 'claude-opus-5-5' }));
    expect(r.summary.contextUsed).toBe(24_500);
    expect(r.summary.contextWindow).toBe(1_000_000);
  });
});
