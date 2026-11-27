// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Settings, type AccountUsage, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { agents, projects, settings as fxSettings } from '../../lib/mock/fixtures';
import { useAccounts } from '../../stores/accounts';
import { useSettings } from '../../stores/settings';
import { countAgents, useAgents } from '../../stores/agents';
import { useCli } from '../../stores/cli';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { StatusBar } from './StatusBar';

installFallbackBridge({ invoke: async () => null, on: () => () => {}, platform: 'win32' } as unknown as OideBridge);

beforeEach(() => {
  const two = agents.slice(0, 2).map((a) => structuredClone(a));
  useAgents.setState({ byId: Object.fromEntries(two.map((a) => [a.id, a])), order: two.map((a) => a.id), events: {}, loaded: true });
  useProjects.setState({ list: projects.slice(0, 1), loaded: true });
  // A stale summary from main: the bar must not use its counts.
  useCli.setState({ usage: { sessions: 6, worktrees: 6, subagentsActive: 6, projectsOpen: 3, tokensToday: 1_300_000 } });
  useSettings.setState({ settings: structuredClone(fxSettings) });
  useAccounts.setState({ usage: [] });
});

const HOUR = 3_600_000;
function withAccounts(labels: string[], usage: Array<Partial<AccountUsage>>) {
  const list = labels.slice(1).map((label, i) => ({ id: `acc-test0${i}`, label }));
  useSettings.setState({ settings: Settings.parse({ ...structuredClone(fxSettings), accounts: { defaultLabel: labels[0], list } }) });
  useAccounts.setState({
    usage: labels.map((label, i) => ({ accountId: i === 0 ? 'default' : list[i - 1]!.id, label, signedIn: 'yes', windows: [], tokensToday: 0, ...usage[i] }) as AccountUsage),
  });
}
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

  it('opens the Usage screen when "Tokens today" is clicked', () => {
    useRouter.setState({ route: { screen: 'wall', params: {} }, back: [], forward: [] });
    render(<StatusBar />);
    fireEvent.click(screen.getByRole('button', { name: /Tokens today/ }));
    expect(useRouter.getState().route.screen).toBe('usage');
    // Back returns to where the user was.
    expect(useRouter.getState().back.at(-1)?.screen).toBe('wall');
  });

  it('shows one chip per account with two accounts, each with its own meter or a dash', () => {
    const now = Date.now();
    withAccounts(['Personal', 'Work'], [{ windows: [{ window: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: now + HOUR, seenAt: now }] }, {}]);
    render(<StatusBar />);
    expect(screen.getByRole('button', { name: 'Personal: Session plan usage 42%' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Work: no plan usage reported yet' })).toBeTruthy();
  });

  it('marks a rate-limited account, and hides a percentage whose window already reset', () => {
    const now = Date.now();
    withAccounts(['Personal', 'Work'], [{ windows: [{ window: 'five_hour', status: 'allowed', utilization: 0.9, resetsAt: now - 1000, seenAt: now - 5 * HOUR }] }, { rateLimitedUntil: now + HOUR }]);
    render(<StatusBar />);
    expect(screen.getByRole('button', { name: 'Personal: no plan usage reported yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Work: rate limited, resets/ })).toBeTruthy();
  });

  it('collapses three or more accounts into one button with a popover listing each', () => {
    const now = Date.now();
    const w = (u: number) => ({ windows: [{ window: 'five_hour', status: 'allowed', utilization: u, resetsAt: now + HOUR, seenAt: now }] });
    withAccounts(['Personal', 'Work', 'Client'], [w(0.2), w(0.78), { signedIn: 'no' }]);
    render(<StatusBar />);
    const btn = screen.getByRole('button', { name: 'Plan usage of 3 accounts' });
    expect(btn.textContent).toContain('Work 78%');
    fireEvent.click(btn);
    const dialog = screen.getByRole('dialog', { name: 'Plan usage per account' });
    expect(dialog.textContent).toContain('Personal');
    expect(dialog.textContent).toContain('Not signed in');
  });

  it('keeps the single meter when there is only one account', () => {
    useAccounts.setState({ usage: [{ accountId: 'default', label: 'Default', signedIn: 'yes', windows: [], tokensToday: 0 }] });
    render(<StatusBar />);
    expect(screen.queryByRole('button', { name: /^Default:/ })).toBeNull();
  });

  it('has no "Tokens today" button before the usage summary arrives', () => {
    useCli.setState({ usage: null });
    render(<StatusBar />);
    expect(screen.queryByRole('button', { name: /Tokens today/ })).toBeNull();
  });
});
