// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { agents, projects } from '../../lib/mock/fixtures';
import { countAgents, useAgents } from '../../stores/agents';
import { useCli } from '../../stores/cli';
import { useProjects } from '../../stores/projects';
import { StatusBar } from './StatusBar';

installFallbackBridge({ invoke: async () => null, on: () => () => {}, platform: 'win32' } as unknown as OideBridge);

beforeEach(() => {
  const two = agents.slice(0, 2).map((a) => structuredClone(a));
  useAgents.setState({ byId: Object.fromEntries(two.map((a) => [a.id, a])), order: two.map((a) => a.id), events: {}, loaded: true });
  useProjects.setState({ list: projects.slice(0, 1), loaded: true });
  // A stale summary from main: the bar must not use its counts.
  useCli.setState({ usage: { sessions: 6, worktrees: 6, subagentsActive: 6, projectsOpen: 3, tokensToday: 1_300_000 } });
});
afterEach(cleanup);

describe('StatusBar', () => {
  it('counts sessions, subagents and projects from the live stores (same as the header), tokens from usage', () => {
    render(<StatusBar />);
    const list = Object.values(useAgents.getState().byId);
    const subs = countAgents(list).subagentsActive;
    expect(screen.getByTestId('status-counts').textContent).toBe(`2 sessions · 2 worktrees · ${subs} ${subs === 1 ? 'subagent' : 'subagents'} active`);
    expect(screen.getByText('1 project open')).toBeTruthy();
    expect(screen.getByText('1.3M')).toBeTruthy();
  });
});
