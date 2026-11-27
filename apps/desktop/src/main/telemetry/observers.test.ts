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
          auto_title: false,
        },
      },
      { name: 'attachments_sent', props: { where: 'spawn', images: 1, files: 0 } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ACME|acme|secret|shot/);
  });

  it('agent_titled: how long after the start the agent named its task, never the title', () => {
    const { o, events } = make();
    o.agentEvent(ev({ type: 'title-changed', title: 'ACME secret task' })); // no run seen: nothing to measure
    o.agentEvent(ev({ type: 'status', status: 'starting' }));
    now += 20_000;
    o.agentEvent(ev({ type: 'title-changed', title: 'ACME secret task', parentToolUseId: 'task-1' }));
    o.agentEvent(ev({ type: 'title-changed', title: 'ACME secret task' }));
    expect(events.filter((e) => e.name === 'agent_titled')).toHaveLength(1);
    expect(events.find((e) => e.name === 'agent_titled')!.props).toHaveProperty('after');
    expect(JSON.stringify(events)).not.toMatch(/ACME|secret/);
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

  it('merge conflicts: predicted once per pair of commits, sent to the agent, resolved with a duration; never file names', () => {
    const { o, events } = make();
    const prediction = { agentId: 'a1', status: 'conflicts', files: ['src/acme-secret.ts', 'logo.png', 'c.ts'], binary: ['logo.png'], submodules: [], target: { branch: 'acme-main', sha: 'aaa' }, branchSha: 'bbb' };
    o.command('git.predictMerge', { agentId: 'a1' }, prediction);
    o.command('git.predictMerge', { agentId: 'a1' }, prediction); // the dialog opened again
    o.command('git.predictMerge', { agentId: 'a1' }, { ...prediction, status: 'clean', files: [] });
    o.command('git.askToResolve', { agentId: 'a1', source: 'merge' }, { status: 'queued', files: 3, unarchived: false, resumed: true });
    now += 4 * 60_000;
    o.agentEvent(ev({ type: 'review-submitted', review: { agentId: 'a1', summary: 'Merged acme-main', checks: [], submittedAt: now } }));
    o.agentEvent(ev({ type: 'review-submitted', review: { agentId: 'a1', summary: 'again', checks: [], submittedAt: now } }));
    expect(events).toEqual([
      { name: 'merge_conflict_predicted', props: { files: '2-5', binary: true, submodules: false } },
      { name: 'merge_conflict_sent_to_agent', props: { source: 'merge', files: '2-5', agent: 'resumed' } },
      { name: 'merge_conflict_resolved', props: { duration: '1-5m' } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/acme|logo|src/);
  });

  it('merge, discard, PR and compact', () => {
    const { o, events } = make();
    o.command('git.mergeLocal', { agentId: 'a1' }, { ok: false, conflicts: ['src/x.ts'] });
    o.command('git.mergeLocal', { agentId: 'a1' }, { ok: true, conflicts: [], autoStash: { files: ['README.md'], restored: false, note: 'kept' } });
    o.command('agents.remove', { agentId: 'a1', deleteWorktree: true }, { ok: true });
    o.command(
      'git.openPr',
      { agentId: 'a1', title: 'Secret', body: '' },
      { url: 'https://github.com/acme/x/pull/1' },
    );
    o.command('agents.compact', { agentId: 'a1' }, { ok: true });
    expect(events).toEqual([
      { name: 'agent_merged', props: { result: 'conflicts', local_changes: 'none' } },
      { name: 'agent_merged', props: { result: 'merged', local_changes: 'stashed_kept' } },
      { name: 'agent_discarded', props: { worktree_deleted: true } },
      { name: 'pr_opened', props: { existing: false } },
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

  it('file_managed: the action only, never a path or name', () => {
    const { o, events } = make();
    o.command('files.create', { root: '/p', path: 'src/secret-plan.ts', kind: 'file' }, { ok: true });
    o.command('files.create', { root: '/p', path: 'docs', kind: 'dir' }, { ok: true });
    o.command('files.rename', { root: '/p', from: 'a.ts', to: 'b.ts' }, { ok: true });
    o.command('files.copy', { fromRoot: '/p', from: 'a.ts', toRoot: '/p', toDir: '', move: false }, { path: 'a copy.ts' });
    o.command('files.copy', { fromRoot: '/p', from: 'a.ts', toRoot: '/wt', toDir: 'src', move: true }, { path: 'src/a.ts' });
    o.command('files.delete', { root: '/p', path: 'b.ts' }, { ok: true });
    expect(events).toEqual([
      { name: 'file_managed', props: { action: 'create_file' } },
      { name: 'file_managed', props: { action: 'create_folder' } },
      { name: 'file_managed', props: { action: 'rename' } },
      { name: 'file_managed', props: { action: 'copy', crossCheckout: false } },
      { name: 'file_managed', props: { action: 'move', crossCheckout: true } },
      { name: 'file_managed', props: { action: 'delete' } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/secret-plan|a\.ts|src/);
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

describe('archived agents and the PR lifecycle', () => {
  const summary = (extra: Record<string, unknown>) => ({ id: 'a1', title: 'Secret ACME work', ...extra });
  const pr = (state: string) => ({ number: 12, url: 'https://github.com/acme/private/pull/12', state });

  it('agent_archived once per reason, with the reason only; unarchive and permanent delete', () => {
    const { o, events } = make();
    o.emitted(
      'agents.archived',
      summary({ archived: { at: 1, reason: 'completed', worktreeRemoved: false } }),
    );
    o.emitted(
      'agents.archived',
      summary({ archived: { at: 2, reason: 'completed', worktreeRemoved: true } }),
    );
    o.command('agents.unarchive', { agentId: 'a1' }, summary({}));
    o.emitted(
      'agents.archived',
      summary({ archived: { at: 3, reason: 'archived-by-user', worktreeRemoved: false } }),
    );
    o.command('agents.deletePermanently', { agentId: 'a1' }, { deleted: false });
    o.command('agents.deletePermanently', { agentId: 'a1' }, { deleted: true });
    expect(events).toEqual([
      { name: 'agent_archived', props: { reason: 'completed' } },
      { name: 'agent_unarchived', props: {} },
      { name: 'agent_archived', props: { reason: 'archived-by-user' } },
      { name: 'agent_deleted', props: {} },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ACME|Secret/);
  });

  it('agent_mode_changed: from and to modes only, right even when the summary changed before setMode returned', () => {
    const { o, events } = make();
    o.command('agents.setMode', { agentId: 'a1', mode: 'auto' }, { ok: true });
    o.emitted('agents.summary', { id: 'a1', mode: 'plan', title: 'Secret title' });
    o.emitted('agents.summary', { id: 'a1', mode: 'default' }); // the CLI left plan mode
    o.command('agents.setMode', { agentId: 'a1', mode: 'bypassPermissions' }, { ok: true });
    o.emitted('agents.summary', { id: 'a1', mode: 'bypassPermissions' });
    o.emitted('agents.summary', { id: 'a1', mode: 'bypassPermissions' });
    // The summary already says auto when the command returns: `from` is the mode before it.
    o.emitted('agents.summary', { id: 'a1', mode: 'auto' });
    o.command('agents.setMode', { agentId: 'a1', mode: 'auto' }, { ok: true });
    expect(events.filter((e) => e.name === 'agent_mode_changed').map((e) => e.props)).toEqual([
      { from: 'unknown', to: 'auto' },
      { from: 'default', to: 'bypassPermissions' },
      { from: 'bypassPermissions', to: 'auto' },
    ]);
  });

  it('pr_opened says whether the PR already existed; View PR is counted without its URL', () => {
    const { o, events } = make();
    o.command(
      'git.openPr',
      { agentId: 'a1', title: 't', body: '' },
      { url: 'https://github.com/acme/private/pull/12', number: 12, state: 'open', existing: true },
    );
    o.emitted('agents.summary', summary({ pr: pr('open') }));
    o.command('shell.openExternal', { url: 'https://github.com/acme/private/pull/12' }, { ok: true });
    o.command('shell.openExternal', { url: 'https://example.com/docs' }, { ok: true });
    expect(events).toEqual([
      { name: 'pr_opened', props: { existing: true } },
      { name: 'pr_view_opened', props: {} },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/acme|github/);
  });

  it('pr_opened says where a new PR title and body came from', () => {
    const { o, events } = make();
    o.command('git.openPr', { agentId: 'a1' }, { url: 'https://github.com/acme/private/pull/13', number: 13, state: 'open', existing: false, draft: 'template' });
    expect(events).toEqual([{ name: 'pr_opened', props: { existing: false, draft: 'template' } }]);
  });

  it('changes_reverted buckets the reverted files and says whether all were picked, never the paths', () => {
    const { o, events } = make();
    o.command('git.discard', { projectId: 'p1' }, { reverted: 1 });
    o.command('git.discard', { projectId: 'p1', files: ['secret/plan.md', 'b.ts', 'c.ts'] }, { reverted: 3 });
    expect(events).toEqual([
      { name: 'changes_reverted', props: { files: '1', all: true } },
      { name: 'changes_reverted', props: { files: '2-5', all: false } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/secret|plan|p1/);
  });

  it('pr_pushed buckets the commits sent to an open PR and says whether oIDE committed files first, never the URL', () => {
    const { o, events } = make();
    o.command('git.pushToPr', { agentId: 'a1' }, { url: 'https://github.com/acme/private/pull/13', number: 13, state: 'open', committed: true, pushed: 3 });
    o.command('git.pushToPr', { agentId: 'a1' }, { url: 'https://github.com/acme/private/pull/13', number: 13, state: 'open', committed: false, pushed: 0 });
    expect(events).toEqual([
      { name: 'pr_pushed', props: { commits: '2-5', committed: true } },
      { name: 'pr_pushed', props: { commits: '0', committed: false } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/acme|github/);
  });

  it('artifact_imported says how it came in, the kind and the format, never the link, title or content', () => {
    const { o, events } = make();
    const url = 'https://claude.ai/artifact/SecretId';
    o.command('artifacts.import', { url, content: '<p>Secret</p>', title: 'Secret' }, { kind: 'design', entry: 'index.html' });
    o.command('artifacts.import', { url, content: 'export default function Secret() {}' }, { kind: 'design', entry: 'App.jsx' });
    o.command('artifacts.import', { url, content: '<svg viewBox="0 0 1 1"></svg>' }, { kind: 'design', entry: 'index.html' });
    o.command('artifacts.import', { url, content: '  ' }, { kind: 'doc' });
    o.command('artifacts.import', { filePath: 'C:\\ACME\\x.md', url }, { kind: 'doc' });
    o.command('artifacts.import', { filePath: 'C:\\ACME\\b.excalidraw' }, { kind: 'whiteboard' });
    o.command('artifacts.import', { filePath: 'C:\\ACME\\logo.svg' }, { kind: 'design', entry: 'index.html' });
    o.command('artifacts.import', { url }, { kind: 'bogus' });
    expect(events).toEqual([
      { name: 'artifact_imported', props: { source: 'link_content', kind: 'design', linked: true, format: 'html' } },
      { name: 'artifact_imported', props: { source: 'link_content', kind: 'design', linked: true, format: 'react' } },
      { name: 'artifact_imported', props: { source: 'link_content', kind: 'design', linked: true, format: 'svg' } },
      { name: 'artifact_imported', props: { source: 'file', kind: 'doc', linked: true, format: 'markdown' } },
      { name: 'artifact_imported', props: { source: 'file', kind: 'whiteboard', linked: false, format: 'excalidraw' } },
      { name: 'artifact_imported', props: { source: 'file', kind: 'design', linked: false, format: 'svg' } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ACME|Secret|claude/);
  });

  it('artifact_import_refused gives the reason only, for imports refused before anything is created', () => {
    const { o, events } = make();
    o.commandFailed('artifacts.import', { code: 'invalid_input', issues: [{ path: '', code: 'custom' }] });
    o.commandFailed('artifacts.import', { code: 'invalid_input', issues: [{ path: 'url', code: 'invalid_format' }] });
    o.commandFailed('artifacts.import', { code: 'invalid_input', issues: [{ path: 'content', code: 'too_big' }] });
    o.commandFailed('artifacts.import', { code: 'invalid_input', reason: 'stub_content' });
    o.commandFailed('artifacts.import', { code: 'invalid_input', reason: 'wrong_kind' });
    o.commandFailed('artifacts.import', { code: 'forbidden_path' });
    o.commandFailed('artifacts.import', { code: 'invalid_input', reason: 'C:\\ACME\\secret' });
    o.commandFailed('artifacts.save', { code: 'conflict' });
    expect(events.map((e) => e.props.reason)).toEqual(['no_content', 'bad_link', 'too_large', 'stub_content', 'wrong_kind', 'other', 'other']);
    expect(events.every((e) => e.name === 'artifact_import_refused')).toBe(true);
  });

  it('project_added says how a project started, never its path, URL or name', () => {
    const { o, events } = make();
    const project = { id: 'p1', name: 'acme-secret', path: 'C:\\ACME\\acme-secret', trusted: false, createdAt: 1 };
    o.command('projects.open', { path: 'C:\\ACME\\acme-secret' }, project);
    o.command('projects.open', {}, null); // picker cancelled
    o.command('projects.initFolder', { path: 'C:\\ACME\\plain', commitFiles: true }, project);
    o.command('projects.create', { parent: 'C:\\ACME', name: 'acme-secret', readme: true }, project);
    o.command('projects.clone', { url: 'https://github.com/acme/secret.git', parent: 'C:\\ACME', name: 'secret', source: 'github' }, project);
    o.command('projects.clone', { url: 'git@github.com:acme/secret.git', parent: 'C:\\ACME', name: 'secret', source: 'url' }, project);
    o.command('projects.clone', { url: 'https://github.com/acme/secret.git', parent: 'C:\\ACME', name: 'secret', source: 'url' }, null); // cancelled
    expect(events).toEqual([
      { name: 'project_added', props: { method: 'open' } },
      { name: 'project_added', props: { method: 'init' } },
      { name: 'project_added', props: { method: 'create' } },
      { name: 'project_added', props: { method: 'clone', source: 'github' } },
      { name: 'project_added', props: { method: 'clone', source: 'url' } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ACME|acme|secret|github\.com/);
  });

  it('project_add_failed gives the method and a known reason only', () => {
    const { o, events } = make();
    o.commandFailed('projects.open', { code: 'not_a_repo', reason: 'not_a_repo' });
    o.commandFailed('projects.clone', { code: 'clone_failed', reason: 'auth' });
    o.commandFailed('projects.clone', { code: 'invalid_input', issues: [{ path: 'url', code: 'custom' }] });
    o.commandFailed('projects.create', { code: 'unavailable', reason: 'no_identity' });
    o.commandFailed('projects.initFolder', { code: 'forbidden_path', reason: 'forbidden_path' });
    o.commandFailed('projects.create', { code: 'internal', reason: 'C:\\ACME\\x' });
    expect(events).toEqual([
      { name: 'project_add_failed', props: { method: 'open', reason: 'not_a_repo' } },
      { name: 'project_add_failed', props: { method: 'clone', reason: 'auth' } },
      { name: 'project_add_failed', props: { method: 'clone', reason: 'other' } },
      { name: 'project_add_failed', props: { method: 'create', reason: 'no_identity' } },
      { name: 'project_add_failed', props: { method: 'init', reason: 'forbidden_path' } },
      { name: 'project_add_failed', props: { method: 'create', reason: 'other' } },
    ]);
  });

  it('artifact_imported for picked files and folders: source, kind, entry format and a file count only', () => {
    const { o, events } = make();
    o.command('artifacts.importFiles', { filePaths: ['C:\\ACME\\a.html', 'C:\\ACME\\b.png'], url: 'https://claude.ai/artifact/SecretId' }, { kind: 'design', entry: 'a.html', fileCount: 2, title: 'Secret' });
    o.command('artifacts.importFiles', { filePaths: [], folderPath: 'C:\\ACME\\site' }, { kind: 'design', entry: 'project/Main.jsx', fileCount: 30 });
    o.command('artifacts.importFiles', { filePaths: [], folderPath: 'C:\\ACME\\notes' }, { kind: 'doc', entry: 'notes/Secret.md', fileCount: 1 });
    o.command('artifacts.importFiles', { filePaths: ['C:\\ACME\\x'] }, { kind: 'bogus' });
    expect(events).toEqual([
      { name: 'artifact_imported', props: { source: 'files', kind: 'design', linked: true, format: 'html', files: '2-5' } },
      { name: 'artifact_imported', props: { source: 'folder', kind: 'design', linked: false, format: 'react', files: '21-100' } },
      { name: 'artifact_imported', props: { source: 'folder', kind: 'doc', linked: false, format: 'markdown', files: '1' } },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/ACME|Secret|claude|Main/);
  });

  it('artifact_import_refused covers file and link imports (bad paths, bad links)', () => {
    const { o, events } = make();
    o.commandFailed('artifacts.importFiles', { code: 'invalid_input', reason: 'bad_path' });
    o.commandFailed('artifacts.importFiles', { code: 'invalid_input', issues: [{ path: 'entry', code: 'custom' }] });
    o.commandFailed('artifacts.importFiles', { code: 'forbidden_path' });
    o.commandFailed('artifacts.importLink', { code: 'invalid_input', reason: 'bad_link' });
    o.commandFailed('artifacts.importLink', { code: 'invalid_input', issues: [{ path: 'url', code: 'invalid_format' }] });
    o.commandFailed('artifacts.refresh', { code: 'busy' });
    expect(events.map((e) => e.props.reason)).toEqual(['bad_path', 'bad_path', 'other', 'bad_link', 'bad_link']);
  });

  it('pr_checks_finished once per CI run, never on first sight; pr_checks_opened from the CI indicator', () => {
    const { o, events } = make();
    const checks = (state: string) => ({ ...pr('open'), checks: { state, total: 3, completed: state === 'pending' ? 1 : 3, failed: state === 'failure' ? 1 : 0 } });
    o.emitted('agents.summary', summary({ pr: checks('success') })); // first sight: not a transition
    o.emitted('agents.summary', summary({ pr: checks('pending') }));
    o.emitted('agents.summary', summary({ pr: checks('pending') }));
    o.emitted('agents.summary', summary({ pr: checks('failure') }));
    o.emitted('agents.summary', summary({ pr: checks('failure') }));
    o.emitted('agents.summary', summary({ pr: pr('open') })); // pushed: old checks dropped
    o.emitted('agents.summary', summary({ pr: checks('pending') }));
    o.emitted('agents.summary', summary({ pr: checks('success') }));
    o.command('shell.openExternal', { url: 'https://github.com/acme/private/pull/12/checks' }, { ok: true });
    o.command('shell.openExternal', { url: 'https://github.com/acme/other/pull/1/checks' }, { ok: true });
    expect(events).toEqual([
      { name: 'pr_checks_finished', props: { result: 'failure' } },
      { name: 'pr_checks_finished', props: { result: 'success' } },
      { name: 'pr_checks_opened', props: {} },
    ]);
    expect(JSON.stringify(events)).not.toMatch(/acme|github/);
  });

  it('pr_merged_detected when a known PR turns merged, once', () => {
    const { o, events } = make();
    o.emitted('agents.summary', summary({ pr: pr('merged') })); // first sight: not a transition
    o.emitted('agents.summary', { ...summary({ pr: pr('open') }), id: 'a2' });
    o.emitted('agents.summary', { ...summary({ pr: pr('merged') }), id: 'a2' });
    o.emitted('agents.archived', {
      ...summary({ pr: pr('merged'), archived: { at: 1, reason: 'merged', worktreeRemoved: false } }),
      id: 'a2',
    });
    expect(events).toEqual([
      { name: 'pr_merged_detected', props: {} },
      { name: 'agent_archived', props: { reason: 'merged' } },
    ]);
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
