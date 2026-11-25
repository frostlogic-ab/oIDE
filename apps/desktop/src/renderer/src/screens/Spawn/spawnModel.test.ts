import { describe, expect, it } from 'vitest';
import { AgentSpec, CliInfo, Settings } from '@oide/protocol';
import { projects } from '../../lib/mock/fixtures';
import {
  FALLBACK_PRESETS,
  applyVersions,
  availableEfforts,
  availableModes,
  availableStrategies,
  buildSpec,
  initialForm,
  matchPreset,
  slotsFromStrategy,
  strategySummary,
  titleFromGoal,
  type SpawnForm,
} from './spawnModel';

const settings = Settings.parse({
  claude: { allowBypass: true },
  models: { presets: FALLBACK_PRESETS },
  agents: { notifications: {} },
  techniques: [
    { id: 'review', name: 'Adversarial review', text: 'Review.', placement: 'first-message', enabledByDefault: true },
    { id: 'docs', name: 'Docs', text: 'Docs.', placement: 'first-message', enabledByDefault: false },
    { id: 'gates', name: 'Gates', text: 'Gates.', placement: 'system-prompt', enabledByDefault: true },
  ],
  permissions: {},
  ui: {},
});

function form(patch: Partial<SpawnForm> = {}): SpawnForm {
  return { ...initialForm({ settings, projects, scope: 'all', params: {}, cli: null }), goal: 'Add a usage panel. It opens from the status bar.', ...patch };
}

describe('initialForm', () => {
  it('starts on Balanced (routed), Auto, the first project, techniques on by default', () => {
    const f = initialForm({ settings, projects, scope: 'billing-api', params: {}, cli: null });
    expect(f.kind).toBe('routed');
    expect(f.mode).toBe('auto');
    expect(f.projectId).toBe('billing-api');
    expect(f.techniques).toEqual({ review: true, docs: false, gates: true });
    expect(matchPreset(f.kind, f.slots, FALLBACK_PRESETS)).toBe('balanced');
  });

  it('pre-fills project and context chips from route params', () => {
    const f = initialForm({ settings, projects, scope: 'all', params: { projectId: 'docs-site', context: [{ kind: 'artifact', id: 'art-1', title: 'Main window v2' }] }, cli: null });
    expect(f.projectId).toBe('docs-site');
    expect(f.context).toEqual([{ kind: 'artifact', id: 'art-1', title: 'Main window v2' }]);
  });
});

describe('buildSpec', () => {
  it('builds a valid routed AgentSpec with parallel attempts', () => {
    const res = buildSpec(form({ attempts: 3, context: [{ kind: 'file', path: 'src/shell/StatusBar.tsx' }] }), { allowBypass: true, techniqueOrder: ['review', 'docs', 'gates'], newId: () => 'grp-1' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(AgentSpec.parse(res.spec)).toEqual(res.spec);
    expect(res.spec).toMatchObject({
      projectId: 'oide',
      title: 'Add a usage panel',
      // The title is a stand-in from the goal: the agent is asked to name the task.
      autoTitle: true,
      goal: 'Add a usage panel. It opens from the status bar.',
      workIn: 'worktree-from-main',
      mode: 'auto',
      attempts: 3,
      attemptGroup: 'grp-1',
      techniques: ['review', 'gates'],
      context: [{ kind: 'file', path: 'src/shell/StatusBar.tsx' }],
      strategy: {
        kind: 'routed',
        lead: { model: 'opus', effort: 'high' },
        simple: { model: 'haiku', effort: 'low' },
        standard: { model: 'sonnet', effort: 'medium' },
        complex: { model: 'opus', effort: 'high' },
      },
    });
  });

  it('has no attempt group for a single attempt', () => {
    const res = buildSpec(form(), { allowBypass: false });
    expect(res.ok && res.spec.attemptGroup).toBe(undefined);
  });

  it('refuses Bypass in the project folder', () => {
    const res = buildSpec(form({ mode: 'bypassPermissions', workIn: 'project-folder' }), { allowBypass: true });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.errors.mode).toMatch(/never in the project folder/);
  });

  it('refuses Bypass when Settings › Allow Bypass is off', () => {
    const res = buildSpec(form({ mode: 'bypassPermissions' }), { allowBypass: false });
    expect(!res.ok && res.errors.mode).toMatch(/Allow Bypass/);
  });

  it('allows Bypass in a worktree when enabled', () => {
    const res = buildSpec(form({ mode: 'bypassPermissions', workIn: 'worktree-from-current' }), { allowBypass: true });
    expect(res.ok && res.spec.mode).toBe('bypassPermissions');
  });

  it('requires a goal and a project', () => {
    const res = buildSpec(form({ goal: '  ', projectId: '' }), { allowBypass: false });
    expect(!res.ok && Object.keys(res.errors).sort()).toEqual(['goal', 'projectId']);
  });

  it('puts a custom model on the lead as customModel', () => {
    const f = form({ kind: 'single' });
    f.slots = { ...f.slots, lead: { model: 'custom:m1', effort: 'high' } };
    const res = buildSpec(f, { allowBypass: false, customModels: [{ id: 'm1', name: 'local-coder', provider: 'local', model: 'qwen3-coder', hasKey: false, extraEnv: {} }] });
    expect(res.ok && res.spec).toMatchObject({ customModel: { id: 'm1' }, strategy: { kind: 'single', lead: { model: 'qwen3-coder' } } });
  });
});

describe('presets and summary', () => {
  it('switches to Custom when slots stop matching', () => {
    const slots = slotsFromStrategy(FALLBACK_PRESETS[1]!.strategy);
    expect(matchPreset('routed', slots, FALLBACK_PRESETS)).toBe('balanced');
    expect(matchPreset('routed', { ...slots, simple: { model: 'sonnet', effort: 'low' } }, FALLBACK_PRESETS)).toBe('custom');
    expect(matchPreset('single', slotsFromStrategy(FALLBACK_PRESETS[2]!.strategy), FALLBACK_PRESETS)).toBe('quality');
  });

  it('pinned versions still match their preset, and go to the spec as exact ids', () => {
    const slots = applyVersions(slotsFromStrategy(FALLBACK_PRESETS[1]!.strategy), { opus: '4.8' });
    expect(slots.lead.model).toBe('claude-opus-4-8');
    expect(slots.simple.model).toBe('haiku');
    expect(matchPreset('routed', slots, FALLBACK_PRESETS)).toBe('balanced');
  });

  it('summarizes like the canvas', () => {
    const slots = slotsFromStrategy(FALLBACK_PRESETS[1]!.strategy);
    expect(strategySummary('routed', slots)).toBe('Orchestrator Opus (high) · subagents routed Haiku / Sonnet / Opus');
    expect(strategySummary('single', slotsFromStrategy(FALLBACK_PRESETS[2]!.strategy))).toBe('Opus (max) for everything');
  });

  it('titles come from the first sentence of the goal', () => {
    expect(titleFromGoal('Fix the flaky invoice test. It fails at midnight.')).toBe('Fix the flaky invoice test');
    expect(titleFromGoal('x'.repeat(120))).toHaveLength(80);
  });
});

describe('CLI feature gating', () => {
  const cli = (features: Record<string, boolean>) => CliInfo.parse({ found: true, features });
  it('shows everything when the CLI is unknown', () => {
    expect(availableModes(null, true)).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
    expect(availableEfforts(null)).toHaveLength(5);
    expect(availableStrategies(null)).toContain('routed');
  });
  it('hides Bypass unless allowed, and modes / efforts / routing the CLI lacks', () => {
    const c = cli({ effort: true, 'effort:low': true, 'effort:high': true, agents: false, 'mode:default': true, 'mode:plan': true, 'mode:auto': false, 'mode:bypassPermissions': true });
    expect(availableModes(c, false)).toEqual(['default', 'plan']);
    expect(availableModes(c, true)).toEqual(['default', 'plan', 'bypassPermissions']);
    expect(availableEfforts(c)).toEqual(['low', 'high']);
    expect(availableEfforts(cli({ effort: false, agents: true }))).toEqual([]);
    expect(availableStrategies(c)).not.toContain('routed');
    expect(initialForm({ settings, projects, scope: 'all', params: {}, cli: c }).mode).toBe('default');
  });
});
