// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomModel, Settings, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { builtInPresets, builtInTechniques, seedLibrarySettings } from '../../lib/mock/library';
import { useRouter } from '../../stores/router';
import { useSettings } from '../../stores/settings';
import SettingsScreen from './index';

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !base || typeof base !== 'object') return patch;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) out[k] = v === null ? undefined : deepMerge(out[k], v);
  return out;
}

let current: Settings;
const invoke = vi.fn(async (command: string, input: unknown): Promise<unknown> => {
  switch (command) {
    case 'settings.update':
      current = Settings.parse(deepMerge(current, (input as { patch: unknown }).patch));
      return current;
    case 'settings.builtIns':
      return { presets: builtInPresets, techniques: builtInTechniques };
    case 'settings.loadErrors':
      return [];
    case 'settings.techniques':
      return builtInTechniques;
    case 'settings.saveCustomModel': {
      const { model, apiKey } = input as { model: CustomModel; apiKey?: string };
      const saved = CustomModel.parse({ ...model, hasKey: Boolean(apiKey) });
      current = { ...current, models: { ...current.models, custom: [...current.models.custom, saved] } };
      // Main broadcasts settings.changed after a save.
      useSettings.getState().apply(current);
      return saved;
    }
    default:
      throw new Error(`[not_implemented] ${command}`);
  }
});

const bridge: OideBridge = { invoke: invoke as unknown as OideBridge['invoke'], on: () => () => {}, platform: 'win32' };

function open(section: string) {
  act(() => useRouter.setState({ route: { screen: 'settings', params: { section } }, back: [], forward: [] }));
  return render(<SettingsScreen />);
}

beforeEach(() => {
  installFallbackBridge(bridge);
  invoke.mockClear();
  current = seedLibrarySettings(Settings.parse({ claude: {}, models: {}, agents: { notifications: {} }, techniques: [], permissions: {}, ui: {} }));
  useSettings.setState({ settings: current });
});

afterEach(() => cleanup());

const updates = () => invoke.mock.calls.filter(([c]) => c === 'settings.update').map(([, i]) => (i as { patch: unknown }).patch);

describe('Settings screen', () => {
  it('Techniques opens with the first technique expanded (as on the canvas)', async () => {
    open('tech');
    const first = builtInTechniques[0]!;
    await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(first.name) }).getAttribute('aria-expanded')).toBe('true'));
    const others = builtInTechniques.slice(1).map((t) => screen.getByRole('button', { name: new RegExp(t.name) }).getAttribute('aria-expanded'));
    expect(others.every((x) => x === 'false')).toBe(true);
  });

  it('Allow Bypass toggle saves { claude: { allowBypass } }', async () => {
    open('cli');
    const box = screen.getByRole('checkbox', { name: 'Allowed' });
    expect((box as HTMLInputElement).checked).toBe(true);
    fireEvent.click(box);
    await waitFor(() => expect(updates()).toContainEqual({ claude: { allowBypass: false } }));
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Allowed' }) as HTMLInputElement).checked).toBe(false));
  });

  it('max running saves { agents: { maxRunning } } and refuses out-of-range values', async () => {
    open('agents');
    const input = screen.getByRole('spinbutton', { name: 'Max agents running at once' });
    fireEvent.change(input, { target: { value: '5' } });
    await waitFor(() => expect(updates()).toContainEqual({ agents: { maxRunning: 5 } }));

    invoke.mockClear();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Max agents running at once' }), { target: { value: '99' } });
    expect(screen.getByRole('spinbutton', { name: 'Max agents running at once' })).toHaveProperty('ariaInvalid', 'true');
    expect(screen.getByText('Choose between 1 and 32')).toBeTruthy();
    expect(updates()).toEqual([]);
  });

  it('a custom model key goes to saveCustomModel and is never rendered afterwards', async () => {
    open('models');
    fireEvent.click(screen.getByRole('button', { name: '+ Add model' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Compatible API' }));
    fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'gateway' } });
    fireEvent.change(screen.getByLabelText('Model ID'), { target: { value: 'my-model' } });
    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'https://gw.example.com' } });
    fireEvent.change(screen.getByLabelText(/API key or token/), { target: { value: 'sk-secret-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));

    await waitFor(() => expect(invoke.mock.calls.some(([c]) => c === 'settings.saveCustomModel')).toBe(true));
    const [, input] = invoke.mock.calls.find(([c]) => c === 'settings.saveCustomModel')!;
    expect(input).toMatchObject({ apiKey: 'sk-secret-123', model: { name: 'gateway', provider: 'compatible-api', model: 'my-model' } });

    await waitFor(() => expect(screen.getByText('Key stored')).toBeTruthy());
    expect(screen.queryByLabelText(/API key or token/)).toBeNull(); // form closed
    expect(document.body.innerHTML).not.toContain('sk-secret-123');
    expect(screen.getByText('•••• from keychain')).toBeTruthy();
  });

  it('shows validation errors instead of saving an incomplete model', async () => {
    open('models');
    fireEvent.click(screen.getByRole('button', { name: '+ Add model' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add model' }));
    expect(screen.getByLabelText('Display name').getAttribute('aria-invalid')).toBe('true');
    expect(invoke.mock.calls.some(([c]) => c === 'settings.saveCustomModel')).toBe(false);
  });
});
