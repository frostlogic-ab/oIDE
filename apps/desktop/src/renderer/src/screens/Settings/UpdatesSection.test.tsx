// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Settings, type OideBridge, type UpdateStatus } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { useRouter } from '../../stores/router';
import { useSettings } from '../../stores/settings';
import SettingsScreen from './index';
import { formatChecked } from './UpdatesSection';

let current: Settings;
let status: UpdateStatus;
const listeners = new Set<(s: UpdateStatus) => void>();
const push = (patch: Partial<UpdateStatus>) => {
  status = { ...status, ...patch };
  act(() => {
    for (const fn of listeners) fn(status);
  });
};

const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  switch (command) {
    case 'settings.update': {
      const patch = (input as { patch: { updates?: Partial<Settings['updates']> } }).patch;
      current = { ...current, updates: { ...current.updates, ...patch.updates } };
      return current;
    }
    case 'settings.builtIns':
      return { presets: [], techniques: [] };
    case 'settings.loadErrors':
      return [];
    case 'updates.status':
      return status;
    case 'updates.check':
      status = { ...status, state: 'available', lastCheckedAt: Date.now(), available: { version: '0.2.0', releaseNotes: 'Faster Wall' } };
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

function open() {
  act(() => useRouter.setState({ route: { screen: 'settings', params: { section: 'updates' } }, back: [], forward: [] }));
  return render(<SettingsScreen />);
}

const calls = (name: string) => invoke.mock.calls.filter(([c]) => c === name).map(([, i]) => i);

beforeEach(() => {
  installFallbackBridge(bridge);
  invoke.mockClear();
  listeners.clear();
  current = Settings.parse({ claude: {}, models: {}, agents: { notifications: {} }, techniques: [], permissions: {}, ui: {} });
  status = { state: 'idle', currentVersion: '0.1.0', channel: 'stable', canInstall: true, releaseUrl: 'https://github.com/oide-dev/oide/releases' };
  useSettings.setState({ settings: current });
});
afterEach(() => cleanup());

describe('Settings › Updates', () => {
  it('shows the current version, channel and last check; the channel saves { updates: { channel } }', async () => {
    open();
    await waitFor(() => expect(screen.getByTestId('current-version').textContent).toBe('0.1.0'));
    expect(screen.getByText('Never checked')).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Stable' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByRole('radio', { name: 'Beta' }));
    await waitFor(() => expect(calls('settings.update')).toContainEqual({ patch: { updates: { channel: 'beta' } } }));
  });

  it('Check now → Download → Restart to update asks before installing', async () => {
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    await screen.findByText('oIDE 0.2.0');
    expect(screen.getByText('Faster Wall')).toBeTruthy();
    expect(calls('updates.download')).toEqual([]);

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(calls('updates.download')).toHaveLength(1));
    push({ state: 'downloading', progress: 0.5 });
    expect(screen.getByRole('progressbar', { name: 'Download progress' }).getAttribute('aria-valuenow')).toBe('50');

    push({ state: 'downloaded', progress: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    expect(calls('updates.install')).toEqual([]);
    expect(screen.getByRole('group', { name: 'Confirm restart' }).textContent).toMatch(/stop running agents/);
    fireEvent.click(screen.getByRole('button', { name: 'Restart now' }));
    await waitFor(() => expect(calls('updates.install')).toEqual([{ consent: true, from: 'settings' }]));
  });

  it('Download automatically and Install when oIDE closes are on by default and save their own keys', async () => {
    open();
    const download = (await screen.findByRole('checkbox', { name: 'Download' })) as HTMLInputElement;
    const install = screen.getByRole('checkbox', { name: 'Install' }) as HTMLInputElement;
    expect(download.checked).toBe(true);
    expect(install.checked).toBe(true);
    fireEvent.click(download);
    fireEvent.click(install);
    await waitFor(() => expect(calls('settings.update')).toEqual([{ patch: { updates: { downloadAutomatically: false } } }, { patch: { updates: { installOnQuit: false } } }]));
  });

  it('a downloaded update says it installs when oIDE closes', async () => {
    status = { ...status, state: 'downloaded', progress: 1, available: { version: '0.2.0' } };
    open();
    await screen.findByText(/installs when you close oIDE/);
  });

  it('unsigned builds get the release page instead of Download', async () => {
    status = { ...status, state: 'available', canInstall: false, available: { version: '0.2.0' }, releaseUrl: 'https://github.com/oide-dev/oide/releases/tag/v0.2.0' };
    open();
    fireEvent.click(await screen.findByRole('button', { name: 'Open release page' }));
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    await waitFor(() => expect(calls('shell.openExternal')).toEqual([{ url: 'https://github.com/oide-dev/oide/releases/tag/v0.2.0' }]));
  });

  it('disabled builds explain why and cannot check', async () => {
    status = { ...status, state: 'disabled', canInstall: false, disabledReason: 'Updates are off in development builds.' };
    open();
    await screen.findByText('Updates are off in development builds.');
    expect((screen.getByRole('button', { name: 'Check now' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a build without a release feed links to no releases page (there is no default org)', async () => {
    const { releaseUrl: _unused, ...rest } = status;
    status = { ...rest, state: 'disabled', canInstall: false, disabledReason: 'This build has no release feed.' };
    open();
    await screen.findByText('This build has no release feed.');
    expect(screen.queryByRole('link', { name: 'releases page' })).toBeNull();
  });

  it('errors are announced', async () => {
    open();
    await screen.findByTestId('current-version');
    push({ state: 'error', error: 'net::ERR_INTERNET_DISCONNECTED' });
    expect(screen.getByRole('alert').textContent).toMatch(/ERR_INTERNET_DISCONNECTED/);
  });

  it('formats the last check', () => {
    const now = 1_700_000_000_000;
    expect(formatChecked(undefined, now)).toBe('Never checked');
    expect(formatChecked(now - 10_000, now)).toBe('Last checked just now');
    expect(formatChecked(now - 5 * 60_000, now)).toBe('Last checked 5 min ago');
    expect(formatChecked(now - 5 * 3_600_000, now)).toMatch(/^Last checked /);
  });
});
