// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentSummary, type AgentSpec, type OideBridge } from '@oide/protocol';
import { installFallbackBridge } from '../../lib/bridge';
import { keymap } from '../../lib/keymap';
import { projects, settings } from '../../lib/mock/fixtures';
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
    fireEvent.click(screen.getByRole('radiogroup', { name: 'Simple subagent tasks: model' }).querySelector('[role="radio"]:nth-child(2)')!);
    expect(screen.getByRole('radio', { name: /Custom/ }).getAttribute('aria-checked')).toBe('true');
  });
});
