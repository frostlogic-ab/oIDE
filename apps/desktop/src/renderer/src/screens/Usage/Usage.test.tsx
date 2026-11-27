// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { tokenSum, type OideBridge, type UsageRange, type UsageStats } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { useRouter } from '../../stores/router';
import { mockUsageStats } from '../../lib/mock/usage';
import { formatTokens } from '../../lib/format';
import UsageScreen, { BarChart } from './index';

const NOW = new Date(2026, 10, 27, 12).getTime();
const stats = (range: UsageRange): UsageStats => mockUsageStats(range, NOW);

function zeroStats(range: UsageRange): UsageStats {
  const base = stats(range);
  const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  return {
    ...base,
    days: base.days.map((d) => ({ ...d, tokens: zero, sessions: 0 })),
    totals: zero,
    previousTotal: 0,
    sessions: { total: 0, merged: 0, discarded: 0, completed: 0, errored: 0, inWorktree: 0, parallel: 0, subagents: 0 },
    projects: [],
    models: [],
    hours: Array<number>(24).fill(0),
    weekdays: Array<number>(7).fill(0),
    activeDays: 0,
    longestStreak: 0,
    currentStreak: 0,
    busiestDay: undefined,
  };
}

let invoke: ReturnType<typeof vi.fn>;

function install(handler: (command: string, input: { range: UsageRange }) => Promise<unknown>) {
  invoke = vi.fn(handler);
  installFallbackBridge({ invoke, on: () => () => {}, platform: 'win32' } as unknown as OideBridge);
}

const group = () => screen.getByRole('radiogroup', { name: 'Time range' });

beforeEach(() => {
  // The range lives in the route: start every test on the Usage screen with no range (7 days).
  useRouter.setState({ route: { screen: 'usage', params: {} }, back: [], forward: [] });
});
afterEach(cleanup);

describe('UsageScreen', () => {
  it('asks for the last 7 days first and shows the totals in the tiles', async () => {
    install(async (_c, { range }) => stats(range));
    render(<UsageScreen />);
    await screen.findByRole('heading', { level: 1, name: /Usage, last 7 days/ });

    expect(invoke).toHaveBeenCalledWith('usage.stats', { range: '7d' });
    const s = stats('7d');
    const tile = (label: string) => screen.getByText(label, { selector: 'span' }).parentElement!;
    expect(within(tile('Tokens')).getByText(formatTokens(tokenSum(s.totals)))).toBeTruthy();
    expect(within(tile('Agent sessions')).getByText(String(s.sessions.total))).toBeTruthy();
    expect(within(tile('Active days')).getByText(`${s.activeDays} / 7`)).toBeTruthy();
    expect(within(tile('Projects')).getByText(String(s.projects.length))).toBeTruthy();
    expect(within(tile('Projects')).getByText(`Most: ${s.projects[0]!.name}`)).toBeTruthy();
    // Up against the 7 days before.
    expect(within(tile('Tokens')).getByText(/vs the 7 days before/)).toBeTruthy();
  });

  it('lists the projects, token mix, models and the "How you work" facts', async () => {
    install(async (_c, { range }) => stats(range));
    render(<UsageScreen />);
    await screen.findByRole('heading', { level: 1 });

    const s = stats('7d');
    const byProject = screen.getByRole('region', { name: 'By project' });
    for (const p of s.projects) expect(within(byProject).getByText(p.name)).toBeTruthy();

    const mix = screen.getByRole('region', { name: 'Token mix' });
    for (const kind of ['Input', 'Output', 'Cache read', 'Cache write']) expect(within(mix).getByText(kind)).toBeTruthy();
    for (const m of s.models) expect(within(mix).getByText(m.model)).toBeTruthy();

    expect(screen.getByRole('region', { name: 'How you work' })).toBeTruthy();
    expect(screen.getByTestId('fact-peak-hour')).toBeTruthy();
    expect(screen.getByTestId('fact-peak-weekday')).toBeTruthy();
    expect(screen.getByTestId('fact-cache')).toBeTruthy();
    expect(screen.queryByText('No agent sessions in this range')).toBeNull();
  });

  it('renders one bar per day for 7 days', async () => {
    install(async (_c, { range }) => stats(range));
    render(<UsageScreen />);
    const tokens = await screen.findByRole('region', { name: 'Tokens per day' });
    expect(within(tokens).getAllByTestId('bar')).toHaveLength(7);
  });

  it('re-invokes usage.stats with range 30d when switching to "30 days"', async () => {
    install(async (_c, { range }) => stats(range));
    render(<UsageScreen />);
    await screen.findByRole('heading', { level: 1, name: /last 7 days/ });
    expect(within(group()).getByRole('radio', { name: '7 days' }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(within(group()).getByRole('radio', { name: '30 days' }));

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('usage.stats', { range: '30d' }));
    await screen.findByRole('heading', { level: 1, name: /last 30 days/ });
    expect(within(group()).getByRole('radio', { name: '30 days' }).getAttribute('aria-checked')).toBe('true');
    expect(within(screen.getByRole('region', { name: 'Tokens per day' })).getAllByTestId('bar')).toHaveLength(30);
    expect(screen.getByText('Active days').parentElement!.textContent).toContain(`${stats('30d').activeDays} / 30`);
  });

  it('shows the year per week', async () => {
    install(async (_c, { range }) => stats(range));
    render(<UsageScreen />);
    await screen.findByRole('heading', { level: 1 });
    fireEvent.click(within(group()).getByRole('radio', { name: '1 year' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('usage.stats', { range: '1y' }));
    const tokens = await screen.findByRole('region', { name: 'Tokens per week' });
    expect(within(tokens).getAllByTestId('bar')).toHaveLength(52);
  });

  it('shows the empty state for an all-zero payload', async () => {
    install(async (_c, { range }) => zeroStats(range));
    render(<UsageScreen />);

    expect(await screen.findByText('No agent sessions in this range')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Spawn an agent' })).toBeTruthy();
    // The tiles still render; the charts do not.
    expect(screen.getByText('Agent sessions', { selector: 'span' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Tokens per day' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'How you work' })).toBeNull();
  });

  it('says the usage could not be loaded when the command rejects', async () => {
    install(async () => {
      throw new Error('boom');
    });
    render(<UsageScreen />);

    expect(await screen.findByText('Usage could not be loaded')).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
    // The range control stays, so the user can retry another range.
    expect(group()).toBeTruthy();
  });

  it('keeps showing the loaded stats when a later range fails', async () => {
    let calls = 0;
    install(async (_c, { range }) => {
      if (++calls > 1) throw new Error('boom');
      return stats(range);
    });
    render(<UsageScreen />);
    await screen.findByRole('heading', { level: 1, name: /last 7 days/ });
    fireEvent.click(within(group()).getByRole('radio', { name: '30 days' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('Usage could not be loaded')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: /last 7 days/ })).toBeTruthy();
  });
});

describe('BarChart', () => {
  const bars = [
    { key: 'a', label: 'Mon 1 Jan', value: 0 },
    { key: 'b', label: 'Tue 2 Jan', value: 5 },
  ];

  it('labels each bar and exposes a table for screen readers', () => {
    render(<BarChart bars={bars} name="Sessions" format={String} height={100} />);
    expect(screen.getByRole('img', { name: 'Tue 2 Jan: 5 sessions' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('rowheader', { name: 'Mon 1 Jan' })).toBeTruthy();
  });

  it('shows a tooltip on hover and hides it on leave', () => {
    render(<BarChart bars={bars} name="Sessions" format={String} height={100} />);
    const bar = screen.getByRole('img', { name: 'Tue 2 Jan: 5 sessions' });
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.mouseEnter(bar);
    expect(within(screen.getByRole('tooltip')).getByText('5')).toBeTruthy();
    fireEvent.mouseLeave(bar.parentElement!.parentElement!.parentElement!);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('draws an empty chart without throwing', () => {
    render(<BarChart bars={[{ key: 'a', label: 'x', value: 0 }]} name="Sessions" format={String} height={100} />);
    expect(screen.getAllByTestId('bar')).toHaveLength(1);
  });
});
