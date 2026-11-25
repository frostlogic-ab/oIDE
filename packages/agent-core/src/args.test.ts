import { describe, expect, it } from 'vitest';
import { AgentSpec, CliInfo, Technique } from '@oide/protocol';
import { allowListEnv, askRuleCovers, buildLaunch, editStaysInside, requestTargetsProtectedPath, customModelEnv, disallowedModelEnvKeys, filterExtraFlags, isAllowedModelEnvEntry, isAllowedModelEnvKey, LaunchError, shellSplit, type LaunchContext } from './args.js';
import { linkSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir, testSettings } from '../test/helpers.js';

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

  it('adds --allow-dangerously-skip-permissions only where bypass is allowed, so the mode can switch to bypass live', () => {
    const FLAG = '--allow-dangerously-skip-permissions';
    const withFlag = CliInfo.parse({ ...cli, features: { ...cli.features, 'allow-dangerously-skip-permissions': true } });
    expect(buildLaunch(spec({ mode: 'plan' }), ctx({ cli: withFlag })).args).not.toContain(FLAG);
    const allowed = ctx({ cli: withFlag, settings: testSettings({ allowBypass: true }) });
    expect(buildLaunch(spec({ mode: 'plan' }), allowed).args).toContain(FLAG);
    expect(buildLaunch(spec({ mode: 'plan', workIn: 'project-folder' }), allowed).args).not.toContain(FLAG);
    // Launched in bypass, the CLI can come back to bypass on its own.
    expect(buildLaunch(spec({ mode: 'bypassPermissions' }), allowed).args).not.toContain(FLAG);
    const noFlag = CliInfo.parse({ ...cli, features: { ...cli.features, 'allow-dangerously-skip-permissions': false } });
    expect(buildLaunch(spec({ mode: 'plan' }), ctx({ cli: noFlag, settings: testSettings({ allowBypass: true }) })).args).not.toContain(FLAG);
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
    const p = buildLaunch(spec({ customModel: { id: 'cm1' } }), ctx({ customModel: { id: 'cm1', name: 'Local', provider: 'compatible-api', baseUrl: 'http://127.0.0.1:8080', model: 'qwen-coder', hasKey: true, extraEnv: { MAX_THINKING_TOKENS: '1' } }, customModelSecret: 'k-123' }));
    expect(p.env.PATH).toBe('/usr/bin');
    expect(p.env.Path).toBe('C:\\Windows');
    expect(p.env.LC_ALL).toBe('C');
    expect(p.env.HTTPS_PROXY).toBe('http://proxy');
    expect(p.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(p.env.GITHUB_TOKEN).toBeUndefined();
    expect(p.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(p.env).toMatchObject({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080', ANTHROPIC_MODEL: 'qwen-coder', ANTHROPIC_AUTH_TOKEN: 'k-123', MAX_THINKING_TOKENS: '1', OIDE_AGENT_ID: 'agt-1' });
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
    const settings = testSettings({ extraFlags: `--fallback-model 'sonnet' --name "My Docs" --output-format text --dangerously-skip-permissions --model=opus $HOME` });
    const p = buildLaunch(spec(), ctx({ settings }));
    expect(p.args.slice(-5)).toEqual(['--fallback-model', 'sonnet', '--name', 'My Docs', '$HOME']);
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
    expect(filterExtraFlags('--session-id abc --verbose --resume xyz --name d', w)).toEqual(['--verbose', '--name', 'd']);
    expect(w).toHaveLength(2);
  });
  it('SEC-27: flags that would undo isolation are reserved, with all their values', () => {
    const w: string[] = [];
    const raw =
      '--settings {"hooks":{}} --setting-sources user,project,local --strict-mcp-config --mcp-config a.json b.json --add-dir C:/ D:/ ' +
      '--plugin-dir p --plugin-url https://x --tools Bash Edit --allowed-tools Bash --disallowedTools X --permission-mode bypassPermissions ' +
      '--permission-prompt-tool none --dangerously-skip-permissions --allow-dangerously-skip-permissions --safe-mode --Add_Dir E:/ --verbose';
    expect(filterExtraFlags(raw, w)).toEqual(['--verbose']);
    expect(w.length).toBe(16);
  });
  it('SEC-02: untrusted projects get --setting-sources user and --strict-mcp-config; trusted ones do not', () => {
    const u = buildLaunch(spec(), ctx({ trusted: false }));
    expect(flagValue(u.args, '--setting-sources')).toBe('user');
    expect(u.args).toContain('--strict-mcp-config');
    expect(flagValue(u.args, '--mcp-config')).toBe('/app/agents/agt-1/mcp.json'); // oIDE's own server + allowed extension servers
    const t = buildLaunch(spec(), ctx({ trusted: true }));
    expect(t.args).not.toContain('--strict-mcp-config');
    // Extra flags cannot add project settings back.
    const back = buildLaunch(spec(), ctx({ trusted: false, settings: testSettings({ extraFlags: '--setting-sources user,project --settings x.json' }) }));
    expect(back.args.filter((a) => a === '--setting-sources')).toHaveLength(1);
    expect(back.args.filter((a) => a === '--settings')).toHaveLength(1);
    // A CLI known to lack the flags refuses to start an untrusted agent.
    const old = CliInfo.parse({ ...cli, features: { ...cli.features, 'setting-sources': false } });
    expect(() => buildLaunch(spec(), ctx({ trusted: false, cli: old }))).toThrow(LaunchError);
  });
  it('SEC-12: edits to .oide/, .claude/ and .mcp.json always ask and are never pre-allowed', () => {
    const settings = testSettings();
    settings.permissions.alwaysAllowed = ['Edit(.oide/permissions.json)', 'Write(**/.claude/**)', 'Edit(src/**)'];
    const p = buildLaunch(spec(), ctx({ settings }));
    const extra = JSON.parse(flagValue(p.args, '--settings')!) as { permissions: { ask: string[] } };
    expect(extra.permissions.ask).toEqual(expect.arrayContaining(['Edit(**/.oide/**)', 'Write(**/.claude/**)', 'Edit(**/.mcp.json)', 'MultiEdit(**/.oide/**)']));
    const allow = flagValue(p.args, '--allowedTools')!.split(',');
    expect(allow).toContain('Edit(src/**)');
    expect(allow).not.toContain('Edit(.oide/permissions.json)');
    expect(allow).not.toContain('Write(**/.claude/**)');
  });
  it('SEC-01: the agent env makes Windows skip the cwd when the CLI spawns git/node', () => {
    expect(buildLaunch(spec(), ctx({ platform: 'win32' })).env.NoDefaultCurrentDirectoryInExePath).toBe('1');
  });
  it('SEC-28: a custom model env may set only allow-listed model and provider names', () => {
    const rejected = [
      // loaders, runtimes, shells, pagers, terminal
      'NODE_OPTIONS', 'node_options', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'ELECTRON_RUN_AS_NODE', 'PYTHONPATH', 'PERL5OPT', 'LUA_INIT', 'LUA_PATH', 'GCONV_PATH', 'BASH_ENV', 'IFS', 'PS4', 'COMSPEC', 'LESSOPEN', 'LESSCLOSE', 'LESS', 'MANPAGER', 'PAGER', 'EDITOR', 'TERMINFO',
      // program lookup, case tricks
      'PATH', 'Path', 'PATHEXT', 'NoDefaultCurrentDirectoryInExePath', 'aws_region', 'Aws_Profile',
      // traffic, TLS, credentials files
      'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'AWS_ENDPOINT_URL_BEDROCK_RUNTIME', 'AWS_CA_BUNDLE', 'AWS_CONFIG_FILE', 'GOOGLE_APPLICATION_CREDENTIALS', 'GIT_SSH_COMMAND',
      // what oIDE and Claude Code control
      'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_CUSTOM_HEADERS', 'ANTHROPIC_BEDROCK_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_GIT_BASH_PATH', 'CLAUDE_CODE_SHELL_PREFIX', 'CLAUDE_CONFIG_DIR', 'OIDE_AGENT_ID', 'OIDE_MCP_HANDSHAKE',
      // anything else
      'FOO_BAR', 'VERTEX_REGION_', 'bad-name', '',
    ];
    for (const k of rejected) expect(isAllowedModelEnvKey(k), k).toBe(false);
    const allowed = ['AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_PROFILE', 'ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION', 'CLOUD_ML_REGION', 'ANTHROPIC_VERTEX_PROJECT_ID', 'VERTEX_REGION_CLAUDE_3_5_HAIKU', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_MAX_OUTPUT_TOKENS', 'MAX_THINKING_TOKENS', 'DISABLE_PROMPT_CACHING'];
    for (const k of allowed) expect(isAllowedModelEnvKey(k), k).toBe(true);
    expect(disallowedModelEnvKeys({ AWS_REGION: 'x', NODE_OPTIONS: 'y', LESSOPEN: 'z' })).toEqual(['NODE_OPTIONS', 'LESSOPEN']);
    const warnings: string[] = [];
    const env = customModelEnv({ id: 'm', name: 'M', provider: 'bedrock', model: 'x', hasKey: false, extraEnv: { AWS_REGION: 'eu-west-1', NODE_OPTIONS: '--require x', https_proxy: 'http://evil', ANTHROPIC_BEDROCK_BASE_URL: 'https://evil', CLAUDE_CODE_USE_BEDROCK: '0' } }, undefined, warnings);
    expect(env).toEqual({ AWS_REGION: 'eu-west-1', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'x' });
    expect(warnings[0]).toMatch(/NODE_OPTIONS, https_proxy, ANTHROPIC_BEDROCK_BASE_URL, CLAUDE_CODE_USE_BEDROCK/);
    // oIDE's own fields always win: extraEnv cannot re-point the base URL, model or token.
    const own = customModelEnv({ id: 'm', name: 'M', provider: 'local', baseUrl: 'http://127.0.0.1:1', model: 'q', hasKey: true, extraEnv: { ANTHROPIC_BASE_URL: 'https://evil', ANTHROPIC_MODEL: 'z', ANTHROPIC_AUTH_TOKEN: 't' } }, 'k');
    expect(own).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', ANTHROPIC_MODEL: 'q', ANTHROPIC_AUTH_TOKEN: 'k' });
    // buildLaunch: a stored model with a refused name (e.g. from before SEC-28) still cannot set it.
    const p = buildLaunch(spec({ customModel: { id: 'cm1' } }), ctx({ baseEnv: { PATH: '/usr/bin' }, customModel: { id: 'cm1', name: 'L', provider: 'local', baseUrl: 'http://127.0.0.1:1', model: 'q', hasKey: false, extraEnv: { PATH: '/evil', NODE_OPTIONS: '--require x' } } }));
    expect(p.env.PATH).toBe('/usr/bin');
    expect(p.env.NODE_OPTIONS).toBeUndefined();
    expect(p.warnings.join(' | ')).toMatch(/PATH, NODE_OPTIONS/);
    // The agent's subagent-model strategy wins over the model's CLAUDE_CODE_SUBAGENT_MODEL.
    const sub = buildLaunch(spec({ customModel: { id: 'cm1' }, strategy: { kind: 'subagent-model', lead: { model: 'opus' }, subagents: { model: 'haiku' } } }), ctx({ customModel: { id: 'cm1', name: 'L', provider: 'bedrock', model: 'q', hasKey: false, extraEnv: { CLAUDE_CODE_SUBAGENT_MODEL: 'other' } } }));
    expect(sub.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('haiku');
  });
  it('SEC-28: allowed names must also have well-formed values', () => {
    const ok: Array<[string, string]> = [
      ['AWS_REGION', 'eu-west-1'], ['AWS_DEFAULT_REGION', 'us-east-1'], ['ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION', 'us-west-2'], ['CLOUD_ML_REGION', 'global'], ['CLOUD_ML_REGION', 'europe-west4'], ['VERTEX_REGION_CLAUDE_3_5_HAIKU', 'us-east5'],
      ['ANTHROPIC_VERTEX_PROJECT_ID', 'my-project-123'], ['ANTHROPIC_VERTEX_PROJECT_ID', 'abcdef'],
      ['AWS_PROFILE', 'work'], ['AWS_PROFILE', 'team.dev+ops=1,a@b_c-d'],
      ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', '32000'], ['MAX_THINKING_TOKENS', '0'], ['MAX_THINKING_TOKENS', '1000000'],
      ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'claude-sonnet-4-5'], ['ANTHROPIC_SMALL_FAST_MODEL', 'us.anthropic.claude-3-5-haiku-20241022-v1:0'], ['CLAUDE_CODE_SUBAGENT_MODEL', 'claude-opus-4[1m]'], ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'claude-opus-4-20250514'],
      ['DISABLE_PROMPT_CACHING', '1'], ['DISABLE_PROMPT_CACHING', 'false'],
    ];
    for (const [k, v] of ok) expect(isAllowedModelEnvEntry(k, v), `${k}=${v}`).toBe(true);
    const bad: Array<[string, unknown]> = [
      // regions that could become a hostname
      ['AWS_REGION', 'evil.example.com/'], ['AWS_REGION', 'eu-west-1.evil.com'], ['AWS_REGION', 'EU-WEST-1'], ['AWS_REGION', ''], ['AWS_REGION', '-eu'], ['AWS_REGION', 'eu--west'], ['CLOUD_ML_REGION', 'us-east5/../x'], ['VERTEX_REGION_CLAUDE_3_5_HAIKU', 'x:443'], ['AWS_DEFAULT_REGION', 'a'.repeat(65)],
      // project ids
      ['ANTHROPIC_VERTEX_PROJECT_ID', 'abc'], ['ANTHROPIC_VERTEX_PROJECT_ID', '1project'], ['ANTHROPIC_VERTEX_PROJECT_ID', 'my-project-'], ['ANTHROPIC_VERTEX_PROJECT_ID', 'evil.com/x'], ['ANTHROPIC_VERTEX_PROJECT_ID', 'a'.repeat(31)],
      // profiles
      ['AWS_PROFILE', 'a/b'], ['AWS_PROFILE', 'a:b'], ['AWS_PROFILE', 'a b'], ['AWS_PROFILE', ''], ['AWS_PROFILE', 'p'.repeat(65)],
      // token counts
      ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', '-1'], ['CLAUDE_CODE_MAX_OUTPUT_TOKENS', '1e9'], ['MAX_THINKING_TOKENS', '1000001'], ['MAX_THINKING_TOKENS', '12 '], ['MAX_THINKING_TOKENS', ''],
      // model names
      ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'a/b'], ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'x@evil.com'], ['ANTHROPIC_SMALL_FAST_MODEL', 'm?x=1'], ['CLAUDE_CODE_SUBAGENT_MODEL', 'm#f'], ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'a b'], ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'm'.repeat(129)], ['ANTHROPIC_DEFAULT_OPUS_MODEL', ''],
      // switches, types
      ['DISABLE_PROMPT_CACHING', 'yes'], ['AWS_REGION', 1], ['AWS_REGION', undefined],
      // names outside the list never pass, whatever the value
      ['NODE_OPTIONS', 'eu-west-1'], ['constructor', 'x'], ['__proto__', 'x'],
    ];
    for (const [k, v] of bad) expect(isAllowedModelEnvEntry(k, v), `${k}=${String(v)}`).toBe(false);
    expect(disallowedModelEnvKeys({ AWS_REGION: 'evil.example.com/', AWS_PROFILE: 'work' })).toEqual(['AWS_REGION']);
    const warnings: string[] = [];
    expect(customModelEnv({ id: 'm', name: 'M', provider: 'bedrock', model: 'x', hasKey: false, extraEnv: { AWS_REGION: 'evil.example.com/', AWS_PROFILE: 'work' } }, undefined, warnings)).toEqual({ AWS_PROFILE: 'work', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_MODEL: 'x' });
    expect(warnings[0]).toMatch(/AWS_REGION/);
  });
  it('allowListEnv never copies unknown keys', () => {
    expect(allowListEnv({ PATH: 'p', SECRET: 's', lc_ctype: 'x', https_proxy: 'h' })).toEqual({ PATH: 'p', lc_ctype: 'x', https_proxy: 'h' });
  });
});

describe('"Always" guards', () => {
  it('requestTargetsProtectedPath: edits of .oide/, .claude/ and .mcp.json (or with no path) are protected', () => {
    expect(requestTargetsProtectedPath('Edit', { file_path: 'C:\\repo\\.oide\\permissions.json' })).toBe(true);
    expect(requestTargetsProtectedPath('Write', { file_path: '/repo/.claude/settings.json' })).toBe(true);
    expect(requestTargetsProtectedPath('Edit', { file_path: '/repo/.mcp.json' })).toBe(true);
    expect(requestTargetsProtectedPath('NotebookEdit', { notebook_path: '/repo/.oide/x.ipynb' })).toBe(true);
    expect(requestTargetsProtectedPath('Edit', {})).toBe(true);
    expect(requestTargetsProtectedPath('Edit', { file_path: '/repo/src/oide.ts' })).toBe(false);
    expect(requestTargetsProtectedPath('Bash', { command: 'cat .oide/setup' })).toBe(false);
  });

  it('requestTargetsProtectedPath fails closed on names Windows folds onto .oide, .claude or .mcp.json', () => {
    const r = String.raw;
    for (const file_path of [r`C:\repo\.OIDE\setup`, r`C:\repo\.oide.\setup`, r`C:\repo\.oide \setup`, r`C:\repo\.oide::$INDEX_ALLOCATION\setup`, r`C:\repo\OIDE~1\setup`, '/repo/.mcp.json.', r`C:\repo\.mcp.json:x`]) {
      expect(requestTargetsProtectedPath('Write', { file_path }), file_path).toBe(true);
    }
    expect(requestTargetsProtectedPath('Write', { file_path: r`C:\repo\src\a.ts` })).toBe(false);
  });

  it('editStaysInside: edits must resolve inside the worktree (.., absolute, UNC and symlinks out are refused)', () => {
    const root = tempDir('oide-root-');
    const outside = tempDir('oide-out-');
    mkdirSync(join(root, 'src'));
    expect(editStaysInside('Edit', { file_path: join(root, 'src', 'a.ts') }, root)).toBe(true);
    expect(editStaysInside('Write', { file_path: 'src/new/b.ts' }, root)).toBe(true);
    expect(editStaysInside('Edit', { file_path: '../x.ts' }, root)).toBe(false);
    expect(editStaysInside('Edit', { file_path: join(outside, 'x.ts') }, root)).toBe(false);
    expect(editStaysInside('Edit', { file_path: String.raw`\\server\share\x.ts` }, root)).toBe(false);
    expect(editStaysInside('Edit', {}, root)).toBe(false);
    expect(editStaysInside('Edit', { file_path: 'a.ts' }, undefined)).toBe(false);
    expect(editStaysInside('Bash', { command: 'rm x' }, root)).toBe(true);
    let linked = false;
    try {
      symlinkSync(outside, join(root, 'link'), 'junction');
      linked = true;
    } catch {
      /* no symlink rights */
    }
    if (linked) expect(editStaysInside('Write', { file_path: join(root, 'link', 'x.ts') }, root)).toBe(false);
  });

  it('editStaysInside: a link inside the worktree that points at .oide/ is refused', () => {
    const root = tempDir('oide-root-');
    mkdirSync(join(root, '.oide'));
    mkdirSync(join(root, 'src'));
    try {
      symlinkSync(join(root, '.oide'), join(root, 'src', 'cfg'), 'junction');
    } catch {
      return; // no symlink rights on this machine
    }
    // The literal path looks harmless; its real path is .oide/permissions.json.
    expect(requestTargetsProtectedPath('Write', { file_path: join(root, 'src', 'cfg', 'permissions.json') })).toBe(false);
    expect(editStaysInside('Write', { file_path: join(root, 'src', 'cfg', 'permissions.json') }, root)).toBe(false);
    expect(editStaysInside('Write', { file_path: join(root, '.claude', 'settings.json') }, root)).toBe(false);
    expect(editStaysInside('Write', { file_path: join(root, 'src', 'a.ts') }, root)).toBe(true);
    expect(editStaysInside('Write', { file_path: root }, root)).toBe(false);
  });

  it('editStaysInside: dangling links and hard-linked files fail closed', () => {
    const root = tempDir('oide-root-');
    mkdirSync(join(root, '.oide'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, '.oide', 'permissions.json'), '{}');
    // Hard links need no special rights.
    linkSync(join(root, '.oide', 'permissions.json'), join(root, 'src', 'h.json'));
    expect(editStaysInside('Write', { file_path: join(root, 'src', 'h.json') }, root)).toBe(false);
    let dangling = false;
    try {
      symlinkSync(join(root, '.oide', 'missing'), join(root, 'src', 'd'), 'junction');
      dangling = true;
    } catch {
      /* no symlink rights on this machine */
    }
    if (dangling) expect(editStaysInside('Write', { file_path: join(root, 'src', 'd', 'setup') }, root)).toBe(false);
    expect(editStaysInside('Write', { file_path: join(root, 'src', 'new', 'deep', 'x.ts') }, root)).toBe(true);
  });

  it('askRuleCovers: whole tools, MCP servers, Bash prefixes, and any other specifier on the same tool', () => {
    expect(askRuleCovers('Bash', 'Bash', { command: 'ls' })).toBe(true);
    expect(askRuleCovers('Bash(git push:*)', 'Bash', { command: 'git push origin main' })).toBe(true);
    expect(askRuleCovers('Bash(git push:*)', 'Bash', { command: 'npm test' })).toBe(false);
    expect(askRuleCovers('Bash(git push:*)', 'Edit', { file_path: 'a' })).toBe(false);
    expect(askRuleCovers('Edit(src/**)', 'Edit', { file_path: 'docs/a.md' })).toBe(true);
    expect(askRuleCovers('mcp__db', 'mcp__db__query', {})).toBe(true);
    expect(askRuleCovers('mcp__db__query', 'mcp__db__query', {})).toBe(true);
    expect(askRuleCovers('mcp__db__query', 'mcp__db__schema', {})).toBe(false);
    expect(askRuleCovers('mcp__db', 'mcp__dbx__query', {})).toBe(false);
  });

  it('buildLaunch reports the always-ask rules', () => {
    const plan = buildLaunch(spec(), ctx({ projectRules: { allow: [], ask: ['Bash(git push:*)'], deny: [] } }));
    expect(plan.askRules).toEqual(['Bash(git push:*)']);
  });
});
