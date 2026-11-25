// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OideBridge, PendingCleanupInfo } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { DiagnosticsSection } from './DiagnosticsSection';

const PATH = 'C:\\Users\\me\\AppData\\Roaming\\oIDE\\worktrees\\p1\\runs-docker';
let pending: PendingCleanupInfo[];

const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  switch (command) {
    case 'app.diagnostics':
      return { generatedAt: '2026-11-25T00:00:00Z', checks: [], report: '' };
    case 'app.pendingCleanups':
      return pending;
    case 'app.cleanupHolders':
      return { supported: true, holders: [{ label: 'Docker Desktop', category: 'docker', exes: ['com.docker.backend.exe', 'wsl.exe'], pids: [10, 11] }] };
    case 'app.retryCleanup':
      pending = pending.filter((e) => e.path !== (input as { path?: string }).path);
      return { removed: [(input as { path: string }).path], stillPending: [], gaveUp: [] };
    default:
      throw new Error(`[not_implemented] ${command}`);
  }
});

const bridge: OideBridge = { invoke: invoke as unknown as OideBridge['invoke'], on: (() => () => {}) as OideBridge['on'], platform: 'win32' };

beforeEach(() => {
  installFallbackBridge(bridge);
  invoke.mockClear();
  pending = [{ path: PATH, name: 'runs-docker', addedAt: 1, attempts: 2, lastError: 'locked', holders: ['Docker Desktop'] }];
});
afterEach(() => cleanup());

describe('Settings › Diagnostics › Folders waiting to be removed', () => {
  it('lists the folder, shows its holders, and Retry now removes it', async () => {
    render(<DiagnosticsSection />);
    expect(await screen.findByText('Folders waiting to be removed')).toBeTruthy();
    expect(screen.getByText(PATH)).toBeTruthy();
    expect(screen.getByText(/2 tries · last held by Docker Desktop/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show programs holding runs-docker' }));
    expect((await screen.findByRole('status')).textContent).toBe('Docker Desktop (com.docker.backend.exe, wsl.exe)');
    expect(invoke.mock.calls.filter(([c]) => c === 'app.cleanupHolders').map(([, i]) => i)).toEqual([{ path: PATH }]);

    fireEvent.click(screen.getByRole('button', { name: 'Retry removing runs-docker' }));
    await waitFor(() => expect(screen.queryByText('Folders waiting to be removed')).toBeNull());
    expect(invoke.mock.calls.filter(([c]) => c === 'app.retryCleanup').map(([, i]) => i)).toEqual([{ path: PATH }]);
  });

  it('shows nothing when no folder is waiting', async () => {
    pending = [];
    render(<DiagnosticsSection />);
    await waitFor(() => expect(invoke.mock.calls.some(([c]) => c === 'app.pendingCleanups')).toBe(true));
    expect(screen.queryByText('Folders waiting to be removed')).toBeNull();
  });
});
