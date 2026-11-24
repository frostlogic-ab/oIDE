import { describe, expect, it } from 'vitest';
import { AgentSpec, CliInfo, Technique } from '@oide/protocol';
import { allowListEnv, buildLaunch, filterExtraFlags, LaunchError, shellSplit, type LaunchContext } from './args.js';
import { testSettings } from '../test/helpers.js';

const cli = CliInfo.parse({ found: true, path: 'C:\\bin\\claude.exe', version: '2.1.325', inTestedRange: true, features: { effort: true, 'mode:auto': true, agents: true, 'permission-prompt-tool': true, 'include-partial-messages': true, 'forward-subagent-text': true } });

const spec = (patch: Partial<AgentSpec> = {}) =>
  AgentSpec.parse({ projectId: 'p1', title: 'Fix login', goal: 'Fix the login bug.', strategy: { kind: 'single', lead: { model: 'opus', effort: 'high' } }, ...patch });

const techniques = [
  Technique.parse({ id: 't-sys', name: 'Be terse', text: 'Be terse.', placement: 'system-prompt' }),
  Technique.parse({ id: 't-first', name: 'TDD', text: 'Write a failing test first.', placement: 'first-message' }),
  Technique.parse({ id: 't-first2', name: 'Plan', text: 'Start with a plan.', placement: 'first-message' }),
];

const ctx = (patch: Partial<LaunchContext> = {}): LaunchContext => ({
  agentId: 'agt-1',
  sessionId: '11111111-2222-4333-8444-555555555555',
  cwd: '/w/agt-1',
  branch: 'oide/fix-login',
  cli,
  settings: testSettings(),
  techniques,
  mcpConfigPath: '/app/agents/agt-1/mcp.json',
  baseEnv: { PATH: '/usr/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', LC_ALL: 'C', HTTPS_PROXY: 'http://proxy', ANTHROPIC_API_KEY: 'sk-secret', GITHUB_TOKEN: 'gh-secret', AWS_SECRET_ACCESS_KEY: 'x', Path: 'C:\\Windows' },
  trusted: true,
  ...patch,
});

const flagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('buildLaunch', () => {
  it('builds the verified stream-json command line', () => {
    const p = buildLaunch(spec(), ctx());
    expect(p.command).toBe('C:\\bin\\claude.exe');
    expect(p.args.slice(0, 6)).toEqual(['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json']);
    expect(p.args).toContain('--include-partial-messages');
    expect(p.args).toContain('--forward-subagent-text');
    expect(flagValue(p.args, '--session-id')).toBe('11111111-2222-4333-8444-555555555555');
    expect(p.args).not.toContain('--resume');
    expect(flagValue(p.args, '--model')).toBe('opus');
    expect(flagValue(p.args, '--effort')).toBe('high');
    expect(flagValue(p.args, '--permission-mode')).toBe('auto');
    expect(flagValue(p.args, '--mcp-config')).toBe('/app/agents/agt-1/mcp.json');
    expect(flagValue(p.args, '--permission-prompt-tool')).toBe('mcp__oide__permission_prompt');
    expect(p.args).not.toContain('--agents');
  });

  it('resume uses --resume and sends no first message', () => {
    const p = buildLaunch(spec(), ctx({ resume: true }));
    expect(flagValue(p.args, '--resume')).toBe('11111111-2222-4333-8444-555555555555');
    expect(p.args).not.toContain('--session-id');
    expect(p.firstMessage).toBeNull();
  });

  it('maps modes and refuses bypass unless allowed and in a worktree', () => {
    expect(flagValue(buildLaunch(spec({ mode: 'default' }), ctx()).args, '--permission-mode')).toBe('default');
    expect(flagValue(buildLaunch(spec({ mode: 'plan' }), ctx()).args, '--permission-mode')).toBe('plan');
    const noAuto = CliInfo.parse({ ...cli, features: { ...cli.features, 'mode:auto': false } });
    const p = buildLaunch(spec({ mode: 'auto' }), ctx({ cli: noAuto }));
    expect(flagValue(p.args, '--permission-mode')).toBe('default');
    expect(p.warnings.join()).toMatch(/auto/);
    expect(() => buildLaunch(spec({ mode: 'bypassPermissions' }), ctx())).toThrow(LaunchError);
    const allowed = ctx({ settings: testSettings({ allowBypass: true }) });
    expect(flagValue(buildLaunch(spec({ mode: 'bypassPermissions' }), allowed).args, '--permission-mode')).toBe('bypassPermissions');
    expect(() => buildLaunch(spec({ mode: 'bypassPermissions', workIn: 'project-folder' }), allowed)).toThrow(/worktree/);
  });

  it('hides effort when the CLI lacks it', () => {
    const p = buildLaunch(spec(), ctx({ cli: CliInfo.parse({ ...cli, features: { ...cli.features, effort: false } }) }));
    expect(p.args).not.toContain('--effort');
    expect(p.warnings.join()).toMatch(/effort/);
  });

  it('applies techniques in Settings order: first-message after the goal, system-prompt after the contract', () => {
    const p = buildLaunch(spec({ techniques: ['t-first2', 't-sys', 't-first'] }), ctx());
    const content = p.firstMessage!.message.content as Array<{ text: string }>;
    expect(content[0]!.text).toBe('Fix the login bug.\n\nWrite a failing test first.\n\nStart with a plan.');
    expect(p.appendSystemPrompt).toMatch(/mcp__oide__submit_for_review/);
    expect(p.appendSystemPrompt).toMatch(/Oide-Agent: Fix login/);
    expect(p.appendSystemPrompt.trim().endsWith('Be terse.')).toBe(true);
    expect(flagValue(p.args, '--append-system-prompt')).toBe(p.appendSystemPrompt);
  });

  it('adds context chips to the first message, artifacts by MCP id and path', () => {
    const p = buildLaunch(
      spec({ context: [{ kind: 'artifact', id: 'art-1', title: 'Login design' }, { kind: 'file', path: 'src/login.ts' }, { kind: 'url', url: 'https://example.com/spec' }] }),
      ctx({ resolveArtifact: (id) => ({ id, path: '/repo/.oide/artifacts/login/index.html' }) }),
    );
    const text = (p.firstMessage!.message.content as Array<{ text: string }>)[0]!.text;
    expect(text).toMatch(/mcp__oide__artifacts_read.*"art-1"/);
    expect(text).toMatch(/\/repo\/\.oide\/artifacts\/login\/index\.html/);
    expect(text).toMatch(/File: src\/login\.ts/);
    expect(text).toMatch(/URL: https:\/\/example\.com\/spec/);
  });

  it('routed strategy defines simple/standard/complex subagents with their models', () => {
    const p = buildLaunch(
      spec({ strategy: { kind: 'routed', lead: { model: 'opus' }, simple: { model: 'haiku', effort: 'low' }, standard: { model: 'sonnet' }, complex: { model: 'opus', effort: 'max' } } }),
      ctx(),
    );
    const agents = JSON.parse(flagValue(p.args, '--agents')!);
    expect(Object.keys(agents)).toEqual(['simple-task', 'standard-task', 'complex-task']);
    expect(agents['simple-task']).toMatchObject({ model: 'haiku', effort: 'low' });
    expect(agents['complex-task'].model).toBe('opus');
    expect(p.agentsJson).toBe(flagValue(p.args, '--agents'));
    expect(p.appendSystemPrompt).toMatch(/simple-task/);
  });

  it('subagent-model strategy sets the subagent model env var', () => {
    const p = buildLaunch(spec({ strategy: { kind: 'subagent-model', lead: { model: 'opus' }, subagents: { model: 'haiku' } } }), ctx());
    expect(p.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('haiku');
  });

  it('builds env from an allow-list only, plus custom model variables from the passed-in secret', () => {
    const p = buildLaunch(spec({ customModel: { id: 'cm1' } }), ctx({ customModel: { id: 'cm1', name: 'Local', provider: 'compatible-api', baseUrl: 'http://127.0.0.1:8080', model: 'qwen-coder', hasKey: true, extraEnv: { FOO_BAR: '1' } }, customModelSecret: 'k-123' }));
    expect(p.env.PATH).toBe('/usr/bin');
    expect(p.env.Path).toBe('C:\\Windows');
    expect(p.env.LC_ALL).toBe('C');
    expect(p.env.HTTPS_PROXY).toBe('http://proxy');
    expect(p.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(p.env.GITHUB_TOKEN).toBeUndefined();
    expect(p.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(p.env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080', ANTHROPIC_MODEL: 'qwen-coder', ANTHROPIC_AUTH_TOKEN: 'k-123', FOO_BAR: '1', OIDE_AGENT_ID: 'agt-1' });
    expect(flagValue(p.args, '--model')).toBe('qwen-coder');
    const b = buildLaunch(spec(), ctx({ customModel: { id: 'b', name: 'Bedrock', provider: 'bedrock', model: 'anthropic.claude', hasKey: false, extraEnv: {} } }));
    expect(b.env.CLAUDE_CODE_USE_BEDROCK).toBe('1');
    const v = buildLaunch(spec(), ctx({ customModel: { id: 'v', name: 'Vertex', provider: 'vertex', model: 'claude', hasKey: false, extraEnv: {} } }));
    expect(v.env.CLAUDE_CODE_USE_VERTEX).toBe('1');
  });

  it('allowed / disallowed tools from project rules, settings and extension risk labels', () => {
    const settings = testSettings();
    settings.permissions.alwaysAllowed = ['Bash(npm test)'];
    settings.permissions.alwaysDenied = ['Bash(rm -rf *)'];
    const base = ctx({
      settings,
      projectRules: { allow: ['Bash(git status)', 'mcp__gh__create_pr'], ask: [], deny: ['WebFetch'] },
      extensionTools: [
        { server: 'gh', tool: 'list_prs', risk: 'read', enabled: true },
        { server: 'gh', tool: 'create_pr', risk: 'ask', enabled: true },
        { server: 'gh', tool: 'delete_repo', risk: 'ask', enabled: false },
      ],
    });
    const p = buildLaunch(spec(), base);
    const allow = flagValue(p.args, '--allowedTools')!.split(',');
    expect(allow).toEqual(expect.arrayContaining(['Bash(git status)', 'Bash(npm test)', 'mcp__gh__list_prs', 'mcp__oide__submit_for_review']));
    expect(allow).not.toContain('mcp__gh__create_pr'); // "asks first" tools are never pre-allowed
    const deny = flagValue(p.args, '--disallowedTools')!.split(',');
    expect(deny).toEqual(expect.arrayContaining(['WebFetch', 'Bash(rm -rf *)', 'mcp__gh__delete_repo']));
    const untrusted = buildLaunch(spec(), { ...base, trusted: false });
    expect(flagValue(untrusted.args, '--allowedTools')).not.toMatch(/git status/);
    expect(flagValue(untrusted.args, '--disallowedTools')).toMatch(/WebFetch/);
  });

  it('extra CLI flags are shell-split safely and cannot override protocol flags', () => {
    const settings = testSettings({ extraFlags: `--add-dir "C:\\My Docs" --fallback-model 'sonnet' --output-format text --dangerously-skip-permissions --model=opus $HOME` });
    const p = buildLaunch(spec(), ctx({ settings }));
    expect(p.args.slice(-5)).toEqual(['--add-dir', 'C:\\My Docs', '--fallback-model', 'sonnet', '$HOME']);
    expect(p.args.filter((a) => a === '--output-format')).toHaveLength(1);
    expect(p.args).not.toContain('--dangerously-skip-permissions');
    expect(p.warnings.length).toBe(3);
    const bad = buildLaunch(spec(), ctx({ settings: testSettings({ extraFlags: '--add-dir "unterminated' }) }));
    expect(bad.warnings.join()).toMatch(/Unterminated/);
  });

  it('runs .mjs CLIs (fake-claude) through node', () => {
    const p = buildLaunch(spec(), ctx({ cli: CliInfo.parse({ ...cli, path: '/repo/tools/fake-claude/bin/fake-claude.mjs' }) }));
    expect(p.command).toBe(process.execPath);
    expect(p.args[0]).toBe('/repo/tools/fake-claude/bin/fake-claude.mjs');
  });
});

describe('helpers', () => {
  it('shellSplit handles quotes and escapes without expansion', () => {
    expect(shellSplit(`a "b c" 'd e' f\\ g "h\\"i" $X`)).toEqual(['a', 'b c', 'd e', 'f g', 'h"i', '$X']);
    expect(() => shellSplit('"open')).toThrow();
  });
  it('filterExtraFlags drops reserved flags with their values', () => {
    const w: string[] = [];
    expect(filterExtraFlags('--session-id abc --verbose --resume xyz --add-dir d', w)).toEqual(['--verbose', '--add-dir', 'd']);
    expect(w).toHaveLength(2);
  });
  it('allowListEnv never copies unknown keys', () => {
    expect(allowListEnv({ PATH: 'p', SECRET: 's', lc_ctype: 'x', https_proxy: 'h' })).toEqual({ PATH: 'p', lc_ctype: 'x', https_proxy: 'h' });
  });
});
