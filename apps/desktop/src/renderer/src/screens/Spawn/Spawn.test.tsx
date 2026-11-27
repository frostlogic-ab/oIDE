// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSummary, type AgentSpec, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { keymap } from '../../lib/keymap';
import { projects, settings } from '../../lib/mock/fixtures';
import { useAccounts } from '../../stores/accounts';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useSettings } from '../../stores/settings';
import { useWall } from '../Wall/wallState';
import SpawnScreen from './index';

const invoke = vi.fn(async (command: string, input?: unknown): Promise<unknown> => {
  if (command === 'agents.spawn') {
    const spec = input as AgentSpec;
    return Array.from({ length: spec.attempts ?? 1 }, (_, i) =>
      AgentSummary.parse({ id: `new-${i}`, projectId: spec.projectId, title: spec.title, status: 'queued', mode: spec.mode ?? 'auto', model: spec.strategy.lead.model, createdAt: Date.now() + i, updatedAt: Date.now() }),
    );
  }
  if (command === 'settings.forProject') {
    const d = projectDefaults[(input as { projectId: string }).projectId];
    if (d) return { ...d, techniques: [] };
  }
  throw new Error(`[not_implemented] ${command}`);
});
/** `settings.forProject` answers per project (`.oide/config.json` under trust); others are not implemented. */
let projectDefaults: Record<string, { defaultMode: string; presetId: string }> = {};
installFallbackBridge({ invoke: invoke as unknown as OideBridge['invoke'], on: () => () => {}, platform: 'win32' });

let detach: () => void;

beforeEach(() => {
  invoke.mockClear();
  projectDefaults = {};
  useAgents.setState({ byId: {}, order: [], events: {}, loaded: true });
  useProjects.setState({ list: projects, loaded: true });
  useSettings.setState({ settings: { ...settings, claude: { ...settings.claude, allowBypass: true } } });
  useScope.setState({ scope: 'all' });
  useWall.setState({ filter: 'all', focusedId: null, highlighted: {}, compactFor: null });
  useRouter.setState({
    route: { screen: 'spawn', params: { projectId: 'oide', context: [{ kind: 'artifact', id: 'art-main-v2', title: 'Main window v2' }] } },
    back: [{ screen: 'wall', params: {} }],
    forward: [],
  });
  detach = keymap.attach(window);
});
afterEach(() => {
  cleanup();
  detach();
});

function spawnCall(): AgentSpec | undefined {
  return invoke.mock.calls.find((c) => c[0] === 'agents.spawn')?.[1] as AgentSpec | undefined;
}

describe('Spawn', () => {
  it('pre-fills context chips from the route and spawns routed parallel attempts', async () => {
    render(<SpawnScreen />);
    expect(screen.getByText('Main window v2')).toBeTruthy();
    expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('oide');
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Add a usage panel to the status bar.' } });
    fireEvent.click(screen.getByRole('button', { name: 'More attempts' }));
    fireEvent.click(screen.getByRole('button', { name: 'More attempts' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Spawn 3 agents/ }));
    });
    const spec = spawnCall()!;
    expect(spec).toMatchObject({
      projectId: 'oide',
      goal: 'Add a usage panel to the status bar.',
      mode: 'auto',
      attempts: 3,
      context: [{ kind: 'artifact', id: 'art-main-v2', title: 'Main window v2' }],
      strategy: { kind: 'routed', lead: { model: 'opus', effort: 'high' }, simple: { model: 'haiku' }, standard: { model: 'sonnet' }, complex: { model: 'opus' } },
    });
    expect(spec.attemptGroup).toBeTruthy();
    // Back on the Wall with the new tiles highlighted
    expect(useRouter.getState().route.screen).toBe('wall');
    expect(Object.keys(useWall.getState().highlighted)).toEqual(['new-0', 'new-1', 'new-2']);
    expect(useAgents.getState().order).toHaveLength(3);
  });

  it('shows no account picker with a single Claude Code account', () => {
    render(<SpawnScreen />);
    expect(screen.queryByLabelText('Account')).toBeNull();
  });

  it('picks the Settings default account, offers the others with their usage, and spawns on the chosen one', async () => {
    const now = Date.now();
    useSettings.setState({ settings: { ...settings, accounts: { defaultLabel: 'Personal', list: [{ id: 'acc-work01', label: 'Work' }, { id: 'acc-client', label: 'Client' }], spawnDefault: 'acc-work01' } } });
    useAccounts.setState({
      usage: [
        { accountId: 'default', label: 'Personal', signedIn: 'yes', windows: [{ window: 'five_hour', status: 'allowed', utilization: 0.42, resetsAt: now + 3_600_000, seenAt: now }], tokensToday: 0 },
        { accountId: 'acc-work01', label: 'Work', signedIn: 'yes', windows: [], tokensToday: 0 },
        { accountId: 'acc-client', label: 'Client', signedIn: 'no', windows: [], tokensToday: 0 },
      ],
    });
    render(<SpawnScreen />);
    const select = screen.getByLabelText('Account') as HTMLSelectElement;
    expect(select.value).toBe('acc-work01');
    const options = [...select.options].map((o) => [o.textContent, o.disabled]);
    expect(options).toEqual([
      ['Personal · Session 42%', false],
      ['Work', false],
      ['Client (not signed in)', true],
    ]);
    fireEvent.change(select, { target: { value: 'default' } });
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Fix the flaky test' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Spawn agent/ }));
    });
    expect(spawnCall()!.accountId).toBeUndefined();
    useAccounts.setState({ usage: [] });
  });

  it('Ctrl+Enter spawns', async () => {
    render(<SpawnScreen />);
    const goal = screen.getByLabelText('Goal');
    fireEvent.change(goal, { target: { value: 'Fix the flaky test' } });
    await act(async () => {
      fireEvent.keyDown(goal, { key: 'Enter', ctrlKey: true });
    });
    expect(spawnCall()).toMatchObject({ title: 'Fix the flaky test', attempts: 1 });
  });

  it('does not spawn without a goal', async () => {
    render(<SpawnScreen />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Spawn agent/ }));
    });
    expect(spawnCall()).toBeUndefined();
    expect(screen.getByText('Describe what the agent should do.')).toBeTruthy();
  });

  it('never offers Bypass together with the project folder', () => {
    render(<SpawnScreen />);
    const workIn = screen.getByLabelText('Work in') as HTMLSelectElement;
    fireEvent.click(screen.getByRole('radio', { name: /Bypass permissions/ }));
    expect(screen.getByRole('alert').textContent).toMatch(/will not ask/);
    const folder = [...workIn.options].find((o) => o.value === 'project-folder')!;
    expect(folder.disabled).toBe(true);

    fireEvent.click(screen.getByRole('radio', { name: /^Auto/ }));
    fireEvent.change(workIn, { target: { value: 'project-folder' } });
    const bypass = screen.getByRole('radio', { name: /Bypass permissions/ });
    expect(bypass.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(bypass);
    expect(screen.getByRole('radio', { name: /^Auto/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('hides Bypass when Settings › Allow Bypass is off', () => {
    useSettings.setState({ settings });
    render(<SpawnScreen />);
    expect(screen.queryByRole('radio', { name: /Bypass permissions/ })).toBeNull();
  });

  it("takes the default mode and preset from the project's .oide/config.json (settings.forProject)", async () => {
    projectDefaults = { oide: { defaultMode: 'acceptEdits', presetId: 'quality' } };
    await act(async () => {
      render(<SpawnScreen />);
    });
    expect(invoke).toHaveBeenCalledWith('settings.forProject', { projectId: 'oide' });
    expect(screen.getByRole('radio', { name: /^Edit automatically/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /Quality/ }).getAttribute('aria-checked')).toBe('true');
    // Another project without its own defaults: the global ones; a mode the user picked stays.
    fireEvent.click(screen.getByRole('radio', { name: /^Plan/ }));
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'billing-api' } });
    });
    expect(screen.getByRole('radio', { name: /^Plan/ }).getAttribute('aria-checked')).toBe('true');
    fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Tidy the README' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /Spawn agent/ }));
    });
    expect(spawnCall()).toMatchObject({ projectId: 'billing-api', mode: 'plan' });
  });

  it('switches the focus to Custom when a slot changes', () => {
    render(<SpawnScreen />);
    expect(screen.getByRole('radio', { name: /Balanced/ }).getAttribute('aria-checked')).toBe('true');
    const adv = screen.getByRole('button', { name: 'Advanced model settings' });
    expect(adv.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('radiogroup', { name: 'Simple subagent tasks: model' })).toBeNull();
    fireEvent.click(adv);
    fireEvent.click(screen.getByRole('radiogroup', { name: 'Simple subagent tasks: model' }).querySelector('[role="radio"]:nth-child(2)')!);
    expect(screen.getByRole('radio', { name: /Custom/ }).getAttribute('aria-checked')).toBe('true');
  });

  describe('discard guard', () => {
    const route = () => useRouter.getState().route;
    it('closes at once when nothing was entered (route-prefilled context is not lost work)', () => {
      render(<SpawnScreen />);
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog', { name: 'Discard this agent?' })).toBeNull();
      expect(route().screen).toBe('wall');
    });

    it('asks before discarding a typed goal; Keep editing stays, Discard closes', () => {
      render(<SpawnScreen />);
      fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Fix the flaky test' } });
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('dialog', { name: 'Discard this agent?' })).toBeTruthy();
      expect(route().screen).toBe('spawn');
      fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
      expect(screen.queryByRole('dialog', { name: 'Discard this agent?' })).toBeNull();
      expect((screen.getByLabelText('Goal') as HTMLTextAreaElement).value).toBe('Fix the flaky test');
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(route().screen).toBe('wall');
    });

    it('guards the Edit presets link', () => {
      render(<SpawnScreen />);
      fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Something' } });
      fireEvent.click(screen.getByRole('link', { name: 'Edit presets' }));
      expect(route().screen).toBe('spawn');
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(route()).toMatchObject({ screen: 'settings', params: { section: 'models' } });
    });

    it('the Techniques link opens Settings on the tech section, after the guard', () => {
      useSettings.setState({
        settings: {
          ...settings,
          claude: { ...settings.claude, allowBypass: true },
          techniques: [
            {
              id: 't1',
              name: 'Plan first',
              description: '',
              text: 'Plan.',
              placement: 'first-message',
              builtIn: false,
              enabledByDefault: false,
              scope: 'global',
            },
          ],
        },
      });
      render(<SpawnScreen />);
      fireEvent.click(screen.getByRole('button', { name: /Advanced techniques/ }));
      fireEvent.click(screen.getByRole('link', { name: /Edit the text or add your own techniques/ }));
      expect(route()).toMatchObject({ screen: 'settings', params: { section: 'tech' } });
    });

    it('asks before leaving through the Techniques link once a goal is typed', () => {
      useSettings.setState({
        settings: {
          ...settings,
          claude: { ...settings.claude, allowBypass: true },
          techniques: [
            {
              id: 't1',
              name: 'Plan first',
              description: '',
              text: 'Plan.',
              placement: 'first-message',
              builtIn: false,
              enabledByDefault: false,
              scope: 'global',
            },
          ],
        },
      });
      render(<SpawnScreen />);
      fireEvent.change(screen.getByLabelText('Goal'), { target: { value: 'Something' } });
      fireEvent.click(screen.getByRole('button', { name: /Advanced techniques/ }));
      fireEvent.click(screen.getByRole('link', { name: /Edit the text or add your own techniques/ }));
      expect(route().screen).toBe('spawn');
      fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
      expect(route()).toMatchObject({ screen: 'settings', params: { section: 'tech' } });
    });
  });
});
