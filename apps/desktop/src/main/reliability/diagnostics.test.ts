import { describe, expect, it } from 'vitest';
import { collectDiagnostics, formatBytes, parseVersion, versionAtLeast, type DiagnosticsDeps } from './diagnostics.js';
import { Redactor } from './redact.js';

const HOME = '/home/jane';
function deps(over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    appVersion: '0.1.0',
    userDataDir: `${HOME}/.config/oIDE`,
    logsDir: `${HOME}/.config/oIDE/logs`,
    dbFile: `${HOME}/.config/oIDE/oide.db`,
    cli: async () => ({ found: true, path: `${HOME}/.local/bin/claude`, version: '2.1.325', inTestedRange: true, signedIn: 'yes', features: {} }),
    mcpPort: () => 51234,
    keychainAvailable: () => true,
    crashReportsEnabled: () => false,
    fileLoggingOk: () => true,
    redactor: new Redactor({ home: HOME, paths: { [`${HOME}/.config/oIDE`]: '<userData>' } }),
    homeRedactor: new Redactor({ home: HOME }),
    runVersion: async (tool) => ({ git: { path: '/usr/bin/git', output: 'git version 2.45.1' }, gh: null, node: { path: '/usr/bin/node', output: 'v22.11.0' } })[tool] ?? null,
    now: () => Date.UTC(2026, 10, 24),
    ...over,
  };
}

const byId = (d: Awaited<ReturnType<typeof collectDiagnostics>>, id: string) => d.checks.find((c) => c.id === id)!;

describe('diagnostics', () => {
  it('reports every check, redacted, with a copyable report', async () => {
    const d = await collectDiagnostics(deps());
    expect(d.checks.map((c) => c.id)).toEqual(['app', 'cli', 'git', 'gh', 'node', 'keychain', 'db', 'mcp', 'logs', 'crash', 'userData']);
    expect(byId(d, 'cli')).toMatchObject({ status: 'ok', value: '2.1.325 · ~/.local/bin/claude' });
    expect(byId(d, 'git')).toMatchObject({ status: 'ok', value: '2.45.1 · /usr/bin/git' });
    expect(byId(d, 'gh')).toMatchObject({ status: 'warn', value: 'Not found' });
    expect(byId(d, 'node').status).toBe('ok');
    expect(byId(d, 'db').value).toMatch(/^<userData>\/oide\.db · 0 B$/);
    expect(byId(d, 'mcp').value).toBe('127.0.0.1:51234');
    expect(byId(d, 'userData').value).toBe('~/.config/oIDE');
    expect(d.report).toContain('oIDE diagnostics · 2026-11-24');
    expect(d.report).toContain('[warn] GitHub CLI (gh): Not found');
    expect(d.report).not.toContain(HOME);
  });

  it('fails git older than 2.38 (merge-tree --write-tree), a missing CLI and a dead MCP server', async () => {
    const d = await collectDiagnostics(
      deps({
        runVersion: async (t) => (t === 'git' ? { path: '/usr/bin/git', output: 'git version 2.34.1' } : null),
        cli: async () => ({ found: false, inTestedRange: false, signedIn: 'unknown', features: {} }),
        mcpPort: () => undefined,
        keychainAvailable: () => false,
      }),
    );
    expect(byId(d, 'git')).toMatchObject({ status: 'error' });
    expect(byId(d, 'git').detail).toMatch(/2\.38/);
    expect(byId(d, 'cli').status).toBe('error');
    expect(byId(d, 'mcp').status).toBe('error');
    expect(byId(d, 'keychain').status).toBe('warn');
    expect(byId(d, 'node').status).toBe('warn');
  });

  it('version helpers', () => {
    expect(parseVersion('git version 2.38.0.windows.1')).toEqual([2, 38, 0]);
    expect(parseVersion('v22.1')).toEqual([22, 1, 0]);
    expect(parseVersion('nope')).toBeNull();
    expect(versionAtLeast([2, 38, 0], [2, 38, 0])).toBe(true);
    expect(versionAtLeast([2, 37, 9], [2, 38, 0])).toBe(false);
    expect(versionAtLeast([3, 0, 0], [2, 38, 0])).toBe(true);
    expect(formatBytes(2048)).toBe('2.0 KB');
  });
});
