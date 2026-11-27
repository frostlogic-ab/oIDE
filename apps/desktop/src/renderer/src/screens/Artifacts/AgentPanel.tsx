/**
 * The open view's Agent panel (left of the preview): the artifact's own agent, which edits, adds and
 * deletes this artifact's files (and only this artifact's) through oIDE's MCP artifact tools. Each
 * change it makes is a new version the Viewer picks up like any agent write.
 *
 * - No agent yet: a short intro, mode / model / effort pickers and a composer; the first message
 *   starts it (`artifacts.startAgent`; `needs_project` asks which project it runs under).
 * - With an agent (the newest live summary whose `artifactId` is this artifact): status, the context
 *   ring with Compact, model / effort (`agents.setModel`, from the next message), mode, Stop, Open in
 *   Focus and New conversation (archives it, so the next message starts a fresh one), then Focus's
 *   own transcript, permission prompt and composer.
 * - Feedback: the preview comments (point and comment), sent together with "Send N to agent".
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { MODEL_FAMILIES, type AgentSummary, type ArtifactMeta, type Effort, type ModelSlot, type PermissionMode, type Settings, type SubagentInfo, type UserMessage } from '@oide/protocol';
import { Button, Checkbox, ContextRingButton, IconButton, Menu, Icon, Select, StatusDot, StatusLabel, agentStatusMeta, contextFraction, contextTooltip, modelFamily, cn } from '@oide/ui';
import { AttachFileButton, AttachmentTray, useAttachments } from '../../components/Attachments';
import { ResizableAside } from '../../components/ResizableAside';
import { invokeOr, ipcErrorCode, ipcErrorMessage, oide } from '../../lib/bridge';
import { PANELS } from '../../lib/panels';
import { trackArtifactAgentMessage } from '../../lib/telemetry';
import { useAgents } from '../../stores/agents';
import { archiveAgent } from '../../stores/archive';
import { useCli } from '../../stores/cli';
import { useProjects } from '../../stores/projects';
import { navigate } from '../../stores/router';
import { useSettings } from '../../stores/settings';
import { toast } from '../../stores/ui';
import { CompactDialog } from '../Focus/components/CompactDialog';
import { Composer } from '../Focus/components/Composer';
import { PermissionPrompt } from '../Focus/components/PermissionPrompt';
import type { RowContext } from '../Focus/components/rows';
import { Streaming } from '../Focus/components/Streaming';
import { Transcript } from '../Focus/components/Transcript';
import { clearDraft, getDraft } from '../Focus/composerDrafts';
import { DEFAULT_SLASH_COMMANDS, MODE_LABEL, modeChoices, nextMode, type ModeChoice, type ModeOptions } from '../Focus/model/focus';
import { loadOlder, useFocusHistory, useTranscriptHistory } from '../Focus/model/history';
import { buildRows, eventsFor, groupByParent, reportedSlashCommands } from '../Focus/model/transcript';
import { EFFORTS, FALLBACK_PRESETS, availableEfforts, defaultModelFor, familyOf, presetsOf } from '../Spawn/spawnModel';
import { useArtifactFeedback, usePins } from './feedbackStore';
import { artifactAgentOf, buildFeedbackMessage, isAgentWorking, pinWhere, type FeedbackPin } from './model';

const EMPTY_SUBS: Record<string, SubagentInfo> = {};
const SELECT = 'h-7 max-w-full px-1.5 rounded-md border border-line-3 bg-chrome text-ink text-[12px] outline-none focus:border-accent disabled:opacity-50';
const MODEL_HINT = 'Model and effort apply from the next message.';

export const AGENT_INTRO = "Tell an agent what to change. It can edit, add and delete this artifact's files; each change is a new version you can compare or restore.";

/** The artifact's live agent from the agents store (newest when there are several). */
export function useArtifactAgent(artifactId: string): AgentSummary | undefined {
  const byId = useAgents((s) => s.byId);
  return useMemo(() => artifactAgentOf(Object.values(byId), artifactId), [byId, artifactId]);
}

function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Bypass is allowed where main accepts it: an artifact agent works in its own folder, never a repo. */
function inWorktreeOf(agent: AgentSummary | undefined): boolean {
  if (!agent) return true;
  return agent.workIn ? agent.workIn !== 'project-folder' : !!agent.worktreePath;
}

/** The modes the agent can use (Focus's `modeChoices`) and the options Shift+Tab cycles with. */
function useModeChoices(agent: AgentSummary | undefined): { modes: readonly ModeChoice[]; opts: ModeOptions } {
  const allowBypass = useSettings((s) => s.settings?.claude.allowBypass ?? false);
  const hasAuto = useCli((s) => s.info?.features['mode:auto']);
  const inWorktree = inWorktreeOf(agent);
  return useMemo(() => {
    const opts = { allowBypass, inWorktree, hasAuto: hasAuto !== false };
    return { modes: modeChoices(opts), opts };
  }, [allowBypass, inWorktree, hasAuto]);
}

const fail = (err: unknown) => toast(ipcErrorMessage(err), 'error');

/** The lead model and effort a new agent starts with: the project's (or the default) focus preset, as Spawn picks it. */
export function defaultLeadSlot(settings: Settings | null, presetId?: string): ModelSlot {
  const presets = presetsOf(settings);
  const wanted = presetId ?? settings?.models.defaultPresetId ?? 'balanced';
  const lead = (presets.find((p) => p.id === wanted) ?? presets[0] ?? FALLBACK_PRESETS[1]!).strategy.lead;
  const fam = familyOf(lead.model);
  // A custom model ("Your models") needs Spawn's own setup: the artifact agent starts on the family default.
  if (!fam) return { model: defaultModelFor('opus', settings?.models.versions), effort: lead.effort };
  return { model: lead.model.toLowerCase() === fam ? defaultModelFor(fam, settings?.models.versions) : lead.model, effort: lead.effort };
}

/* ------------------------------------------------------------------ pickers */

function ModelPickers({ slot, onChange, disabled, hintId }: { slot: ModelSlot; onChange: (slot: ModelSlot) => void; disabled?: boolean; hintId: string }) {
  const versions = useSettings((s) => s.settings?.models.versions);
  const cli = useCli((s) => s.info);
  const efforts = availableEfforts(cli);
  const fam = familyOf(slot.model);
  if (!fam)
    return (
      <span className="text-[12px] text-ink-3 truncate" title={`Model: ${slot.model}`}>
        {slot.model}
      </span>
    );
  return (
    <>
      <select
        aria-label="Model"
        aria-describedby={hintId}
        title={MODEL_HINT}
        value={fam}
        disabled={disabled}
        onChange={(e) => {
          const next = familyOf(e.target.value);
          if (next) onChange({ ...slot, model: defaultModelFor(next, versions) });
        }}
        className={SELECT}
      >
        {MODEL_FAMILIES.map((f) => (
          <option key={f} value={f}>
            {f[0]!.toUpperCase() + f.slice(1)}
          </option>
        ))}
      </select>
      {efforts.length > 0 && (
        <select
          aria-label="Effort"
          aria-describedby={hintId}
          title={MODEL_HINT}
          value={slot.effort ?? ''}
          disabled={disabled}
          onChange={(e) => onChange({ ...slot, effort: (e.target.value || undefined) as Effort | undefined })}
          className={SELECT}
        >
          {!slot.effort && <option value="">Effort: Default</option>}
          {EFFORTS.filter((x) => efforts.includes(x.value)).map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

function ModePicker({ mode, modes, onChange, disabled }: { mode: PermissionMode; modes: readonly ModeChoice[]; onChange: (mode: PermissionMode) => void; disabled?: boolean }) {
  return (
    <select aria-label="Permission mode" value={mode} disabled={disabled} onChange={(e) => onChange(e.target.value as PermissionMode)} className={SELECT}>
      {modes.map((c) => (
        <option key={c.mode} value={c.mode} disabled={!!c.disabled} title={c.disabled?.reason}>
          {MODE_LABEL[c.mode]}
          {c.disabled ? ` (${c.disabled.hint})` : ''}
        </option>
      ))}
    </select>
  );
}

/* ------------------------------------------------------------------ feedback tray */

export function FeedbackTray({ artifactId, pins, onSend, sending, disabledReason }: { artifactId: string; pins: readonly FeedbackPin[]; onSend: () => void; sending: boolean; disabledReason?: string }) {
  const titleId = useId();
  const reasonId = useId();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const store = useArtifactFeedback.getState;
  if (!pins.length) return null;
  const count = pins.filter((p) => p.checked && p.comment.trim()).length;
  const blocked = disabledReason ?? (count === 0 ? 'Tick at least one comment to send.' : undefined);
  return (
    <section aria-labelledby={titleId} className="flex flex-col rounded-lg border border-line-2 bg-card min-h-0">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line-2">
        <h4 id={titleId} className="m-0 text-[12.5px] font-semibold text-ink">
          Feedback
        </h4>
        <span className="text-[11.5px] text-ink-3">
          {pins.length} {pins.length === 1 ? 'comment' : 'comments'}
        </span>
        <span className="flex-1" />
        <Button size={28} variant="primary" onClick={onSend} disabled={!!blocked || sending} aria-describedby={blocked ? reasonId : undefined} title={blocked}>
          {sending ? 'Sending…' : `Send ${count} to agent`}
        </Button>
        {blocked && (
          <span id={reasonId} className="sr-only">
            {blocked}
          </span>
        )}
      </div>
      <ul className="m-0 p-0 list-none max-h-[220px] overflow-auto">
        {pins.map((p) => (
          <li key={p.id} className="flex items-start gap-2 px-3 py-2 border-b border-line-2 last:border-b-0">
            <Checkbox checked={p.checked} onChange={(v) => store().update(artifactId, p.id, { checked: v })} label={<span className="sr-only">Send comment {p.n}</span>} className="mt-0.5" />
            <span aria-hidden="true" className="mt-px w-[18px] h-[18px] shrink-0 rounded-full bg-accent text-on-accent text-[10.5px] font-semibold flex items-center justify-center">
              {p.n}
            </span>
            <div className="flex-1 min-w-0 flex flex-col gap-0.5 text-[12px]">
              <span className="font-mono text-[11px] text-ink-3 truncate" title={pinWhere(p)}>
                <span className="sr-only">Comment {p.n} on </span>
                {pinWhere(p)}
              </span>
              {p.text && <span className="text-ink-3 truncate">&ldquo;{p.text}&rdquo;</span>}
              {editing?.id === p.id ? (
                <div className="flex flex-col gap-1.5 mt-1">
                  <label className="sr-only" htmlFor={`${titleId}-${p.id}`}>
                    Edit comment {p.n}
                  </label>
                  <textarea
                    id={`${titleId}-${p.id}`}
                    rows={2}
                    maxLength={2000}
                    autoFocus
                    value={editing.text}
                    onChange={(e) => setEditing({ id: p.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.preventDefault();
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                    className="resize-none rounded-md border border-line-3 bg-chrome text-ink text-[12px] px-2 py-1 outline-none focus:border-accent"
                  />
                  <div className="flex gap-1.5">
                    <Button
                      size={28}
                      variant="primary"
                      disabled={!editing.text.trim()}
                      onClick={() => {
                        store().update(artifactId, p.id, { comment: editing.text.trim() });
                        setEditing(null);
                      }}
                    >
                      Save
                    </Button>
                    <Button size={28} variant="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </Button>
                  </div>
                </div>
              ) : (
                <span className="text-ink whitespace-pre-wrap break-words">{p.comment}</span>
              )}
            </div>
            {editing?.id !== p.id && (
              <div className="flex items-center gap-0.5 shrink-0">
                <button type="button" aria-label={`Edit comment ${p.n}`} onClick={() => setEditing({ id: p.id, text: p.comment })} className="h-6 px-1.5 rounded-sm border-0 bg-transparent text-link text-[11.5px] hover:bg-raised">
                  Edit
                </button>
                <IconButton icon="close" size={28} iconSize={13} aria-label={`Remove comment ${p.n}`} onClick={() => store().remove(artifactId, [p.id])} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/* ------------------------------------------------------------------ panel */

export interface AgentPanelProps {
  meta: ArtifactMeta;
  /** The version shown (the feedback message names it). */
  version: number;
  onCollapse: () => void;
}

export function AgentPanel({ meta, version, onCollapse }: AgentPanelProps) {
  const agent = useArtifactAgent(meta.id);
  return (
    <ResizableAside panel={PANELS.artifactsAgent} aria-label="Agent" className="@container min-h-0 flex flex-col bg-panel border-r border-line box-border">
      {agent ? <AgentSession key={agent.id} agent={agent} meta={meta} version={version} onCollapse={onCollapse} /> : <StartAgent meta={meta} version={version} onCollapse={onCollapse} />}
    </ResizableAside>
  );
}

/** The collapsed panel: a strip with the show button and the agent's status dot. */
export function AgentPanelStrip({ meta, onExpand }: { meta: ArtifactMeta; onExpand: () => void }) {
  const agent = useArtifactAgent(meta.id);
  const pins = usePins(meta.id);
  return (
    <div className="w-10 shrink-0 flex flex-col items-center gap-2 py-2 bg-panel border-r border-line">
      <IconButton icon="chevron-right" aria-label="Show the agent panel" title="Show the agent panel" onClick={onExpand} />
      {agent && (
        <span className="flex items-center justify-center" title={`Agent: ${agentStatusMeta(agent.status).label}`}>
          <StatusDot status={agent.status} size={8} />
          <span className="sr-only">Agent: {agentStatusMeta(agent.status).label}</span>
        </span>
      )}
      {pins.length > 0 && (
        <span className="text-[10.5px] text-ink-3" title={`${pins.length} comments not sent`}>
          {pins.length}
        </span>
      )}
    </div>
  );
}

function PanelHeader({ children, onCollapse }: { children?: ReactNode; onCollapse: () => void }) {
  return (
    <div className="flex items-center gap-2 h-11 px-3 border-b border-line shrink-0 min-w-0">
      <h3 className="m-0 text-[13px] font-semibold text-ink shrink-0">Agent</h3>
      {children}
      <span className="flex-1" />
      <IconButton icon="chevron-left" aria-label="Hide the agent panel" title="Hide the agent panel" onClick={onCollapse} />
    </div>
  );
}

/** Send the checked pins (and the composer's text) as one message; shared by both panel states. */
function useFeedbackSend(meta: ArtifactMeta, version: number) {
  const pins = usePins(meta.id);
  const message = (text: string) => {
    const checked = pins.filter((p) => p.checked && p.comment.trim());
    return { checked, text: buildFeedbackMessage({ title: meta.title, version, pins: checked, text }) };
  };
  return { pins, message };
}

function AgentSession({ agent, meta, version, onCollapse }: { agent: AgentSummary; meta: ArtifactMeta; version: number; onCollapse: () => void }) {
  useTranscriptHistory(agent.id);
  const events = useFocusHistory((s) => s.events);
  const hasMore = useFocusHistory((s) => s.hasMore);
  const loading = useFocusHistory((s) => s.loading);
  const now = useNow();
  const warnAt = useSettings((s) => s.settings?.agents.contextWarnAt);
  const dangerAt = useSettings((s) => s.settings?.agents.contextSuggestCompactAt);
  const projects = useProjects((s) => s.list);
  const projectName = projects.find((p) => p.id === agent.projectId)?.name ?? agent.projectId;
  const { modes, opts: modeOpts } = useModeChoices(agent);
  const [compactOpen, setCompactOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const hintId = useId();
  const { pins, message } = useFeedbackSend(meta, version);

  const subs = useMemo(() => Object.fromEntries(agent.subagents.map((s) => [s.id, s])) as Record<string, SubagentInfo>, [agent.subagents]);
  const subEvents = useMemo(() => groupByParent(events), [events]);
  const leadEvents = useMemo(() => eventsFor(events), [events]);
  const rows = useMemo(() => buildRows(leadEvents), [leadEvents]);
  const commands = useMemo(() => reportedSlashCommands(leadEvents) ?? [...DEFAULT_SLASH_COMMANDS], [leadEvents]);
  const pending = agent.pendingPermission;
  const ctx = useMemo<RowContext>(
    () => ({
      agentId: agent.id,
      subagents: agent.subagents.length ? subs : EMPTY_SUBS,
      subEvents,
      pendingToolUseId: pending?.toolUseId,
      now,
      onOpenSubagent: (id) => navigate('focus', { agentId: agent.id, subagentId: id }),
      onOpenReview: () => navigate('review', { agentId: agent.id }),
    }),
    [agent.id, agent.subagents.length, subs, subEvents, pending?.toolUseId, now],
  );

  const setMode = useCallback((mode: PermissionMode) => void oide.invoke('agents.setMode', { agentId: agent.id, mode }).catch(fail), [agent.id]);
  const setModel = (slot: ModelSlot) =>
    void oide.invoke('agents.setModel', { agentId: agent.id, model: slot.model, ...(slot.effort ? { effort: slot.effort } : {}) }).then(
      () => toast(`${modelFamily(slot.model)}${slot.effort ? ` (${slot.effort})` : ''} from the next message.`, 'info'),
      fail,
    );
  const doCompact = () => {
    setCompactOpen(false);
    oide.invoke('agents.compact', { agentId: agent.id }).then(() => toast(`Sent /compact to ${agent.title}. Compacting…`, 'info'), fail);
  };
  const working = isAgentWorking(agent.status);
  const queued = agent.status === 'queued';
  const used = contextFraction(agent.contextUsed, agent.contextWindow);

  const sendFeedback = async () => {
    const typed = getDraft(agent.id).trim();
    const { checked, text } = message(typed);
    if (!checked.length || sending) return;
    setSending(true);
    try {
      await oide.invoke('agents.send', { agentId: agent.id, message: { kind: 'text', text } });
      useArtifactFeedback.getState().remove(meta.id, checked.map((p) => p.id));
      if (typed) clearDraft(agent.id, true);
      trackArtifactAgentMessage(meta.kind, checked.length, typed !== '');
    } catch (err) {
      fail(err);
    } finally {
      setSending(false);
    }
  };
  const onSent = (m: UserMessage) => trackArtifactAgentMessage(meta.kind, 0, m.kind === 'text' || m.kind === 'command' || (m.kind === 'artifact' && !!m.note));

  return (
    <>
      <PanelHeader onCollapse={onCollapse}>
        <StatusLabel status={agent.status} className="text-[11.5px] min-w-0 truncate" />
        <span className="flex-1" />
        <IconButton icon="external-link" aria-label="Open in Focus" title="Open in Focus" onClick={() => navigate('focus', { agentId: agent.id })} />
        <Menu
          label="More agent actions"
          align="end"
          portal
          trigger={<Icon name="more" size={16} />}
          triggerClassName="h-7 w-7 rounded-sm border-0 bg-transparent text-ink-3 hover:bg-raised hover:text-ink"
          items={[
            {
              id: 'new',
              label: 'New conversation',
              icon: 'plus',
              disabled: working,
              title: working ? 'Stop the agent first, or wait until it is done.' : 'Archives this agent; your next message starts a new one.',
              onSelect: () => void archiveAgent(agent.id, agent.title).then((ok) => ok && useAgents.getState().remove(agent.id)),
            },
          ]}
        />
      </PanelHeader>
      <div role="group" aria-label="Agent settings" className="flex flex-wrap items-center gap-1.5 px-3 py-2 border-b border-line shrink-0">
        <ContextRingButton
          variant="header"
          used={used}
          warnAt={warnAt}
          dangerAt={dangerAt}
          tooltip={contextTooltip({ used: agent.contextUsed, window: agent.contextWindow, baseline: agent.contextBaseline, suffix: 'click to /compact this session' })}
          onClick={() => setCompactOpen(true)}
          className="!h-7 shrink-0"
        />
        <ModelPickers slot={{ model: agent.model, ...(agent.effort ? { effort: agent.effort } : {}) }} onChange={setModel} hintId={hintId} />
        <ModePicker mode={agent.mode} modes={modes} onChange={(m) => m !== agent.mode && setMode(m)} />
        {working && (
          <Button size={28} variant="danger" className="!h-7" onClick={() => void oide.invoke('agents.stop', { agentId: agent.id }).catch(fail)}>
            Stop
          </Button>
        )}
        <span id={hintId} className="sr-only">
          {MODEL_HINT}
        </span>
      </div>
      <Transcript
        rows={rows}
        ctx={ctx}
        resetKey={agent.id}
        hasMore={hasMore}
        loading={loading}
        onLoadOlder={() => void loadOlder()}
        footer={<Streaming agentId={agent.id} />}
        label="Agent transcript"
      />
      <div className="flex flex-col gap-2 px-3 pb-3 pt-1 shrink-0">
        {pending && <PermissionPrompt agentId={agent.id} request={pending} projectName={projectName} />}
        <FeedbackTray artifactId={meta.id} pins={pins} onSend={() => void sendFeedback()} sending={sending} disabledReason={queued ? 'Queued: messages open once this agent gets a free slot.' : undefined} />
        <Composer
          compact
          agentId={agent.id}
          projectId={agent.projectId}
          placeholder="Tell the agent what to change, or type / for commands"
          commands={commands}
          disabledReason={queued ? 'Queued: messages open once this agent gets a free slot' : undefined}
          onCompact={() => setCompactOpen(true)}
          onCycleMode={() => setMode(nextMode(agent.mode, modeOpts))}
          onSent={onSent}
        />
      </div>
      <CompactDialog open={compactOpen} agentName={agent.title} used={used} warnAt={warnAt} dangerAt={dangerAt} onCancel={() => setCompactOpen(false)} onConfirm={doCompact} />
    </>
  );
}

/** No agent yet: intro, mode / model / effort and the first message (`artifacts.startAgent`). */
function StartAgent({ meta, version, onCollapse }: { meta: ArtifactMeta; version: number; onCollapse: () => void }) {
  const settings = useSettings((s) => s.settings);
  const projects = useProjects((s) => s.list);
  const { modes } = useModeChoices(undefined);
  const [projectDefaults, setProjectDefaults] = useState<{ defaultMode: PermissionMode; presetId: string } | null>(null);
  const [mode, setModeState] = useState<PermissionMode | null>(null);
  const [slot, setSlot] = useState<ModelSlot | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'text' | 'feedback' | null>(null);
  const [askProject, setAskProject] = useState<{ text: string; pins: string[]; hasText: boolean } | null>(null);
  const [projectId, setProjectId] = useState('');
  const atts = useAttachments({ disabled: busy !== null });
  const inputId = useId();
  const hintId = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const { pins, message } = useFeedbackSend(meta, version);

  // The project's own defaults (its .oide/config.json under trust), as Spawn uses them.
  useEffect(() => {
    if (!meta.projectId) return;
    let on = true;
    void invokeOr('settings.forProject', { projectId: meta.projectId }, null).then(
      (d) => on && d && setProjectDefaults({ defaultMode: d.defaultMode, presetId: d.presetId }),
      () => undefined,
    );
    return () => {
      on = false;
    };
  }, [meta.projectId]);

  const allowed = (m: PermissionMode) => modes.some((c) => c.mode === m && !c.disabled);
  const wantedMode = projectDefaults?.defaultMode ?? settings?.claude.defaultMode ?? 'auto';
  const effectiveMode: PermissionMode = mode ?? (allowed(wantedMode) ? wantedMode : allowed('auto') ? 'auto' : 'default');
  const effectiveSlot = slot ?? defaultLeadSlot(settings, projectDefaults?.presetId);

  // Preselect the first project, never over a pick: this effect can run after the user's change
  // event (it reads `projectId` from the render that showed the picker), so it updates from the
  // latest state instead of overwriting it.
  useEffect(() => {
    const first = projects[0]?.id;
    if (askProject && !projectId && first) setProjectId((cur) => cur || first);
  }, [askProject, projectId, projects]);

  const start = async (body: string, pinIds: string[], hasText: boolean, runUnder?: string) => {
    if (busy || !body.trim()) return;
    setBusy(pinIds.length ? 'feedback' : 'text');
    try {
      const attachments = pinIds.length === 0 && atts.attachments.length ? { attachments: [...atts.attachments] } : {};
      const summary = await oide.invoke('artifacts.startAgent', {
        id: meta.id,
        text: body,
        mode: effectiveMode,
        model: effectiveSlot,
        ...(runUnder ? { projectId: runUnder } : {}),
        ...attachments,
      });
      // Show it at once; the agents.summary event brings the same summary.
      useAgents.getState().applySummary(summary);
      if (pinIds.length) useArtifactFeedback.getState().remove(meta.id, pinIds);
      if (hasText) setText('');
      if (attachments.attachments) atts.clear();
      setAskProject(null);
      trackArtifactAgentMessage(meta.kind, pinIds.length, hasText);
    } catch (err) {
      const code = ipcErrorCode(err);
      if (code === 'needs_project') setAskProject({ text: body, pins: pinIds, hasText });
      else if (code === 'busy') {
        // It already has an agent (started elsewhere a moment ago: pick it up and send it this
        // instead), or a retrieval agent is still writing it. Main's message says which.
        void useAgents.getState().load();
        toast(`${ipcErrorMessage(err)} Your message is still here.`, 'info');
      } else toast(ipcErrorMessage(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const sendText = () => void start(text.trim() || (atts.attachments.length ? 'See the attached files.' : ''), [], text.trim() !== '');
  const sendFeedback = () => {
    const typed = text.trim();
    const { checked, text: body } = message(typed);
    if (!checked.length) return;
    void start(body, checked.map((p) => p.id), typed !== '');
  };
  const canSend = busy === null && !atts.busy && (text.trim() !== '' || atts.items.length > 0);

  return (
    <>
      <PanelHeader onCollapse={onCollapse} />
      <div className="flex-1 min-h-0 overflow-auto px-4 py-4 flex flex-col gap-3">
        <p className="m-0 text-[12.5px] text-ink-2 leading-[1.55]">{AGENT_INTRO}</p>
        <p className="m-0 text-[12px] text-ink-3 leading-[1.5]">
          {meta.kind === 'whiteboard' ? 'Describe the change in words.' : 'Turn on Comment above the preview to point at what should change.'}
        </p>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3 pt-1 shrink-0">
        <div role="group" aria-label="New agent settings" className="flex flex-wrap items-center gap-1.5">
          <ModePicker mode={effectiveMode} modes={modes} onChange={setModeState} disabled={busy !== null} />
          <ModelPickers slot={effectiveSlot} onChange={setSlot} disabled={busy !== null} hintId={hintId} />
          <span id={hintId} className="sr-only">
            {MODEL_HINT}
          </span>
        </div>
        {askProject && (
          <form
            className="flex items-end gap-2 flex-wrap rounded-lg border border-line-2 bg-card p-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (projectId) void start(askProject.text, askProject.pins, askProject.hasText, projectId);
            }}
          >
            {projects.length ? (
              <>
                <Select
                  label="Run the agent under"
                  size={28}
                  options={projects.map((p) => ({ value: p.id, label: p.name }))}
                  value={projectId}
                  onChange={(e) => setProjectId(e.target.value)}
                  containerClassName="flex-1 min-w-[160px] gap-1.5"
                  autoFocus
                />
                <Button type="submit" size={28} variant="primary" disabled={!projectId || busy !== null}>
                  Start
                </Button>
              </>
            ) : (
              <span role="alert" className="flex-1 text-[12px] text-ink-2">
                An agent runs under a project&apos;s settings. Add a project first, then try again.
              </span>
            )}
            <Button size={28} variant="ghost" onClick={() => setAskProject(null)}>
              Cancel
            </Button>
            <span className="basis-full text-[12px] text-ink-3 leading-[1.45]">This artifact has no project. The agent uses the settings of the project you pick; it still works only on this artifact.</span>
          </form>
        )}
        <FeedbackTray artifactId={meta.id} pins={pins} onSend={sendFeedback} sending={busy === 'feedback'} />
        <div className="relative" {...atts.dropProps}>
          <div className={cn('flex flex-col gap-2 py-2 pr-2 pl-3 border bg-card rounded-xl', atts.dragging ? 'border-accent' : 'border-line-3')}>
            <AttachmentTray state={atts} className="pr-1.5" />
            <div className="flex items-center gap-2">
              <label htmlFor={inputId} className="sr-only">
                Message a new agent for this artifact
              </label>
              <textarea
                ref={ref}
                id={inputId}
                rows={2}
                value={text}
                disabled={busy !== null}
                placeholder={atts.dragging ? 'Drop to attach' : 'What should change?'}
                onChange={(e) => setText(e.target.value)}
                onPaste={atts.onPaste}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (canSend) sendText();
                  }
                }}
                className="flex-1 min-w-0 resize-none border-0 outline-none bg-transparent text-ink text-[13px] leading-[20px] py-[5px] placeholder:text-ink-3 focus-visible:outline-none"
              />
              <AttachFileButton state={atts} disabled={busy !== null} />
              <button
                type="button"
                aria-label={busy === 'text' ? 'Starting the agent' : 'Start the agent'}
                title="Start the agent (Enter)"
                disabled={!canSend}
                onClick={sendText}
                className="w-8 h-8 shrink-0 rounded-md border-0 bg-accent text-on-accent flex items-center justify-center hover:brightness-110 disabled:opacity-50"
              >
                <Icon name="arrow-up" size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
