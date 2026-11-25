import { describe, expect, it } from 'vitest';
import { MOCK_SLASH_COMMANDS } from './mock/focus';
import { filterSlashItems, insertText, mcpServerLabel, slashItem, slashItems, slashScore } from './slash';

describe('slash items', () => {
  it('labels MCP prompts by server and prompt', () => {
    expect(slashItem('mcp__claude_ai_HubSpot__check-database-status')).toEqual({
      name: 'mcp__claude_ai_HubSpot__check-database-status',
      label: 'check-database-status',
      group: 'mcp:claude_ai_HubSpot',
      groupLabel: 'HubSpot (MCP)',
    });
    expect(mcpServerLabel('claude_ai_Claude_Docs')).toBe('Claude Docs');
    expect(mcpServerLabel('my_local_server')).toBe('my local server');
    expect(slashItem('mcp__claude-in-chrome__browse').groupLabel).toBe('claude-in-chrome (MCP)');
  });

  it('describes built-ins and groups plugins and custom commands', () => {
    expect(slashItem('compact')).toMatchObject({ label: '/compact', groupLabel: 'Claude Code', description: expect.stringContaining('asks first') });
    expect(slashItem('engineering:debug')).toMatchObject({ label: 'debug', groupLabel: 'engineering (plugin)' });
    expect(slashItem('gsd-progress')).toMatchObject({ label: '/gsd-progress', groupLabel: 'Skills and custom commands' });
    expect(slashItem('gsd-progress').description).toBeUndefined();
  });

  it('puts built-ins first, then custom, plugins and MCP servers A–Z, without duplicates', () => {
    const items = slashItems(['mcp__claude_ai_Notion__search', 'gsd-debug', 'mcp__claude_ai_HubSpot__a', 'engineering:debug', 'init', '/compact', 'compact']);
    expect(items.map((i) => i.name)).toEqual(['init', 'compact', 'gsd-debug', 'engineering:debug', 'mcp__claude_ai_HubSpot__a', 'mcp__claude_ai_Notion__search']);
  });

  it('handles the ~100 commands of a CLI with many connectors', () => {
    const items = slashItems(MOCK_SLASH_COMMANDS);
    expect(items.length).toBeGreaterThanOrEqual(90);
    expect(items[0]!.name).toBe('compact');
    const groups = [...new Set(items.map((i) => i.groupLabel))];
    expect(groups.slice(0, 2)).toEqual(['Claude Code', 'Skills and custom commands']);
    expect(groups).toContain('HubSpot (MCP)');
    expect(groups).toContain('DataForSEO (MCP)');
  });
});

describe('slash filter', () => {
  const items = slashItems(['compact', 'context', 'init', 'mcp__claude_ai_HubSpot__check-database-status', 'mcp__claude_ai_DataForSEO__dfs-content-brief', 'gsd-plan-phase']);

  it('matches prefixes first, then words, substrings and fuzzy letters', () => {
    expect(slashScore(items.find((i) => i.name === 'context')!, '/con')).toBe(0);
    expect(slashScore(items.find((i) => i.name.endsWith('check-database-status'))!, 'database')).toBe(1);
    expect(slashScore(items.find((i) => i.name.endsWith('check-database-status'))!, 'hub')).toBe(1);
    expect(slashScore(items.find((i) => i.name === 'compact')!, 'pac')).toBe(2);
    expect(slashScore(items.find((i) => i.name === 'gsd-plan-phase')!, 'gpp')).toBe(3);
    expect(slashScore(items.find((i) => i.name === 'init')!, 'zzz')).toBeNull();
  });

  it('keeps groups together and leads with the best match', () => {
    expect(filterSlashItems(items, '/co').map((i) => i.name)).toEqual(['compact', 'context', 'mcp__claude_ai_DataForSEO__dfs-content-brief']);
    expect(filterSlashItems(items, '/dfs').map((i) => i.name)).toEqual(['mcp__claude_ai_DataForSEO__dfs-content-brief']);
    // The full name works too, as typed in the CLI.
    expect(filterSlashItems(items, '/mcp__claude_ai_Hub').map((i) => i.name)).toEqual(['mcp__claude_ai_HubSpot__check-database-status']);
    expect(filterSlashItems(items, '/')).toHaveLength(items.length);
  });

  it('inserts the command with a trailing space', () => {
    expect(insertText(items[0]!)).toBe('/compact ');
  });
});
