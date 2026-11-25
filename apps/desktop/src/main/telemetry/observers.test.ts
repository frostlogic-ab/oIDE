import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSpec, validateTelemetryEvent, type AgentEvent } from '@oide/protocol';
import { TelemetryObservers, type TelemetrySink } from './observers.js';

function sink() {
  const events: Array<{ name: string; props: Record<string, unknown> }> = [];
  const errors: Array<{ e: unknown; opts: unknown }> = [];
  const s: TelemetrySink = {
    track: (name, props) => {
      // Everything an observer emits must pass the catalogue.
      expect(validateTelemetryEvent(name, props), `${name} ${JSON.stringify(props)}`).not.toBeNull();
      events.push({ name, props: props as Record<string, unknown> });
      return true;
    },
    error: (e, opts) => {
      errors.push({ e, opts });
      return true;
    },
  };
  return { s, events, errors };
}

let now = 0;
const ev = (e: Record<string, unknown>): AgentEvent =>
  ({ agentId: 'a1', seq: 1, ts: now, ...e }) as AgentEvent;

beforeEach(() => {
  now = 1_000_000;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const make = (official = true) => {
  const x = sink();
  return {
    ...x,
    o: new TelemetryObservers(x.s, { officialIndex: () => official, now: () => now, searchIdleMs: 1000 }),
  };
};

describe('commands', () => {
  it('agent_spawned carries only enum-like facts, never title, goal or paths', () => {
    const { o, events } = make();
    const spec = AgentSpec.parse({
      projectId: 'p1',
      title: 'Fix login for ACME',
      goal: 'Read C:\\Users\\jane\\acme\\secret.md and fix it',
      strategy: { kind: 'single', lead: { model: 'claude-opus-5-5', effort: 'high' } },
      mode: 'acceptEdits',
      attempts: 3,
      attachments: [{ kind: 'image', mediaType: 'image/png', dataBase64: 'iVBORw0KGgo=', name: 'shot.png' }],
      context: [{ kind: 'file', path: 'src/acme.ts' }],
    });
    o.command('agents.spawn', spec, []);
    expect(events).toEqual([
      {
        name: 'agent_spawned',
        props: {
          model: 'opus',
          effort: 'high',
          strategy: 'single',
          mode: 'acceptEdits',
          work_in: 'worktree-from-main',
          attempts: 3,
          has_attachments: true,
          has_context: true,
          techniques: 0,
          extensions: 0,
        },
      },
      { name: 'attachments_sent', props: { where: 'spawn', images: 1, files: 0 } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ACME|acme|secret|shot/);
  });

  it('slash commands: built-in names only', () => {
    const { o, events } = make();
    o.command(
      'agents.send',
      { agentId: 'a1', message: { kind: 'command', command: '/context' } },
      { ok: true },
    );
    o.command(
      'agents.send',
      { agentId: 'a1', message: { kind: 'command', command: '/acme-deploy prod' } },
      { ok: true },
    );
    o.command('agents.send', { agentId: 'a1', message: { kind: 'text', text: 'hello' } }, { ok: true });
    expect(events.map((e) => e.props.command)).toEqual(['context', 'other']);
  });

  it('permission answers: decision, tool category and wait, matched by request id', () => {
    const { o, events } = make();
    o.agentEvent(
      ev({
        type: 'permission-request',
        request: {
          requestId: 'r1',
          agentId: 'a1',
          toolName: 'mcp__acme__deploy',
          input: { secret: 1 },
          summary: 'Deploy acme',
          createdAt: now,
        },
      }),
    );
    o.agentEvent(
      ev({
        type: 'permission-request',
        request: {
          requestId: 'r2',
          agentId: 'a1',
          toolName: 'Bash',
          input: {},
          summary: 'npm test',
          createdAt: now,
        },
      }),
    );
    now += 30_000;
    o.command(
      'agents.answerPermission',
      { agentId: 'a1', answer: { requestId: 'r1', behavior: 'allow', always: true } },
      { ok: true },
    );
    o.command(
      'agents.answerPermission',
      { agentId: 'a1', answer: { requestId: 'r2', behavior: 'deny', message: 'no' } },
      { ok: true },
    );
    expect(events.map((e) => e.props)).toEqual([
      { decision: 'always', tool: 'mcp', wait: '10s-1m' },
      { decision: 'deny', tool: 'Bash', wait: '10s-1m' },
    ]);
  });

  it('merge, discard, PR and compact', () => {
    const { o, events } = make();
    o.command('git.mergeLocal', { agentId: 'a1' }, { ok: false, conflicts: ['src/x.ts'] });
    o.command('agents.remove', { agentId: 'a1', deleteWorktree: true }, { ok: true });
    o.command(
      'git.openPr',
      { agentId: 'a1', title: 'Secret', body: '' },
      { url: 'https://github.com/acme/x/pull/1' },
    );
    o.command('agents.compact', { agentId: 'a1' }, { ok: true });
    expect(events).toEqual([
      { name: 'agent_merged', props: { result: 'conflicts' } },
      { name: 'agent_discarded', props: { worktree_deleted: true } },
      { name: 'pr_opened', props: {} },
      { name: 'compact_requested', props: {} },
    ]);
  });

  it('quick open: one event per run of keystrokes, with the last result count bucketed', async () => {
    const { o, events } = make();
    for (const n of [120, 40, 3])
      o.command(
        'files.findByName',
        { roots: ['C:\\acme'], query: 'sec' },
        { results: Array.from({ length: n }, () => ({})), total: 900, stale: false },
      );
    expect(events).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([
      { name: 'file_search_used', props: { kind: 'name', results: '2-5', queries: 3 } },
    ]);
  });

  it('content search: counted when the final batch arrives; cancelled searches are not', async () => {
    const { o, events } = make();
    o.command(
      'files.searchContent',
      { searchId: 's1', roots: ['C:\\acme'], query: 'TODO', isRegex: true },
      { ok: true },
    );
    o.emitted('files.searchResults', { searchId: 's1', files: [], done: false, truncated: false });
    o.emitted('files.searchResults', {
      searchId: 's1',
      files: [],
      done: true,
      truncated: false,
      stats: { files: 4, matches: 17, ms: 30, engine: 'git-grep' },
    });
    o.command('files.searchContent', { searchId: 's2', roots: ['C:\\acme'], query: 'x' }, { ok: true });
    o.emitted('files.searchResults', {
      searchId: 's2',
      files: [],
      done: true,
      truncated: false,
      cancelled: true,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([
      {
        name: 'file_search_used',
        props: { kind: 'content', results: '6-20', queries: 1, regex: true, engine: 'git-grep' },
      },
    ]);
  });

  it('replace: files replaced, bucketed', () => {
    const { o, events } = make();
    o.command(
      'files.replace',
      { isRegex: false },
      { results: [{ status: 'replaced' }, { status: 'replaced' }, { status: 'stale' }] },
    );
    expect(events).toEqual([
      { name: 'file_search_used', props: { kind: 'replace', results: '2-5', queries: 1, regex: false } },
    ]);
  });

  it('extension_installed: official marketplace ids only, never folder, git or a custom index', () => {
    const ext = (source: string, name = 'oide-browser-preview') => ({
      id: 'x',
      name,
      version: '1.0.0',
      displayName: 'X',
      source,
      path: 'C:\\x',
      manifest: {},
    });
    const off = make(true);
    off.o.command('extensions.install', { name: 'oide-browser-preview' }, ext('marketplace'));
    off.o.command('extensions.install', { name: 'x' }, ext('folder', 'my-local-thing'));
    off.o.command('extensions.install', { name: 'x' }, ext('git', 'acme-internal'));
    expect(off.events).toEqual([
      { name: 'extension_installed', props: { extension: 'oide-browser-preview', source: 'marketplace' } },
    ]);
    const custom = make(false);
    custom.o.command('extensions.install', { name: 'oide-browser-preview' }, ext('marketplace'));
    expect(custom.events).toEqual([]);
  });

  it('setting_changed: allow-listed keys only, never values, rate limited per key', () => {
    const { o, events } = make();
    o.command(
      'settings.update',
      {
        patch: {
          agents: { maxRunning: 5 },
          claude: { cliPath: 'C:\\Users\\jane\\claude.exe' },
          models: { custom: [] },
        },
      },
      {},
    );
    o.command('settings.update', { patch: { agents: { maxRunning: 6 } } }, {});
    now += 11_000;
    o.command('settings.update', { patch: { agents: { maxRunning: 7 } } }, {});
    expect(events.map((e) => e.props.key)).toEqual([
      'agents.maxRunning',
      'claude.cliPath',
      'agents.maxRunning',
    ]);
    expect(JSON.stringify(events)).not.toMatch(/jane|claude\.exe|5|6|7/);
  });
});

describe('agent events', () => {
  it('agent_finished: outcome, duration, first output, subagents, tokens, turns', () => {
    const { o, events } = make();
    o.agentEvent(ev({ type: 'status', status: 'queued' }));
    now += 5_000;
    o.agentEvent(ev({ type: 'status', status: 'starting' }));
    now += 1_500;
    o.agentEvent(ev({ type: 'partial', text: 'secret output' }));
    o.agentEvent(
      ev({ type: 'usage', usage: { input: 30_000, output: 25_000, cacheRead: 0, cacheCreation: 0 } }),
    );
    o.agentEvent(
      ev({
        type: 'subagent',
        subagent: { id: 't1', agentId: 'a1', name: 'reviewer', task: 'secret task', status: 'running' },
      }),
    );
    o.agentEvent(
      ev({
        type: 'subagent',
        subagent: { id: 't1', agentId: 'a1', name: 'reviewer', task: 'secret task', status: 'done' },
      }),
    );
    o.agentEvent(ev({ type: 'result', subtype: 'success', isError: false, numTurns: 7 }));
    now += 120_000;
    o.agentEvent(ev({ type: 'status', status: 'ready-for-review' }));
    expect(events).toEqual([
      {
        name: 'agent_finished',
        props: {
          outcome: 'ready-for-review',
          duration: '1-5m',
          duration_ms: 121_500,
          first_output_ms: 1_500,
          subagents: '1',
          tokens: '10k-100k',
          turns: '6-20',
        },
      },
    ]);
    // A second terminal status without a new start is not another run.
    o.agentEvent(ev({ type: 'status', status: 'done' }));
    expect(events).toHaveLength(1);
  });

  it('agent errors: an error report with the code only, and the code on agent_finished', () => {
    const { o, events, errors } = make();
    o.agentEvent(ev({ type: 'status', status: 'running' }));
    o.agentEvent(ev({ type: 'error', message: 'auth failed for jane@acme.com at C:\\x', code: 'auth' }));
    o.agentEvent(ev({ type: 'error', message: 'again', code: 'auth' }));
    o.agentEvent(ev({ type: 'status', status: 'error' }));
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toMatch(/jane|acme|C:/);
    expect(errors[0]!.e).toEqual({ name: 'AgentError', message: 'agent error: auth', stack: '' });
    expect(events[0]!.props.error_code).toBe('auth');
  });

  it('unknown CLI events are counted by type and reported in aggregate', () => {
    const { o, events } = make();
    for (let i = 0; i < 3; i++) o.agentEvent(ev({ type: 'unknown', rawType: 'system/new_thing' }));
    o.agentEvent(ev({ type: 'unknown', rawType: 'C:\\Users\\jane' }));
    o.flushUnknownCliEvents();
    expect(events).toEqual([
      { name: 'cli_unknown_event', props: { event_type: 'system/new_thing', count: 3 } },
    ]);
    o.flushUnknownCliEvents();
    expect(events).toHaveLength(1);
  });

  it('extension host failures are error reports without the extension name', () => {
    const { o, errors } = make();
    o.emitted('extensions.hostState', { name: 'acme-private-ext', state: 'failed', panelIds: [] });
    o.emitted('extensions.hostState', { name: 'acme-private-ext', state: 'running', panelIds: [] });
    expect(errors).toHaveLength(1);
    expect(JSON.stringify(errors)).not.toContain('acme');
  });
});
