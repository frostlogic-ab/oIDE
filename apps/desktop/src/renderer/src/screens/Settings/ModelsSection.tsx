import { useState } from 'react';
import {
  KNOWN_MODEL_VERSIONS,
  MODEL_FAMILIES,
  resolveModel,
  type CustomModel,
  type Effort,
  type FocusPreset,
  type ModelSlot,
  type ModelStrategy,
  type Settings,
} from '@oide/protocol';
import { SegmentedControl, Tabs, cn } from '@oide/ui';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { CustomModelForm, PROVIDER_LABEL } from './CustomModelForm';
import { H1, Pills, Rd, Row, Sec, inp, outlineBtn, savePatch } from './ui';

const FAMILY_LABEL: Record<string, string> = { haiku: 'Haiku', sonnet: 'Sonnet', opus: 'Opus', fable: 'Fable' };
const EFFORT_LABEL: Record<Effort, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'x-high', max: 'max' };
const EFFORTS: Array<{ value: Effort; label: string }> = [
  { value: 'low', label: 'Effort: Low' },
  { value: 'medium', label: 'Effort: Medium' },
  { value: 'high', label: 'Effort: High' },
  { value: 'xhigh', label: 'Effort: X-High' },
  { value: 'max', label: 'Effort: Max' },
];
const STRATEGIES: Array<{ kind: ModelStrategy['kind']; label: string; desc: string }> = [
  { kind: 'single', label: 'One model', desc: 'Orchestrator and subagents share one model.' },
  { kind: 'subagent-model', label: 'Separate subagent model', desc: 'Subagents always use their own model.' },
  { kind: 'routed', label: 'Routed by orchestrator', desc: 'The orchestrator picks a model per subagent task.' },
];

/** Prefix for custom models in a preset slot (`custom:<id>`). */
export const CUSTOM_PREFIX = 'custom:';


type SlotKey = 'lead' | 'subagents' | 'simple' | 'standard' | 'complex';

function slotsOf(s: ModelStrategy): Array<{ key: SlotKey; label: string; slot: ModelSlot }> {
  if (s.kind === 'single') return [{ key: 'lead', label: 'All agents', slot: s.lead }];
  if (s.kind === 'subagent-model')
    return [
      { key: 'lead', label: 'Orchestrator', slot: s.lead },
      { key: 'subagents', label: 'Subagents', slot: s.subagents },
    ];
  return [
    { key: 'lead', label: 'Orchestrator', slot: s.lead },
    { key: 'simple', label: 'Simple subagent tasks', slot: s.simple },
    { key: 'standard', label: 'Standard subagent tasks', slot: s.standard },
    { key: 'complex', label: 'Complex subagent tasks', slot: s.complex },
  ];
}

/** Switch strategy kind, keeping the models already chosen where they map. */
function withKind(s: ModelStrategy, kind: ModelStrategy['kind']): ModelStrategy {
  const lead = s.lead;
  const sub = s.kind === 'subagent-model' ? s.subagents : s.kind === 'routed' ? s.standard : { model: 'sonnet', effort: 'medium' as const };
  if (kind === 'single') return { kind, lead };
  if (kind === 'subagent-model') return { kind, lead, subagents: sub };
  const r = s.kind === 'routed' ? s : null;
  return { kind, lead, simple: r?.simple ?? { model: 'haiku', effort: 'low' }, standard: r?.standard ?? sub, complex: r?.complex ?? { model: 'opus', effort: 'high' } };
}

function strategyEqual(a: ModelStrategy, b: ModelStrategy): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ModelsSection({ settings, builtIns }: { settings: Settings; builtIns: FocusPreset[] | null }) {
  const presets = settings.models.presets;
  const [editId, setEditId] = useState(settings.models.defaultPresetId !== 'custom' && presets.some((p) => p.id === settings.models.defaultPresetId) ? settings.models.defaultPresetId : (presets[0]?.id ?? 'balanced'));
  const preset = presets.find((p) => p.id === editId) ?? presets[0];
  const customs = settings.models.custom;

  const modelName = (m: string) => {
    if (m.startsWith(CUSTOM_PREFIX)) return customs.find((c) => c.id === m.slice(CUSTOM_PREFIX.length))?.name ?? m;
    return FAMILY_LABEL[m.toLowerCase()] ?? m;
  };
  const isEdited = (p: FocusPreset) => {
    const b = builtIns?.find((x) => x.id === p.id);
    return Boolean(b && !strategyEqual(b.strategy, p.strategy));
  };
  const savePreset = (next: FocusPreset) => void savePatch({ models: { presets: presets.map((p) => (p.id === next.id ? next : p)) } });
  const setStrategy = (s: ModelStrategy) => preset && savePreset({ ...preset, strategy: s });
  const setSlot = (key: SlotKey, patch: Partial<ModelSlot>) => {
    if (!preset) return;
    const s = preset.strategy as Record<string, unknown> & ModelStrategy;
    setStrategy({ ...s, [key]: { ...(s[key] as ModelSlot), ...patch } } as ModelStrategy);
  };

  const me = (slot: ModelSlot) => `${modelName(slot.model)} (${EFFORT_LABEL[slot.effort ?? 'medium']})`;
  const summary = preset
    ? `${preset.name}: ${
        preset.strategy.kind === 'single'
          ? `${me(preset.strategy.lead)} for everything`
          : preset.strategy.kind === 'subagent-model'
            ? `orchestrator ${me(preset.strategy.lead)}, subagents ${me(preset.strategy.subagents)}`
            : `orchestrator ${me(preset.strategy.lead)}, subagents routed ${me(preset.strategy.simple)} / ${me(preset.strategy.standard)} / ${me(preset.strategy.complex)}`
      }`
    : '';

  const modelOptions = [
    ...MODEL_FAMILIES.map((f) => ({ value: f as string, label: FAMILY_LABEL[f]! })),
    ...customs.map((c) => ({ value: `${CUSTOM_PREFIX}${c.id}`, label: c.name })),
  ];

  const defaultOptions = [
    ...presets.map((p) => ({ value: p.id, label: p.name })),
    { value: 'custom', label: 'Custom (last used)' },
  ];

  return (
    <>
      <H1>Models</H1>
      <Rd>Edit what each focus preset does. Spawn agent uses these, and you can still override them per agent under Advanced.</Rd>

      <Row title="Default focus" desc="Preselected when you spawn an agent.">
        {() => (
          <SegmentedControl
            label="Default focus"
            variant="inset"
            size={28}
            options={defaultOptions}
            value={settings.models.defaultPresetId}
            onChange={(v) => void savePatch({ models: { defaultPresetId: v } })}
          />
        )}
      </Row>

      <Sec>Presets</Sec>
      <Tabs
        className="mt-2.5"
        label="Preset"
        idPrefix="preset"
        variant="pill"
        value={preset?.id ?? ''}
        onChange={setEditId}
        tabs={presets.map((p) => ({
          id: p.id,
          label: (
            <>
              {p.name}
              {isEdited(p) && <span className="text-[11px] text-warn">edited</span>}
            </>
          ),
        }))}
      />

      {preset && (
        <div role="tabpanel" id={`preset-panel-${preset.id}`} aria-labelledby={`preset-tab-${preset.id}`} className="flex flex-col gap-3.5 mt-3 p-4 rounded-xl border border-line-2 bg-panel">
          <div className="flex items-center gap-2.5 flex-wrap">
            <span className="flex-1 text-[12.5px] text-ink-3">{summary}</span>
            {builtIns?.some((b) => b.id === preset.id) && (
              <button
                type="button"
                disabled={!isEdited(preset)}
                onClick={() => {
                  const b = builtIns.find((x) => x.id === preset.id);
                  if (b) savePreset({ ...preset, strategy: structuredClone(b.strategy) });
                }}
                className="h-7 px-2.5 rounded-sm border border-line-3 bg-transparent text-ink-2 text-[12px] hover:bg-raised disabled:opacity-50"
              >
                Reset to default
              </button>
            )}
          </div>
          <div className="flex flex-col gap-2">
            <span id="pstrat" className="text-[12px] font-semibold text-ink-2">
              How agents pick models
            </span>
            <div role="radiogroup" aria-labelledby="pstrat" className="grid grid-cols-3 gap-2">
              {STRATEGIES.map((s) => {
                const on = preset.strategy.kind === s.kind;
                return (
                  <button
                    key={s.kind}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => !on && setStrategy(withKind(preset.strategy, s.kind))}
                    className={cn(
                      'flex flex-col gap-[3px] p-2.5 rounded-lg text-left text-ink text-[12.5px] border-[1.5px]',
                      on ? 'border-accent bg-selected-2' : 'border-line-3 bg-transparent hover:bg-raised',
                    )}
                  >
                    <span className="font-semibold">{s.label}</span>
                    <span className="text-[11.5px] text-ink-3 leading-[1.35]">{s.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            {slotsOf(preset.strategy).map(({ key, label, slot }) => (
              <div key={key} className="flex items-center gap-2.5 flex-wrap">
                <span className="w-[170px] text-[12.5px] text-ink-2">{label}</span>
                <Pills label={`${label} model`} options={modelOptions} value={slot.model.toLowerCase().startsWith(CUSTOM_PREFIX) ? slot.model : slot.model.toLowerCase()} onChange={(m) => setSlot(key, { model: m })} />
                <select aria-label={`${label} effort`} className={cn(inp, 'h-8 text-[12px]')} value={slot.effort ?? 'medium'} onChange={(e) => setSlot(key, { effort: e.target.value as Effort })}>
                  {EFFORTS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}
      <Rd className="mt-2.5">Changes apply to agents you spawn from now on. Running agents keep their models.</Rd>

      <Sec>Model versions</Sec>
      <Rd className="mt-1.5">
        Presets and Spawn refer to a model family. Pick which version each family means. "Latest" follows new releases. Pinning keeps a version fixed. The list comes from the CLI.
      </Rd>
      {MODEL_FAMILIES.map((fam) => {
        const v = settings.models.versions[fam] ?? 'latest';
        const list = KNOWN_MODEL_VERSIONS[fam];
        const resolved = v === 'latest' ? `${list[0]!.id} (latest)` : resolveModel(fam, settings.models.versions);
        return (
          <Row key={fam} title={FAMILY_LABEL[fam]} desc={<span className="font-mono text-[11.5px]">uses {resolved}</span>}>
            {({ titleId }) => (
              <select
                aria-label={`${FAMILY_LABEL[fam]} version`}
                aria-describedby={titleId}
                className={cn(inp, 'w-[220px]')}
                value={v}
                onChange={(e) => void savePatch({ models: { versions: { [fam]: e.target.value } } })}
              >
                <option value="latest">Latest (auto-update)</option>
                {list.map((x) => (
                  <option key={x.version} value={x.version}>
                    {FAMILY_LABEL[fam]} {x.version}
                  </option>
                ))}
              </select>
            )}
          </Row>
        );
      })}

      <YourModels customs={customs} />
    </>
  );
}

/* ------------------------------------------------------------------ Your models */

function envLines(m: CustomModel): Array<[string, string]> {
  if (m.provider === 'bedrock')
    return [
      ['CLAUDE_CODE_USE_BEDROCK', '1'],
      ['ANTHROPIC_MODEL', m.model],
      ['AWS_REGION', m.extraEnv.AWS_REGION ?? '[REGION]'],
    ];
  if (m.provider === 'vertex')
    return [
      ['CLAUDE_CODE_USE_VERTEX', '1'],
      ['ANTHROPIC_MODEL', m.model],
      ['CLOUD_ML_REGION', m.extraEnv.CLOUD_ML_REGION ?? '[REGION]'],
    ];
  return [
    ['ANTHROPIC_BASE_URL', m.baseUrl ?? ''],
    ['ANTHROPIC_MODEL', m.model],
    ['ANTHROPIC_AUTH_TOKEN', m.hasKey ? '•••• from keychain' : '(none)'],
  ];
}

type TestState = { state: 'testing' } | { state: 'done'; ok: boolean; detail: string };

function YourModels({ customs }: { customs: CustomModel[] }) {
  const [form, setForm] = useState<{ open: false } | { open: true; editing?: CustomModel }>({ open: false });
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const test = async (id: string) => {
    setTests((t) => ({ ...t, [id]: { state: 'testing' } }));
    try {
      const r = await oide.invoke('settings.testCustomModel', { id });
      setTests((t) => ({ ...t, [id]: { state: 'done', ...r } }));
    } catch (err) {
      setTests((t) => ({ ...t, [id]: { state: 'done', ok: false, detail: ipcErrorMessage(err) } }));
    }
  };
  const remove = async (m: CustomModel) => {
    try {
      await oide.invoke('settings.deleteCustomModel', { id: m.id });
      toast(`Removed ${m.name}. Its key was deleted from your keychain.`, 'info');
    } catch (err) {
      toast(`Could not remove ${m.name}: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  return (
    <>
      <div className="flex items-center gap-2.5 mt-[22px]">
        <h2 className="m-0 flex-1 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">Your models</h2>
        <button type="button" className={cn(outlineBtn, 'rounded-md')} onClick={() => setForm({ open: true })} aria-expanded={form.open && !form.editing}>
          + Add model
        </button>
      </div>
      <Rd className="mt-1.5">
        Run agents on a local model or a provider outside Anthropic. oIDE starts that agent's CLI with the endpoint's environment variables. Models must support tool use to work well as agents.
      </Rd>

      <ul className="list-none m-0 p-0 flex flex-col gap-2 mt-3" aria-label="Your models">
        {customs.map((m) => {
          const t = tests[m.id];
          const status = !t ? { text: 'Not tested', cls: 'text-ink-3' } : t.state === 'testing' ? { text: 'Testing…', cls: 'text-ink-3' } : t.ok ? { text: 'Connected', cls: 'text-ok' } : { text: `Failed: ${t.detail}`, cls: 'text-bad' };
          return (
            <li key={m.id} className="flex flex-col gap-2 px-3.5 py-3 rounded-lg border border-line-2 bg-card">
              <div className="flex items-center gap-2.5 flex-wrap">
                <span className="font-semibold">{m.name}</span>
                <span className="px-2 py-0.5 rounded-sm bg-selected text-[11.5px] text-ink-2">{PROVIDER_LABEL[m.provider]}</span>
                <span className={cn('text-[12px]', status.cls)} role="status" title={t?.state === 'done' ? t.detail : undefined}>
                  {status.text}
                </span>
                {m.hasKey && <span className="text-[12px] text-ink-3">Key stored</span>}
                <div className="flex-1" />
                <button type="button" className="h-7 px-2.5 rounded-sm border border-line-3 bg-transparent text-ink text-[12px] hover:bg-raised" onClick={() => void test(m.id)}>
                  Test connection
                </button>
                <button type="button" className="h-7 px-2.5 rounded-sm border-0 bg-transparent text-ink-3 text-[12px] hover:text-ink" onClick={() => setForm({ open: true, editing: m })} aria-label={`Edit ${m.name}`}>
                  Edit
                </button>
                <button type="button" className="h-7 px-2.5 rounded-sm border-0 bg-transparent text-ink-3 text-[12px] hover:text-ink" onClick={() => void remove(m)} aria-label={`Remove ${m.name}`}>
                  Remove
                </button>
              </div>
              <div className="font-mono text-[11.5px] leading-[1.7] text-ink-3 px-2.5 py-2 rounded-md bg-chrome">
                {envLines(m).map(([k, v]) => (
                  <div key={k}>
                    {k}=<span className="text-ink-2">{v}</span>
                  </div>
                ))}
              </div>
            </li>
          );
        })}
      </ul>

      {form.open && <CustomModelForm key={form.editing?.id ?? 'new'} editing={form.editing} onClose={() => setForm({ open: false })} />}
      <Rd className="mt-2.5">Your models show up next to Haiku, Sonnet, Opus and Fable in presets and in Spawn agent.</Rd>
    </>
  );
}
