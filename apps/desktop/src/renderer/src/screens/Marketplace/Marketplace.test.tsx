// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
