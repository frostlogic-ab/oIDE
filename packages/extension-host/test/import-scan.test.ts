import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CustomServer } from '@oide/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CustomTools } from '../src/custom-tools.js';
import { extractServers, knownConfigFiles, scanImports, stripJsonc } from '../src/import-scan.js';
import { customEnvSecretKey } from '../src/mcp-config.js';
import { memoryCustomRepo, memorySecrets, tempDir } from './helpers.js';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/** Fake home folder with configs from the apps the scanner knows. Never the user's real files. */
function fakeHome() {
  const t = tempDir('oide-home-');
  cleanups.push(t.cleanup);
  const home = t.dir;
  const appData = path.join(home, 'AppData', 'Roaming');
  const w = (p: string, v: unknown) => {
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
  };
  w(path.join(appData, 'Claude', 'claude_desktop_config.json'), {
    mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~/code'] } },
    globalShortcut: 'Ctrl+Space',
  });
  // Claude Code's user config: account details next to MCP servers. Only mcpServers may come out.
  w(path.join(home, '.claude.json'), {
    oauthAccount: { emailAddress: 'someone@example.com', accountUuid: 'ACCOUNT-SECRET-UUID' },
    userID: 'USER-ID-SECRET',
    primaryApiKey: 'sk-should-never-appear',
    mcpServers: {
      'issue-tracker': { type: 'http', url: 'https://mcp.tracker.example/mcp', headers: { Authorization: 'Bearer HEADER-SECRET' } },
      playwright: { command: 'npx', args: ['@playwright/mcp'] },
    },
    projects: {
      'C:/code/billing-api': { allowedTools: ['Bash'], history: ['PROMPT-HISTORY-SECRET'], mcpServers: { 'postgres-local': { command: 'docker', args: ['run', 'mcp/postgres', 'postgresql://localhost/billing'], env: { PGPASSWORD: 'PG-SECRET' } } } },
    },
  });
  w(path.join(appData, 'Code', 'User', 'mcp.json'), '{\n  // VS Code allows comments\n  "servers": { "notes": { "type": "stdio", "command": "uvx", "args": ["notes-mcp"], }, },\n}');
  w(path.join(home, '.cursor', 'mcp.json'), '{ not json "with" SECRET-IN-BROKEN-FILE');
  const project = path.join(home, 'projects', 'docs-site');
  w(path.join(project, '.mcp.json'), { mcpServers: { search: { command: 'node', args: ['search.js'], env: { SEARCH_KEY: 'SEARCH-SECRET' } } } });
  return { home, appData, project };
}

describe('import scanner', () => {
  it('finds servers in every known config and returns only mcpServers data, without secret values', async () => {
    const { home, appData, project } = fakeHome();
    const existing = [CustomServer.parse({ id: 'x', name: 'playwright', route: 'command', transport: { kind: 'stdio', command: 'npx', args: ['@playwright/mcp'] }, savedTo: 'my-settings' })];
    const found = await scanImports({ home, appData, platform: 'win32', projects: [{ name: 'docs-site', root: project }], existing });
    const byName = Object.fromEntries(found.map((f) => [f.name, f]));
    expect(Object.keys(byName).sort()).toEqual(['filesystem', 'issue-tracker', 'notes', 'playwright', 'postgres-local', 'search']);
    expect(byName['filesystem']?.source).toBe('Claude Desktop');
    expect(byName['filesystem']?.display).toBe('npx -y @modelcontextprotocol/server-filesystem ~/code');
    expect(byName['issue-tracker']).toMatchObject({ source: 'Claude Code · your settings', kind: 'http', display: 'https://mcp.tracker.example/mcp' });
    expect(byName['postgres-local']?.source).toBe('Claude Code · billing-api');
    expect(byName['postgres-local']?.config).toEqual({ kind: 'stdio', command: 'docker', args: ['run', 'mcp/postgres', 'postgresql://localhost/billing'], envKeys: ['PGPASSWORD'] });
    expect(byName['notes']?.source).toBe('VS Code');
    expect(byName['search']?.source).toBe('docs-site/.mcp.json');
    expect(byName['playwright']?.alreadyAdded).toBe(true);
    expect(byName['filesystem']?.alreadyAdded).toBe(false);

    const text = JSON.stringify(found);
    for (const secret of ['someone@example.com', 'ACCOUNT-SECRET-UUID', 'USER-ID-SECRET', 'sk-should-never-appear', 'PROMPT-HISTORY-SECRET', 'allowedTools', 'globalShortcut', 'HEADER-SECRET', 'PG-SECRET', 'SEARCH-SECRET', 'SECRET-IN-BROKEN-FILE']) {
      expect(text).not.toContain(secret);
    }
  });

  it('imports chosen entries, moving env and header values to the keychain', async () => {
    const { home, appData, project } = fakeHome();
    const repo = memoryCustomRepo();
    const secrets = memorySecrets();
    const files = knownConfigFiles({ home, appData, platform: 'win32', projects: [{ name: 'docs-site', root: project }] });
    const tools = new CustomTools({ repo, secrets, openExternal: () => undefined, project: () => undefined, scan: { files } });
    const claudeJson = path.join(home, '.claude.json');
    const added = await tools.importSelected([
      { file: claudeJson, name: 'postgres-local' },
      { file: claudeJson, name: 'issue-tracker' },
    ]);
    expect(added.map((s) => s.name)).toEqual(['postgres-local', 'issue-tracker']);
    const pg = added[0]!;
    expect(pg.route).toBe('import');
    expect(secrets.data.get(customEnvSecretKey(pg.id, 'PGPASSWORD'))).toBe('PG-SECRET');
    const tracker = added[1]!;
    expect(tracker.transport).toMatchObject({ kind: 'http', auth: 'header' });
    expect([...secrets.data.values()].some((v) => v.includes('HEADER-SECRET'))).toBe(true);
    expect(JSON.stringify([...repo.items.values()])).not.toMatch(/SECRET/);
  });

  it('extractServers ignores everything but the MCP key and hides parse error details', () => {
    expect(extractServers('{"mcpServers":{"a":{"command":"x"}},"secret":"y"}', 'mcpServers')).toEqual([{ name: 'a', config: { kind: 'stdio', command: 'x', args: [], env: {} } }]);
    expect(() => extractServers('{"broken": SECRET', 'mcpServers')).toThrow(/^not valid JSON$/);
    expect(stripJsonc('{"a": "// not a comment", /* c */ "b": [1,],}')).toBe('{"a": "// not a comment",  "b": [1]}');
  });

  it('knows the per-OS Claude Desktop path', () => {
    const mac = knownConfigFiles({ home: '/Users/me', platform: 'darwin' })[0]!.file;
    expect(mac.replace(/\\/g, '/')).toBe('/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
    const linux = knownConfigFiles({ home: '/home/me', platform: 'linux' })[0]!.file;
    expect(linux.replace(/\\/g, '/')).toBe('/home/me/.config/Claude/claude_desktop_config.json');
  });
});
