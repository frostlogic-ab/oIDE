import { describe, expect, it } from 'vitest';
import { AgentSpec, CliInfo } from '../../packages/protocol/src/index.js';
import { buildLaunch, type LaunchContext } from '../../packages/agent-core/src/args.js';
import { testSettings } from '../../packages/agent-core/test/helpers.js';

/**
 * SEC-02 (critical). oIDE's workspace trust only filters `.oide/*` and oIDE's own copy of
 * `.mcp.json` servers. The agent is the real `claude -p` running inside the repo checkout, and
 * the CLI documents that `-p` SKIPS its own workspace trust dialog. So an untrusted repo's
 * committed `.claude/settings.json` (hooks such as SessionStart → any command, permissions.allow,
 * env, enableAllProjectMcpServers) and `.mcp.json` are honoured by the CLI on the first spawn.
 *
 * Secure behaviour for untrusted projects: `--setting-sources user` (no project/local) and
 * `--strict-mcp-config` (only oIDE's --mcp-config). Flip `it.fails` to `it` once fixed.
 */
const cli = CliInfo.parse({ found: true, path: 'C:\\bin\\claude.exe', version: '2.1.325', inTestedRange: true, features: { 'permission-prompt-tool': true, 'mcp-config': true } });
const spec = AgentSpec.parse({ projectId: 'p1', title: 'x', goal: 'y', strategy: { kind: 'single', lead: { model: 'opus' } } });
const ctx = (trusted: boolean): LaunchContext => ({
  agentId: 'agt-1',
  sessionId: '11111111-2222-4333-8444-555555555555',
  cwd: '/w/agt-1',
  cli,
  settings: testSettings(),
  mcpConfigPath: '/app/agents/agt-1/mcp.json',
  baseEnv: { PATH: '/usr/bin' },
  trusted,
});

describe('SEC-02 untrusted project: CLI project settings and MCP servers', () => {
  it('passes --strict-mcp-config for an untrusted project', () => {
    expect(buildLaunch(spec, ctx(false)).args).toContain('--strict-mcp-config');
  });

  it('limits --setting-sources to user settings for an untrusted project', () => {
    const args = buildLaunch(spec, ctx(false)).args;
    const i = args.indexOf('--setting-sources');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]!.split(',')).not.toContain('project');
    expect(args[i + 1]!.split(',')).not.toContain('local');
  });
});
