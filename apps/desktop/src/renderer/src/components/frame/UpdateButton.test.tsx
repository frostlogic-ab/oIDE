// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { OideBridge, UpdateStatus } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { UpdateButton } from './UpdateButton';

let status: UpdateStatus;
const listeners = new Set<(s: UpdateStatus) => void>();
const push = (patch: Partial<UpdateStatus>) => {
  status = { ...status, ...patch };
  act(() => {
    for (const fn of listeners) fn(status);
  });
};

const invoke = vi.fn(async (command: string, _input?: unknown): Promise<unknown> => {
  switch (command) {
    case 'updates.status':
      return status;
    case 'updates.download':
      status = { ...status, state: 'downloading', progress: 0 };
      return status;
    case 'updates.install':
    case 'shell.openExternal':
      return { ok: true };
    default:
      throw new Error(`[not_implemented] ${command}`);
  }
});

const bridge: OideBridge = {
  invoke: invoke as unknown as OideBridge['invoke'],
  on: ((event: string, fn: (s: UpdateStatus) => void) => {
    if (event !== 'updates.changed') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }) as OideBridge['on'],
  platform: 'win32',
};

const calls = (name: string) => invoke.mock.calls.filter(([c]) => c === name).map(([, i]) => i);

beforeEach(() => {
  installFallbackBridge(bridge);
  invoke.mockClear();
  listeners.clear();
  status = { state: 'not-available', currentVersion: '0.1.0', channel: 'stable', canInstall: true, releaseUrl: 'https://github.com/o/r/releases' };
});
afterEach(() => cleanup());

describe('header Update button', () => {
  it('is hidden until an update shows up, shows download progress, then restarts only after a confirm', async () => {
    render(<UpdateButton />);
    await waitFor(() => expect(calls('updates.status')).toHaveLength(1));
    expect(screen.queryByRole('button')).toBeNull();

    push({ state: 'downloading', progress: 0.42, available: { version: '0.2.0' } });
    const busy = screen.getByRole('button', { name: /Downloading 42%/ }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);

    push({ state: 'downloaded', progress: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(calls('updates.install')).toEqual([]);
    const dialog = screen.getByRole('dialog', { name: 'Restart to update to oIDE 0.2.0?' });
    expect(dialog.textContent).toMatch(/stop running agents/);
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    await waitFor(() => expect(calls('updates.install')).toEqual([{ consent: true, from: 'header' }]));
  });

  it('Cancel closes the confirm without installing', async () => {
    status = { ...status, state: 'downloaded', progress: 1, available: { version: '0.2.0' } };
    render(<UpdateButton />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls('updates.install')).toEqual([]);
  });

  it('with Download automatically off, Update starts the download', async () => {
    status = { ...status, state: 'available', available: { version: '0.2.0' } };
    render(<UpdateButton />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    await waitFor(() => expect(calls('updates.download')).toHaveLength(1));
    await screen.findByRole('button', { name: /Downloading 0%/ });
  });

  it('a build that cannot install itself opens the release page', async () => {
    status = { ...status, state: 'available', canInstall: false, available: { version: '0.2.0' }, releaseUrl: 'https://github.com/o/r/releases/tag/v0.2.0' };
    render(<UpdateButton />);
    fireEvent.click(await screen.findByRole('button', { name: 'Update' }));
    await waitFor(() => expect(calls('shell.openExternal')).toEqual([{ url: 'https://github.com/o/r/releases/tag/v0.2.0' }]));
    expect(calls('updates.download')).toEqual([]);
  });

  it('stays hidden when updates are off', async () => {
    status = { ...status, state: 'disabled', canInstall: false, disabledReason: 'Updates are off in development builds.' };
    render(<UpdateButton />);
    await waitFor(() => expect(calls('updates.status')).toHaveLength(1));
    expect(screen.queryByRole('button')).toBeNull();
  });
});
