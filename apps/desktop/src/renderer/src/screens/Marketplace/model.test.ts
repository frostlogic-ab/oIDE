import { describe, expect, it } from 'vitest';
import { filterItems, monogram, parsePastedJson, qualifiedToolName, riskFromHints, sanitizeServerName, splitCommandLine, type ListItem } from './model';

describe('marketplace model', () => {
  it('derives risk from MCP annotations', () => {
    expect(riskFromHints({ readOnlyHint: true })).toBe('read');
    expect(riskFromHints({ destructiveHint: true })).toBe('ask');
    expect(riskFromHints({ readOnlyHint: true, destructiveHint: true })).toBe('ask');
    expect(riskFromHints({})).toBe('ask');
  });

  it('splits command lines with quotes', () => {
    expect(splitCommandLine('npx -y "@a/b c" --root .')).toEqual(['npx', '-y', '@a/b c', '--root', '.']);
    expect(splitCommandLine(`docker run 'x y' ""`)).toEqual(['docker', 'run', 'x y', '']);
  });

  it('parses pasted mcpServers JSON', () => {
    const ok = parsePastedJson('{ "mcpServers": { "s": { "command": "npx", "args": ["-y", "x"], "env": { "K": "v" } } } }');
    expect(ok).toEqual({ servers: [{ name: 's', command: 'npx', args: ['-y', 'x'], env: { K: 'v' } }] });
    expect(parsePastedJson('{').error).toMatch(/Not valid JSON/);
    expect(parsePastedJson('{"servers":{}}').error).toMatch(/mcpServers/);
    expect(parsePastedJson('{"mcpServers":{"r":{"url":"https://x"}}}').error).toMatch(/From a URL/);
  });

  it('names and monograms', () => {
    expect(sanitizeServerName('Metrics API!')).toBe('Metrics-API');
    expect(qualifiedToolName('postgres', 'db.schema')).toBe('mcp__postgres__db_schema');
    expect(monogram('Browser preview')).toBe('Bp');
    expect(monogram('Git')).toBe('G');
  });

  it('filters by category and query and sorts', () => {
    const item = (displayName: string, downloads: number, categories: string[], updatedAt?: string): ListItem => ({
      key: displayName,
      kind: 'entry',
      name: displayName,
      displayName,
      publisher: 'p',
      description: '',
      categories,
      downloads,
      updatedAt,
      tools: [],
      capabilities: null,
      reviewed: true,
      state: 'install',
    });
    const items = [item('B', 5, ['agent-tools'], '2026-01-02'), item('A', 9, ['agent-tools'], '2026-01-01'), item('C', 1, ['themes'])];
    expect(filterItems(items, 'agent-tools', '', 'installs').map((i) => i.key)).toEqual(['A', 'B']);
    expect(filterItems(items, 'agent-tools', '', 'updated').map((i) => i.key)).toEqual(['B', 'A']);
    expect(filterItems(items, 'agent-tools', 'b', 'name').map((i) => i.key)).toEqual(['B']);
  });
});
