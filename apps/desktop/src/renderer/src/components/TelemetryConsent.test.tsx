// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Settings, type OideBridge, type TelemetryStatus } from '@oide/protocol';
import { installFallbackBridge } from '../lib/bridge';
import { percentile, takePerfSummary, recordIpc, IPC_SAMPLE_EVERY, trackCommand } from '../lib/telemetry';
import { useSettings } from '../stores/settings';
import { CONSENT_DELAY_MS, TelemetryConsent } from './TelemetryConsent';

let status: TelemetryStatus;
const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  if (command === 'telemetry.status') return status;
  if (command === 'telemetry.consent') {
    const c = (input as { choice: string }).choice;
    if (c !== 'shown') status = { ...status, showPrompt: false };
    return status;
  }
  return { ok: true };
});
const bridge: OideBridge = {
  invoke: invoke as unknown as OideBridge['invoke'],
  on: () => () => undefined,
  platform: 'win32',
};

const settings = (privacy: Partial<Settings['privacy']> = {}) =>
  Settings.parse({
    claude: {},
    models: {},
    agents: { notifications: {} },
    techniques: [],
    permissions: {},
    ui: {},
    privacy,
  });

beforeEach(() => {
  vi.useFakeTimers();
  installFallbackBridge(bridge);
  invoke.mockClear();
  status = { available: true, usageAnalytics: false, errorReports: false, showPrompt: true };
  useSettings.setState({ settings: settings() });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function appear() {
  render(<TelemetryConsent />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(CONSENT_DELAY_MS + 10);
  });
}

const choices = () =>
  invoke.mock.calls
    .filter((c) => c[0] === 'telemetry.consent')
    .map((c) => (c[1] as { choice: string }).choice);

describe('first-run telemetry question', () => {
  it('appears after the window is ready, as an accessible dialog with the plea, the promise and the disclosure', async () => {
    await appear();
    const dialog = screen.getByRole('dialog', { name: 'Help make oIDE better for you' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.textContent).toMatch(/No personal data, code, prompts or project information is ever sent/);
    expect(dialog.textContent).toMatch(/What’s included/);
    expect(dialog.textContent).toMatch(/Settings › Privacy/);
    expect(screen.getByRole('button', { name: 'Share usage and crash reports' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'No thanks' })).toBeTruthy();
    expect(choices()).toEqual(['shown']);
  });

  it('does not appear when main says not to (answered, asked twice, unavailable)', async () => {
    status = { ...status, showPrompt: false };
    await appear();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(choices()).toEqual([]);
  });

  it('"Share usage and crash reports" accepts', async () => {
    await appear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Share usage and crash reports' }));
    });
    expect(choices()).toEqual(['shown', 'accept']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"No thanks" declines', async () => {
    await appear();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'No thanks' }));
    });
    expect(choices()).toEqual(['shown', 'decline']);
  });

  it('Esc is "not now"', async () => {
    await appear();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    });
    expect(choices()).toEqual(['shown', 'later']);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('renderer telemetry helpers', () => {
  it('percentiles and an aggregated, sampled perf summary', () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeUndefined();
    takePerfSummary(1);
    for (let i = 1; i <= 100 * IPC_SAMPLE_EVERY; i++) recordIpc(i % 50);
    const s = takePerfSummary(30);
    expect(s.window_min).toBe(30);
    expect(s.ipc_samples).toBe(100);
    expect(typeof s.ipc_p50_ms).toBe('number');
    expect(takePerfSummary(30).ipc_samples).toBe(0);
  });

  it('reports only built-in commands, only when usage analytics is on', () => {
    trackCommand('oide.spawn', 'core');
    useSettings.setState({ settings: settings({ usageAnalytics: true }) });
    trackCommand('acme.deploy', 'extension');
    trackCommand('oide.spawn', 'extension');
    trackCommand('oide.spawn', 'core');
    const tracked = invoke.mock.calls.filter((c) => c[0] === 'telemetry.track').map((c) => c[1]);
    expect(tracked).toEqual([
      { type: 'event', name: 'command_palette_used', props: { command: 'oide.spawn' } },
    ]);
  });
});
