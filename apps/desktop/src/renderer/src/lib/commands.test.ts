import { describe, expect, it, vi } from 'vitest';
import { CommandRegistry, filterCommands, fuzzyScore } from './commands';

describe('fuzzy filter', () => {
  it('matches subsequences and ranks prefixes first', () => {
    expect(fuzzyScore('spn', 'Spawn an agent')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Spawn an agent')).toBeNull();
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('spawn', 'Spawn an agent')!).toBeGreaterThan(fuzzyScore('spawn', 'Respawn')!);
  });

  it('filters commands by title, group and keywords', () => {
    const cmds = [
      { id: 'a', title: 'Go to Settings', keywords: ['preferences'], run: () => {} },
      { id: 'b', title: 'Spawn an agent', group: 'Agents', run: () => {} },
      { id: 'c', title: 'Go to Marketplace', keywords: ['extensions'], run: () => {} },
    ];
    expect(filterCommands(cmds, 'prefs').map((c) => c.id)).toEqual(['a']);
    expect(filterCommands(cmds, 'marketpl')[0]!.id).toBe('c');
    expect(filterCommands(cmds, 'ext').map((c) => c.id)).toContain('c');
    expect(filterCommands(cmds, '')).toHaveLength(3);
  });
});

describe('CommandRegistry', () => {
  it('registers, runs, hides with when(), and unregisters', async () => {
    const reg = new CommandRegistry();
    const run = vi.fn();
    const listener = vi.fn();
    reg.subscribe(listener);
    const off = reg.register([
      { id: 'x', title: 'X', run },
      { id: 'hidden', title: 'H', when: () => false, run },
    ]);
    expect(reg.list().map((c) => c.id)).toEqual(['x']);
    await reg.run('x');
    expect(run).toHaveBeenCalledTimes(1);
    off();
    expect(reg.get('x')).toBeUndefined();
    expect(listener).toHaveBeenCalledTimes(2);
    await expect(reg.run('x')).rejects.toThrow(/Unknown/);
  });

  it('clears commands from one source', () => {
    const reg = new CommandRegistry();
    reg.register([
      { id: 'core', title: 'C', source: 'core', run: () => {} },
      { id: 'ext', title: 'E', source: 'extension', run: () => {} },
    ]);
    reg.clearSource('extension');
    expect(reg.list().map((c) => c.id)).toEqual(['core']);
  });
});
