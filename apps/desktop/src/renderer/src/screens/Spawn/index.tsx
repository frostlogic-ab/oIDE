/**
 * Spawn an agent (docs/wiki/raw/design/Spawn.dc.html), rendered as a dialog over the Wall
 * (`overlay: true` in screens/registry.tsx). Page: docs/wiki/pages/screen-spawn.md.
 *
 * Builds a protocol `AgentSpec` (spawnModel.buildSpec, Zod-validated), calls `agents.spawn`, then
 * returns to the Wall with the new tile(s) highlighted. Controls the detected CLI lacks are hidden.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { MODEL_FAMILIES, KNOWN_MODEL_VERSIONS, type InstalledExtension, type ModelFamily, type Technique } from '@oide/protocol';
import { Badge, Button, Checkbox, Dialog, Icon, Kbd, SegmentedControl, Select, TextArea, cn } from '@oide/ui';
import { invokeOr, ipcErrorMessage, isMac, oide } from '../../lib/bridge';
import { useKeymapScope } from '../../lib/useKeymap';
import { useAgents } from '../../stores/agents';
import { useCli } from '../../stores/cli';
import { useProjects } from '../../stores/projects';
import { navigate, useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { useSettings } from '../../stores/settings';
import { highlightTiles } from '../Wall/wallState';
import { CardRadioGroup } from './components/CardRadioGroup';
import { ContextChips } from './components/ContextChips';
import {
  CUSTOM_PREFIX,
  EFFORTS,
  MAX_ATTEMPTS,
  MODE_OPTIONS,
  PRESET_HINTS,
  STRATEGY_OPTIONS,
  WORK_IN_OPTIONS,
  applyVersions,
  availableEfforts,
  availableModes,
  availableStrategies,
  buildSpec,
  defaultExtensions,
  defaultModelFor,
  defaultTechniques,
  extensionRisk,
  familyOf,
  hasFeature,
  initialForm,
  matchPreset,
  modelFor,
  presetsOf,
  slotRows,
  slotVersion,
  slotsFromStrategy,
  strategySummary,
  type SlotKey,
  type SpawnField,
  type SpawnForm,
  type StrategyKind,
} from './spawnModel';

const LBL = 'text-[12px] font-semibold text-ink-2';

function closeToWall() {
  const { back, goBack, replace } = useRouter.getState();
  if (back[back.length - 1]?.screen === 'wall') goBack();
  else replace('wall');
}

function cancel() {
  const { back, goBack, navigate: nav } = useRouter.getState();
  if (back.length) goBack();
  else nav('wall');
}

export default function SpawnScreen() {
  const route = useRouter((s) => s.route);
  const params = useMemo(() => (route.screen === 'spawn' ? route.params : {}), [route]);
  const settings = useSettings((s) => s.settings);
  const projects = useProjects((s) => s.list);
  const scope = useScope((s) => s.scope);
  const cli = useCli((s) => s.info);

  const allowBypass = settings?.claude.allowBypass ?? false;
  const versions = settings?.models.versions ?? {};
  const customModels = settings?.models.custom ?? [];
  const presets = presetsOf(settings);

  const [form, setForm] = useState<SpawnForm>(() => initialForm({ settings, projects, scope, params, cli }));
  const touched = useRef(false);
  const [errors, setErrors] = useState<Partial<Record<SpawnField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [advOpen, setAdvOpen] = useState(true);
  const [techOpen, setTechOpen] = useState(false);
  const [techniques, setTechniques] = useState<Technique[]>(settings?.techniques ?? []);
  const [extensions, setExtensions] = useState<InstalledExtension[]>([]);
  const goalRef = useRef<HTMLTextAreaElement>(null);

  // Settings / projects may arrive after the dialog opened (cold start): re-derive until the user edits.
  useEffect(() => {
    if (touched.current) return;
    setForm((f) => {
      const next = initialForm({ settings, projects, scope, params, cli });
      // Keep what the async loaders below already filled in.
      return {
        ...next,
        techniques: Object.keys(f.techniques).length ? f.techniques : next.techniques,
        extensions: next.projectId === f.projectId ? f.extensions : next.extensions,
      };
    });
  }, [settings, projects, scope, params, cli]);

  // Techniques: global + the project's .oide/techniques.json.
  useEffect(() => {
    let cancelled = false;
    void invokeOr('settings.techniques', form.projectId ? { projectId: form.projectId } : {}, settings?.techniques ?? []).then(
      (list) => {
        if (cancelled) return;
        setTechniques(list);
        setForm((f) => ({ ...f, techniques: { ...defaultTechniques(list), ...pick(f.techniques, list.map((t) => t.id)) } }));
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [form.projectId, settings?.techniques]);

  // Extension tools offered to this agent, defaulting to the ones enabled for the project.
  useEffect(() => {
    let cancelled = false;
    void invokeOr('extensions.installed', undefined, []).then(
      (list) => {
        if (!cancelled) setExtensions(list);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => {
    setForm((f) => ({ ...f, extensions: defaultExtensions(extensions, f.projectId) }));
  }, [extensions, form.projectId]);

  const update = (patch: Partial<SpawnForm>) => {
    touched.current = true;
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(patch)) delete next[(k === 'kind' || k === 'slots' ? 'strategy' : k) as SpawnField];
      delete next.form;
      return next;
    });
  };
  const setSlot = (key: SlotKey, patch: Partial<SpawnForm['slots'][SlotKey]>) => update({ slots: { ...form.slots, [key]: { ...form.slots[key], ...patch } }, customPicked: false });

  const modes = availableModes(cli, allowBypass);
  const strategies = availableStrategies(cli);
  const efforts = availableEfforts(cli);
  const focus = form.customPicked ? 'custom' : matchPreset(form.kind, form.slots, presets);
  const toolsSupported = hasFeature(cli, 'mcp-config');
  const offeredExtensions = extensions.filter((e) => e.id in form.extensions);

  const submit = async () => {
    if (busy) return;
    const res = buildSpec(form, { allowBypass, customModels, techniqueOrder: techniques.map((t) => t.id) });
    if (!res.ok) {
      setErrors(res.errors);
      if (res.errors.goal) goalRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const created = await oide.invoke('agents.spawn', res.spec);
      const agents = useAgents.getState();
      for (const a of created) agents.applySummary(a);
      void useSettings
        .getState()
        .update({ models: { lastUsedStrategy: res.spec.strategy } })
        .catch(() => {});
      const sc = useScope.getState().scope;
      if (sc !== 'all' && sc !== res.spec.projectId) void useScope.getState().setScope(res.spec.projectId);
      closeToWall();
      highlightTiles(created.map((a) => a.id));
    } catch (err) {
      setErrors({ form: `Could not spawn: ${ipcErrorMessage(err)}` });
      setBusy(false);
    }
  };

  useKeymapScope('spawn', { 'composer.send': () => void submit() }, { modal: true });

  const goalId = useId();
  const modeLbl = useId();
  const focusLbl = useId();
  const stratLbl = useId();
  const parLbl = useId();
  const toolsLbl = useId();

  const spawnLabel = form.attempts === 1 ? 'Spawn agent' : `Spawn ${form.attempts} agents`;
  const projectFolder = form.workIn === 'project-folder';
  const noProjects = projects.length === 0;

  return (
    <Dialog
      open
      onClose={cancel}
      title="Spawn an agent"
      position="top"
      width={720}
      initialFocus={goalRef}
      className="max-h-[calc(100vh-80px)]!"
      footer={
        <div className="-mx-5 -my-4 px-5 py-3.5 flex-1 flex items-center gap-2.5 flex-wrap bg-panel">
          <span className="text-[12px] text-ink-3 flex items-center gap-1.5">
            Runs <span className="font-mono text-ink-2">claude</span> CLI in its own terminal
          </span>
          <div className="flex-1" />
          <Button size={36} className="h-[34px]!" onClick={cancel}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={busy || noProjects}
            aria-keyshortcuts={isMac() ? 'Meta+Enter' : 'Control+Enter'}
            className="h-[34px] px-4 rounded-md border-0 bg-accent text-on-accent font-semibold text-[13px] flex items-center gap-2 hover:brightness-110 disabled:opacity-50"
          >
            {busy ? 'Spawning…' : spawnLabel}
            <Kbd className="text-on-accent! border-[rgba(11,13,16,0.35)]!">{isMac() ? '⌘ ↵' : 'Ctrl ↵'}</Kbd>
          </button>
        </div>
      }
    >
      <form
        className="flex flex-col gap-[18px] px-5 py-[18px]"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        noValidate
      >
        {noProjects && (
          <Notice tone="warn">
            Open a project first. Agents run in a git worktree of a project.{' '}
            <button type="button" className="underline bg-transparent border-0 p-0 text-warn" onClick={() => void useProjects.getState().open().catch(() => {})}>
              Open project
            </button>
          </Notice>
        )}

        {/* Goal + context */}
        <div className="flex flex-col gap-2">
          <TextArea
            ref={goalRef}
            id={goalId}
            label="Goal"
            rows={3}
            value={form.goal}
            placeholder="What should the agent do? For example: Add a usage panel that opens from the status bar."
            onChange={(e) => update({ goal: e.target.value })}
            error={errors.goal}
          />
          <ContextChips value={form.context} onChange={(context) => update({ context })} projectId={form.projectId} />
        </div>

        {/* Project + Work in */}
        <div className="grid grid-cols-2 gap-3.5">
          <Select
            label="Project"
            size={36}
            surface="chrome"
            value={form.projectId}
            onChange={(e) => update({ projectId: e.target.value })}
            options={noProjects ? [{ value: '', label: 'No projects open' }] : projects.map((p) => ({ value: p.id, label: p.name }))}
            error={errors.projectId}
          />
          <Select
            label="Work in"
            size={36}
            surface="chrome"
            value={form.workIn}
            onChange={(e) => update({ workIn: e.target.value as SpawnForm['workIn'] })}
            options={WORK_IN_OPTIONS.map((o) =>
              o.value === 'project-folder' && form.mode === 'bypassPermissions' ? { ...o, label: `${o.label} (not with Bypass)`, disabled: true } : o,
            )}
            error={errors.workIn}
            hint={projectFolder ? 'Only one agent at a time can work in the project folder.' : undefined}
          />
        </div>

        {/* Mode */}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2.5">
            <span id={modeLbl} className={cn(LBL, 'flex-1')}>
              Mode
            </span>
            <span className="text-[12px] text-ink-3">Shift + Tab switches mode on a running agent</span>
          </div>
          <CardRadioGroup
            labelledBy={modeLbl}
            value={form.mode}
            onChange={(mode) => update({ mode })}
            options={MODE_OPTIONS.filter((m) => modes.includes(m.mode)).map((m) => {
              const bypass = m.mode === 'bypassPermissions';
              return {
                value: m.mode,
                label: m.label,
                desc: bypass && projectFolder ? 'Not in the project folder.' : m.desc,
                danger: bypass,
                disabled: bypass && projectFolder,
              };
            })}
          />
          {form.mode === 'bypassPermissions' && (
            <div role="alert" className="flex gap-2.5 items-start px-3 py-2.5 rounded-lg border border-[#6B3434] bg-[#241517] text-bad-bright text-[12.5px] leading-[1.45]">
              <Icon name="warning" size={16} className="mt-px" />
              <span>Claude will not ask before running potentially dangerous commands. Keep this agent in its own worktree and avoid it on projects with production credentials.</span>
            </div>
          )}
          {errors.mode && <FieldError>{errors.mode}</FieldError>}
        </div>

        {/* Models */}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <span id={focusLbl} className={LBL}>
              Models
            </span>
            <span className="flex-1 text-right text-[12px] text-ink-3">{strategySummary(form.kind, form.slots, customModels, efforts.length > 0)}</span>
            <NavLink onClick={() => navigate('settings', { section: 'models' })}>Edit presets</NavLink>
          </div>
          <CardRadioGroup
            labelledBy={focusLbl}
            size="sm"
            value={focus}
            onChange={(id) => {
              if (id === 'custom') {
                setAdvOpen(true);
                update({ customPicked: true });
                return;
              }
              const p = presets.find((x) => x.id === id);
              if (p) update({ kind: p.strategy.kind, slots: applyVersions(slotsFromStrategy(p.strategy, form.slots), versions), customPicked: false });
            }}
            options={[
              ...presets.map((p) => ({ value: p.id, label: p.name, desc: PRESET_HINTS[p.id] ?? p.description, disabled: !strategies.includes(p.strategy.kind) })),
              { value: 'custom', label: 'Custom', desc: 'Your own mix, set under Advanced.' },
            ]}
            columns={Math.min(4, presets.length + 1)}
          />

          <button
            type="button"
            aria-expanded={advOpen}
            aria-controls="spawn-adv"
            onClick={() => setAdvOpen((o) => !o)}
            className="self-start h-[30px] pl-1 pr-2 border-0 rounded-sm bg-transparent text-ink-2 text-[12.5px] flex items-center gap-1.5 hover:bg-raised"
          >
            <Icon name="chevron-right" size={16} className={cn('transition-transform', advOpen && 'rotate-90')} />
            Advanced model settings
          </button>

          {advOpen && (
            <div id="spawn-adv" className="flex flex-col gap-3.5 p-3.5 rounded-xl border border-line-2 bg-panel">
              <div className="flex flex-col gap-2">
                <span id={stratLbl} className={LBL}>
                  How agents pick models
                </span>
                <CardRadioGroup<StrategyKind>
                  labelledBy={stratLbl}
                  value={form.kind}
                  onChange={(kind) => update({ kind, customPicked: false })}
                  options={STRATEGY_OPTIONS.filter((s) => strategies.includes(s.kind)).map((s) => ({ value: s.kind, label: s.label, desc: s.desc }))}
                />
              </div>
              <div className="flex flex-col gap-2">
                {/* One grid for every slot row: the pill groups share a column (sized to the
                    widest, the orchestrator's with custom models) so the effort selects line up. */}
                <div className={MODEL_GRID}>
                {slotRows(form.kind).map((r) => (
                  <ModelRow
                    key={r.key}
                    label={r.label}
                    slot={form.slots[r.key]}
                    allowCustom={r.key === 'lead'}
                    efforts={efforts}
                    versions={versions}
                    customModels={customModels}
                    onChange={(patch) => setSlot(r.key, patch)}
                  />
                ))}
                </div>
                <VersionsRow slots={form.slots} keys={slotRows(form.kind).map((r) => r.key)} onChange={(slots) => update({ slots })} />
                {form.kind === 'routed' && (
                  <span className="text-[12px] text-ink-3 leading-[1.45]">
                    The orchestrator rates each subagent task as simple, standard or complex, and starts it on the model you picked for that level.
                  </span>
                )}
              </div>
              <span className="text-[12px] text-ink-3 leading-[1.45] pt-2.5 border-t border-line-6">
                Picking a focus preset resets these. Changing them so they no longer match a preset switches the focus to Custom.
              </span>
            </div>
          )}
        </div>

        {/* Advanced techniques */}
        {techniques.length > 0 && (
          <TechniquesSection
            techniques={techniques}
            on={form.techniques}
            open={techOpen}
            onToggleOpen={() => setTechOpen((o) => !o)}
            onToggle={(id) => update({ techniques: { ...form.techniques, [id]: !form.techniques[id] } })}
            systemPromptSupported={hasFeature(cli, 'append-system-prompt')}
          />
        )}

        {/* Parallel attempts */}
        <div className="flex flex-col gap-2">
          <span id={parLbl} className={LBL}>
            Parallel attempts
          </span>
          <div role="group" aria-labelledby={parLbl} className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Fewer attempts"
              disabled={form.attempts <= 1}
              onClick={() => update({ attempts: Math.max(1, form.attempts - 1) })}
              className="w-9 h-9 rounded-md border border-line-3 bg-transparent text-ink text-[16px] hover:bg-raised disabled:opacity-40"
            >
              −
            </button>
            <span className="font-mono w-7 text-center text-[15px]" aria-live="polite" aria-label={`${form.attempts} ${form.attempts === 1 ? 'attempt' : 'attempts'}`}>
              {form.attempts}
            </span>
            <button
              type="button"
              aria-label="More attempts"
              disabled={form.attempts >= MAX_ATTEMPTS}
              onClick={() => update({ attempts: Math.min(MAX_ATTEMPTS, form.attempts + 1) })}
              className="w-9 h-9 rounded-md border border-line-3 bg-transparent text-ink text-[16px] hover:bg-raised disabled:opacity-40"
            >
              +
            </button>
            <span className="text-[12px] text-ink-3 leading-[1.4]">{form.attempts === 1 ? 'One agent' : `${form.attempts} agents try the same goal in separate worktrees; keep the best`}</span>
          </div>
          {errors.attempts && <FieldError>{errors.attempts}</FieldError>}
        </div>

        {/* Tools from extensions */}
        {toolsSupported && (
          <div className="flex flex-col gap-2">
            <span id={toolsLbl} className={LBL}>
              Tools from extensions
            </span>
            <div className="flex gap-1.5 flex-wrap" role="group" aria-labelledby={toolsLbl}>
              {offeredExtensions.map((ext) => {
                const risk = extensionRisk(ext);
                return (
                  <Checkbox
                    key={ext.id}
                    variant="pill"
                    checked={form.extensions[ext.id] ?? false}
                    onChange={(on) => update({ extensions: { ...form.extensions, [ext.id]: on } })}
                    label={
                      <span className="inline-flex items-center gap-1.5">
                        {ext.displayName}
                        {risk === 'ask' ? <span className="text-[10.5px] text-warn">asks first</span> : risk === 'read' ? <span className="text-[10.5px] text-ink-3">read only</span> : null}
                      </span>
                    }
                  />
                );
              })}
              <a
                href="#marketplace"
                onClick={(e) => {
                  e.preventDefault();
                  navigate('marketplace', {});
                }}
                className="flex items-center h-[30px] px-2.5 rounded-md border border-dashed border-line-hover text-[12.5px] text-ink-2 no-underline box-border hover:text-ink"
              >
                + Find more in Marketplace
              </a>
            </div>
            {offeredExtensions.some((e) => form.extensions[e.id] && extensionRisk(e) === 'ask') && (
              <span className="text-[12px] text-ink-3 leading-[1.45]">Tools marked asks first always ask you before they run, whatever the mode.</span>
            )}
          </div>
        )}

        {errors.form && <Notice tone="bad">{errors.form}</Notice>}
        {errors.strategy && <Notice tone="bad">{errors.strategy}</Notice>}
      </form>
    </Dialog>
  );
}

function pick(rec: Record<string, boolean>, ids: string[]): Record<string, boolean> {
  return Object.fromEntries(ids.filter((id) => id in rec).map((id) => [id, rec[id]!]));
}

function FieldError({ children }: { children: ReactNode }) {
  return (
    <span className="text-[12px] text-bad" role="alert">
      {children}
    </span>
  );
}

function Notice({ tone, children }: { tone: 'warn' | 'bad'; children: ReactNode }) {
  return (
    <div
      role="alert"
      className={cn(
        'px-3 py-2.5 rounded-lg border text-[12.5px] leading-[1.45]',
        tone === 'warn' ? 'border-warn-line bg-warn-bg text-warn' : 'border-bad-line bg-bad-bg text-bad-bright',
      )}
    >
      {children}
    </div>
  );
}

function NavLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <a
      href="#settings"
      className="text-[12px] underline underline-offset-2"
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      {children}
    </a>
  );
}

const SELECT = 'h-8 px-2 rounded-md border border-line-3 bg-chrome text-ink text-[12px] outline-none focus:border-accent';
/** Label · model pills · effort, one shared grid (rows are subgrids). */
const MODEL_GRID = 'grid grid-cols-[160px_max-content_max-content] items-center gap-x-2.5 gap-y-2';
const MODEL_ROW = 'grid grid-cols-subgrid col-span-3 items-center justify-items-start';

function ModelRow({
  label,
  slot,
  allowCustom,
  efforts,
  versions,
  customModels,
  onChange,
}: {
  label: string;
  slot: SpawnForm['slots'][SlotKey];
  allowCustom: boolean;
  efforts: string[];
  versions: Record<string, string>;
  customModels: Array<{ id: string; name: string }>;
  onChange: (patch: Partial<SpawnForm['slots'][SlotKey]>) => void;
}) {
  const isCustom = slot.model.startsWith(CUSTOM_PREFIX);
  const family = isCustom ? undefined : familyOf(slot.model);
  const value = isCustom ? slot.model : (family ?? slot.model);
  const options = [
    ...MODEL_FAMILIES.map((f) => ({ value: f as string, label: f[0]!.toUpperCase() + f.slice(1) })),
    ...(allowCustom ? customModels.map((c) => ({ value: CUSTOM_PREFIX + c.id, label: c.name })) : []),
  ];
  if (!options.some((o) => o.value === value)) options.push({ value, label: slot.model });
  return (
    <div role="group" aria-label={label} className={MODEL_ROW}>
      <span className="text-[12.5px] text-ink-2">{label}</span>
      <SegmentedControl
        label={`${label}: model`}
        variant="inset"
        value={value}
        options={options}
        onChange={(v) => {
          const fam = familyOf(v);
          onChange({ model: !v.startsWith(CUSTOM_PREFIX) && fam ? defaultModelFor(fam, versions) : v });
        }}
      />
      {efforts.length > 0 && (
        <select aria-label={`${label} effort`} value={slot.effort ?? ''} onChange={(e) => onChange({ effort: (e.target.value || undefined) as typeof slot.effort })} className={SELECT}>
          {!slot.effort && <option value="">Effort: Default</option>}
          {EFFORTS.filter((e) => efforts.includes(e.value)).map((e) => (
            <option key={e.value} value={e.value}>
              {e.label}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/**
 * "Model versions": one select per model family the slots use. "Latest" passes the family alias to
 * `--model` (follows new releases); a version pins the exact model id for this agent.
 */
function VersionsRow({ slots, keys, onChange }: { slots: SpawnForm['slots']; keys: SlotKey[]; onChange: (slots: SpawnForm['slots']) => void }) {
  const families = [...new Set(keys.map((k) => (slots[k].model.startsWith(CUSTOM_PREFIX) ? undefined : familyOf(slots[k].model))).filter((f): f is ModelFamily => !!f))];
  if (!families.length) return null;
  return (
    <div role="group" aria-label="Model versions" className="flex items-center gap-2.5 flex-wrap">
      <span className="w-40 text-[12.5px] text-ink-2">Model versions</span>
      {families.map((fam) => {
        const first = keys.find((k) => familyOf(slots[k].model) === fam)!;
        const label = fam[0]!.toUpperCase() + fam.slice(1);
        return (
          <label key={fam} className="flex items-center gap-1.5 text-[12px] text-ink-3">
            {label}
            <select
              value={slotVersion(slots[first].model)}
              onChange={(e) => {
                const next = { ...slots };
                for (const k of keys) if (!next[k].model.startsWith(CUSTOM_PREFIX) && familyOf(next[k].model) === fam) next[k] = { ...next[k], model: modelFor(fam, e.target.value) };
                onChange(next);
              }}
              className={SELECT}
            >
              <option value="latest">Latest</option>
              {KNOWN_MODEL_VERSIONS[fam].map((v) => (
                <option key={v.id} value={v.version}>
                  {v.version} (pinned)
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}

function TechniquesSection({
  techniques,
  on,
  open,
  onToggleOpen,
  onToggle,
  systemPromptSupported,
}: {
  techniques: Technique[];
  on: Record<string, boolean>;
  open: boolean;
  onToggleOpen: () => void;
  onToggle: (id: string) => void;
  systemPromptSupported: boolean;
}) {
  const count = techniques.filter((t) => on[t.id]).length;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls="spawn-tech"
        onClick={onToggleOpen}
        className="self-stretch h-[34px] pl-1 pr-2.5 border-0 rounded-sm bg-transparent text-ink text-[13px] font-semibold flex items-center gap-1.5 text-left hover:bg-raised"
      >
        <Icon name="chevron-right" size={16} className={cn('transition-transform', open && 'rotate-90')} />
        <span className="flex-1">Advanced techniques</span>
        <span className={cn('text-[12px] font-normal', count ? 'text-ok' : 'text-ink-3')}>{count === 0 ? 'None on' : `${count} of ${techniques.length} on`}</span>
      </button>
      {open && (
        <div id="spawn-tech" className="flex flex-col gap-2.5 p-3.5 rounded-xl border border-line-2 bg-panel">
          <span className="text-[12px] text-ink-3 leading-[1.45]">
            Each one adds instructions to the agent's prompt when it starts. You don't see them in the goal, but they show in the agent's first message.
          </span>
          {techniques.map((t) => {
            const enabled = !!on[t.id];
            const unsupported = t.placement === 'system-prompt' && !systemPromptSupported;
            return (
              <div key={t.id} className={cn('flex flex-col gap-2 px-3 py-2.5 rounded-lg border bg-card', enabled ? 'border-line-3' : 'border-line-2')}>
                <div className="flex items-start gap-2">
                  <Checkbox
                    checked={enabled}
                    disabled={unsupported}
                    onChange={() => onToggle(t.id)}
                    label={<span className="font-semibold">{t.name}</span>}
                    description={unsupported ? 'This CLI has no --append-system-prompt flag.' : t.description}
                    className="flex-1"
                  />
                  <Badge tone="neutral" title={t.placement === 'first-message' ? 'Appended to the first message' : 'Passed with --append-system-prompt'}>
                    {t.placement === 'first-message' ? 'First message' : 'System prompt'}
                  </Badge>
                </div>
                {enabled && <div className="ml-[26px] px-2.5 py-2 rounded-md bg-chrome font-mono text-[11.5px] leading-[1.6] text-ink-code whitespace-pre-wrap">{t.text}</div>}
              </div>
            );
          })}
          <NavLink onClick={() => navigate('settings', { section: 'techniques' })}>Edit the text or add your own techniques in Settings</NavLink>
        </div>
      )}
    </div>
  );
}
