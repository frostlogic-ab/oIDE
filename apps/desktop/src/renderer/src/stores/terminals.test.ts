import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentSummary } from '@oide/protocol';
import { oide } from '../lib/bridge';
import { useAgents } from './agents';
import { isInside, useTerminals } from './terminals';

const script = { id: 'npm:package.json:dev', name: 'dev', runner: 'npm' as const, command: 'npm run dev', file: 'package.json' };

beforeEach(() => {
  useTerminals.setState({ sessions: {}, groups: {} });
});

describe('terminals store', () => {
  it('opens shells and scripts as tabs of a group, numbering shells', () => {
    const t = useTerminals.getState();
    const a = t.openShell('files', '/p');
    const b = t.runScript('files', '/p', script, { context: 'oide' });
    const c = t.openShell('files', '/p');
    const st = useTerminals.getState();
    expect(st.groups.files).toMatchObject({ order: [a, b, c], active: c, open: true });
    expect(st.sessions[a]!.title).toBe('Terminal 1');
    expect(st.sessions[b]).toMatchObject({ kind: 'script', title: 'dev', context: 'oide', status: 'starting', script: { id: script.id } });
    expect(st.sessions[c]!.title).toBe('Terminal 3');
  });

  it('closing kills a running process and activates the neighbour', () => {
    const kill = vi.spyOn(oide, 'invoke').mockResolvedValue({ ok: true } as never);
    const t = useTerminals.getState();
    const a = t.openShell('files', '/p');
    const b = t.openShell('files', '/p');
    t.started(a, 'pty-a');
    t.setActive('files', a);
    t.close(a);
    expect(kill).toHaveBeenCalledWith('terminal.kill', { terminalId: 'pty-a' });
    expect(useTerminals.getState().groups.files).toMatchObject({ order: [b], active: b });
    // An exited session is closed without a kill.
    t.started(b, 'pty-b');
    t.exited('pty-b', 1);
    expect(useTerminals.getState().sessions[b]).toMatchObject({ status: 'exited', exitCode: 1 });
    kill.mockClear();
    t.close(b);
    expect(kill).not.toHaveBeenCalled();
    kill.mockRestore();
  });

  it("closes an agent's terminals when the agent is archived or removed", () => {
    const agent = { id: 'a1', worktreePath: '/wt/a1' } as AgentSummary;
    useAgents.setState({ byId: { a1: agent } });
    const t = useTerminals.getState();
    t.openShell('agent:a1', '/wt/a1');
    t.openShell('files', '/wt/a1/sub');
    const keep = t.openShell('files', '/p');
    useAgents.setState({ byId: {} });
    expect(Object.keys(useTerminals.getState().sessions)).toEqual([keep]);
  });

  it('isInside compares folders, not prefixes', () => {
    expect(isInside('C:\\w\\a', 'c:/w/a/')).toBe(true);
    expect(isInside('/w/ab', '/w/a')).toBe(false);
  });
});
