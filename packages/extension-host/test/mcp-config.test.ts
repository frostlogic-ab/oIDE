import path from 'node:path';
import { CustomServer, ExtensionManifest, type InstalledExtension } from '@oide/protocol';
import { describe, expect, it } from 'vitest';
import { buildMcpConfig, mcpConfigFile, mcpToolName, resolveAgentMcpConfig, secretEnvName } from '../src/mcp-config.js';
import { resolveManifest } from '../src/manifest.js';
import { memorySecrets, samplePkg } from './helpers.js';

const dir = path.resolve('/ext/sample');
const manifest = ExtensionManifest.parse(samplePkg());
const loaded = resolveManifest(dir, manifest, false);
const record = (over: Partial<InstalledExtension> = {}): InstalledExtension => ({
  id: manifest.name,
  name: manifest.name,
  version: manifest.version,
  displayName: 'Sample',
  source: 'marketplace',
  path: dir,
  enabledProjects: ['p1'],
  enabledGlobally: false,
  disabledProjects: [],
  disabledTools: [],
  reviewed: true,
  devMode: false,
  manifest,
  ...over,
});

const custom = (over: Record<string, unknown>) => CustomServer.parse({ id: 'c1', name: 'metrics', route: 'url', savedTo: 'my-settings', allProjects: true, ...over });

describe('mcpToolName', () => {
  it('builds mcp__server__tool with CLI-safe characters', () => {
    expect(mcpToolName('postgres', 'db.schema')).toBe('mcp__postgres__db_schema');
    expect(mcpToolName('browser-preview', 'preview_url')).toBe('mcp__browser-preview__preview_url');
  });
});

describe('buildMcpConfig', () => {
  it('pre-allows read tools, never ask tools, and disallows turned-off tools', () => {
    const cfg = buildMcpConfig({
      projectId: 'p1',
      extensions: [{ record: record(), loaded }],
      customServers: [
        custom({
          transport: { kind: 'http', url: 'https://mcp.example.com/mcp' },
          tools: [
            { name: 'metrics.query', risk: 'read' },
            { name: 'alerts.silence', risk: 'ask' },
            { name: 'metrics.export', risk: 'read', enabled: false },
          ],
        }),
      ],
    });
    expect(cfg.mcpServers['sample']).toEqual({ type: 'stdio', command: 'node', args: [path.join(dir, 'dist', 'mcp.js')], cwd: dir });
    expect(cfg.mcpServers['metrics']).toEqual({ type: 'http', url: 'https://mcp.example.com/mcp' });
    expect(cfg.allowedTools).toEqual(['mcp__metrics__metrics_query', 'mcp__sample__db_schema']);
    expect(cfg.disallowedTools).toEqual(['mcp__metrics__metrics_export']);
    expect(cfg.allowedTools.some((t) => t.includes('db_write') || t.includes('alerts_silence'))).toBe(false);
  });

  it('applies per-extension turned-off tools, even read ones', () => {
    const cfg = buildMcpConfig({ projectId: 'p1', extensions: [{ record: record({ disabledTools: ['mcp__sample__db_schema'] }), loaded }], customServers: [] });
    expect(cfg.allowedTools).toEqual([]);
    expect(cfg.disallowedTools).toEqual(['mcp__sample__db_schema']);
  });

  it('only includes custom servers for their projects', () => {
    const s = custom({ allProjects: false, projects: ['p2'], transport: { kind: 'http', url: 'https://x.example/mcp' }, tools: [{ name: 't', risk: 'read' }] });
    expect(Object.keys(buildMcpConfig({ projectId: 'p1', extensions: [], customServers: [s] }).mcpServers)).toEqual([]);
    expect(Object.keys(buildMcpConfig({ projectId: 'p2', extensions: [], customServers: [s] }).mcpServers)).toEqual(['metrics']);
  });

  it('routes token-backed remote servers through the proxy with the agent secret', () => {
    const s = custom({ transport: { kind: 'http', url: 'https://wiki.example/mcp', auth: 'oauth' } });
    const cfg = buildMcpConfig({ projectId: 'p1', extensions: [], customServers: [s], proxy: { urlFor: (n) => `http://127.0.0.1:4555/mcp/${n}`, headerName: 'x-oide-agent-secret', agentSecret: 'S' } });
    expect(cfg.mcpServers['metrics']).toEqual({ type: 'http', url: 'http://127.0.0.1:4555/mcp/metrics', headers: { 'x-oide-agent-secret': 'S' } });
    const noProxy = buildMcpConfig({ projectId: 'p1', extensions: [], customServers: [s] });
    expect(noProxy.mcpServers['metrics']).toBeUndefined();
    expect(noProxy.warnings[0]).toMatch(/proxy/);
  });

  it('uses ${VAR} placeholders for secrets and returns values as env only', async () => {
    const s = custom({ name: 'local-search', route: 'command', transport: { kind: 'stdio', command: 'npx', args: ['-y', 'x'], envKeys: ['SEARCH_API_KEY'] } });
    const secrets = memorySecrets();
    await secrets.set('custom/c1/env/SEARCH_API_KEY', 'k3y');
    const cfg = await resolveAgentMcpConfig({ projectId: 'p1', extensions: [], customServers: [s], secretStore: secrets });
    const v = secretEnvName('local-search', 'SEARCH_API_KEY');
    expect(v).toBe('OIDE_MCP_LOCAL_SEARCH_SEARCH_API_KEY');
    expect(cfg.mcpServers['local-search']).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { SEARCH_API_KEY: `\${${v}}` } });
    expect(cfg.env).toEqual({ [v]: 'k3y' });
    expect(mcpConfigFile(cfg)).not.toContain('k3y');
  });

  it('leaves .mcp.json servers to the CLI but still sets their lists and env, and skips them when untrusted', () => {
    const s = custom({ savedTo: 'project-mcp-json', transport: { kind: 'stdio', command: 'node', args: ['s.js'], envKeys: ['KEY'] }, tools: [{ name: 'q', risk: 'read' }] });
    const cfg = buildMcpConfig({ projectId: 'p1', extensions: [], customServers: [s], secrets: { c1: { KEY: 'v' } } });
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.allowedTools).toEqual(['mcp__metrics__q']);
    expect(cfg.env).toEqual({ KEY: 'v' });
    const untrusted = buildMcpConfig({ projectId: 'p1', extensions: [], customServers: [s], secrets: { c1: { KEY: 'v' } }, projectTrusted: false });
    expect(untrusted.allowedTools).toEqual([]);
    expect(untrusted.env).toEqual({});
  });

  it('skips duplicate and reserved server names', () => {
    const s = custom({ name: 'sample', transport: { kind: 'http', url: 'https://x.example/mcp' } });
    const o = custom({ id: 'c2', name: 'oide', transport: { kind: 'http', url: 'https://y.example/mcp' } });
    const cfg = buildMcpConfig({ projectId: 'p1', extensions: [{ record: record(), loaded }], customServers: [s, o] });
    expect(Object.keys(cfg.mcpServers)).toEqual(['sample']);
    expect(cfg.warnings).toHaveLength(2);
  });
});
