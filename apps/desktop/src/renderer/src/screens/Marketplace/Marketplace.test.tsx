// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { createMockBridge } from '../../lib/mock';
import MarketplaceScreen from './index';

let invoke: ReturnType<typeof vi.fn>;

beforeEach(() => {
  const mock = createMockBridge({ live: false, latency: 0 });
  invoke = vi.fn((command: string, input: unknown) => (mock.invoke as (c: string, i: unknown) => Promise<unknown>)(command, input));
  // No change events: the detail must update from the command's own result.
  installFallbackBridge({ ...mock, invoke, on: () => () => {} } as unknown as OideBridge);
});

afterEach(cleanup);

describe('Marketplace detail › per-tool on/off', () => {
  it('turns one tool of an installed extension off with extensions.setToolEnabled and shows it off', async () => {
    render(<MarketplaceScreen />);
    const commit = await screen.findByRole('checkbox', { name: 'Allow git.commit' });
    expect(commit.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(commit);

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('extensions.setToolEnabled', expect.objectContaining({ tool: 'git.commit', enabled: false })));
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'Allow git.commit' }).getAttribute('aria-checked')).toBe('false'));
    // The other tools stay on.
    expect(screen.getByRole('checkbox', { name: 'Allow git.push' }).getAttribute('aria-checked')).toBe('true');
  });
});

describe('Marketplace search', () => {
  it('shows matches from other categories when the current one has none, and says so', async () => {
    render(<MarketplaceScreen />);
    await screen.findByRole('list', { name: 'Agent tools extensions' });

    fireEvent.change(screen.getByLabelText('Search extensions'), { target: { value: 'Accent' } });

    const list = await screen.findByRole('list', { name: 'Matches in other categories' });
    expect(within(list).getByText('Accent themes')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/No matches in Agent tools\. Showing 1 match from other categories\./);
    expect(screen.queryByText('Nothing matches your search')).toBeNull();
  });

  it('still says nothing matches when no category has a match', async () => {
    render(<MarketplaceScreen />);
    await screen.findByRole('list', { name: 'Agent tools extensions' });
    fireEvent.change(screen.getByLabelText('Search extensions'), { target: { value: 'zzzz-no-such-thing' } });
    expect(await screen.findByText('Nothing matches your search')).toBeTruthy();
  });

  it('keeps a search scoped to the category when it has matches there', async () => {
    render(<MarketplaceScreen />);
    await screen.findByRole('list', { name: 'Agent tools extensions' });
    fireEvent.change(screen.getByLabelText('Search extensions'), { target: { value: 'git' } });
    const list = await screen.findByRole('list', { name: 'Agent tools extensions' });
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
