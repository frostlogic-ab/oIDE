/**
 * Retrieval of a linked artifact by an agent (ADR 0014): oIDE never downloads claude.ai content; an
 * agent (the user's own `claude` CLI) reads the link with its claude.ai tools and hands the files back.
 *
 * - `useRetrieval`: Update / Retry (`artifacts.refresh`, asking for a project inline when main answers
 *   `needs_project`) and Cancel (`artifacts.cancelRetrieval`).
 * - `RetrievalStatus`: the block shown while it runs (the agent's live status from the agents store,
 *   Open agent, Cancel) and after it failed (the reason, Retry, Open agent, Delete).
 * - `ProjectPrompt`: "Run the agent in" when the artifact has no project.
 * - `RetrievalCardLine`: the grid card's line (animated dot or alert icon, always with text).
 */
import { useId, useState } from 'react';
import type { ArtifactMeta } from '@oide/protocol';
import { Button, Icon, Select, StatusDot, agentStatusMeta, cn } from '@oide/ui';
import { ipcErrorCode, ipcErrorMessage, oide } from '../../lib/bridge';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { navigate } from '../../stores/router';
import { RETRIEVAL_NO_REASON, activeRetrieval, retrievalLine } from './model';

export interface RetrievalActions {
  /** Update (or Retry): starts a retrieval agent. `projectId` answers a `needs_project` refusal. */
  refresh: (projectId?: string) => Promise<void>;
  cancel: () => Promise<void>;
  busy: 'refresh' | 'cancel' | null;
  error: string | null;
  /** Main needs a project to run the agent in (the artifact has none): show `ProjectPrompt`. */
  askProject: boolean;
  dismissProject: () => void;
}

/** Update / Retry / Cancel for one artifact. `onMeta` gets main's answer before the change event. */
export function useRetrieval(meta: ArtifactMeta, onMeta?: (meta: ArtifactMeta) => void): RetrievalActions {
  const [busy, setBusy] = useState<'refresh' | 'cancel' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askProject, setAskProject] = useState(false);

  const refresh = async (projectId?: string) => {
    if (busy) return;
    setBusy('refresh');
    setError(null);
    try {
      const next = await oide.invoke('artifacts.refresh', { id: meta.id, ...(projectId ? { projectId } : {}) });
      setAskProject(false);
      onMeta?.(next);
    } catch (err) {
      const code = ipcErrorCode(err);
      if (code === 'needs_project') setAskProject(true);
      else if (code === 'busy') setError('An agent is already retrieving it.');
      else setError(ipcErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const cancel = async () => {
    if (busy) return;
    setBusy('cancel');
    setError(null);
    try {
      onMeta?.(await oide.invoke('artifacts.cancelRetrieval', { id: meta.id }));
    } catch (err) {
      setError(ipcErrorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return { refresh, cancel, busy, error, askProject, dismissProject: () => setAskProject(false) };
}

/** "Run the agent in": the project a retrieval agent works in, when the artifact has none. */
export function ProjectPrompt({ actions, label }: { actions: RetrievalActions; label: string }) {
  const projects = useProjects((s) => s.list);
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const hintId = useId();
  if (!projects.length) {
    return (
      <div role="alert" className="text-[12px] text-ink-2 leading-[1.45]">
        A retrieval agent runs in a project. Add a project first, then try again.
      </div>
    );
  }
  return (
    <form
      className="flex items-end gap-2 flex-wrap"
      onSubmit={(e) => {
        e.preventDefault();
        if (projectId) void actions.refresh(projectId);
      }}
    >
      <Select
        label="Run the agent in"
        size={28}
        options={projects.map((p) => ({ value: p.id, label: p.name }))}
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
        aria-describedby={hintId}
        containerClassName="flex-1 min-w-[160px] gap-1.5"
        autoFocus
      />
      <Button type="submit" size={28} variant="primary" disabled={!projectId || actions.busy !== null}>
        {label}
      </Button>
      <Button size={28} variant="ghost" onClick={actions.dismissProject}>
        Cancel
      </Button>
      <span id={hintId} className="basis-full text-[12px] text-ink-3 leading-[1.45]">
        This artifact has no project. The agent works in a worktree of the project you pick.
      </span>
    </form>
  );
}

export interface RetrievalStatusProps {
  meta: ArtifactMeta;
  actions: RetrievalActions;
  /** Delete the artifact (offered when a first retrieval failed: there is nothing to keep). */
  onDelete: () => void;
  className?: string;
}

/** The retrieving or failed block. Renders nothing when there is no active retrieval. */
export function RetrievalStatus({ meta, actions, onDelete, className }: RetrievalStatusProps) {
  const state = activeRetrieval(meta);
  const agentId = meta.retrieval?.agentId;
  const agent = useAgents((s) => (agentId ? s.byId[agentId] : undefined));
  const titleId = useId();
  if (!state) return null;

  const openAgent = agentId && (
    <Button size={28} icon="agents" onClick={() => navigate('focus', { agentId })}>
      Open agent
    </Button>
  );

  if (state === 'retrieving') {
    const status = agent ? agentStatusMeta(agent.status) : null;
    const lastLine = agent?.activity[agent.activity.length - 1];
    return (
      <section aria-labelledby={titleId} className={cn('flex flex-col gap-2.5 rounded-xl border border-line-2 bg-card px-3.5 py-3 box-border', className)}>
        <div className="flex items-center gap-2">
          <StatusDot color="var(--color-ok)" size={8} className="motion-safe:animate-pulse" />
          <h3 id={titleId} className="m-0 text-[13px] font-semibold text-ink">
            Retrieving from claude.ai
          </h3>
        </div>
        <p className="m-0 text-[12.5px] text-ink-2 leading-[1.5]">
          An agent is opening the link with your Claude Code CLI and copying its files here.
          {meta.version > 0 ? ` You're seeing v${meta.version} until it's done.` : ' The artifact fills in when it is done.'}
        </p>
        <div role="status" aria-live="polite" className="flex flex-col gap-0.5 rounded-md bg-chrome border border-line-2 px-2.5 py-2 text-[12px]">
          {agent && status ? (
            <>
              <span className="flex items-center gap-1.5 min-w-0">
                <StatusDot color={status.color} />
                <span className="text-ink truncate">{agent.title}</span>
                <span className="text-ink-3 shrink-0">· {status.label}</span>
              </span>
              {agent.status === 'queued' ? (
                <span className="text-ink-3">Waiting for a free slot (Settings › Agents › Max running).</span>
              ) : agent.status === 'needs-permission' || agent.status === 'has-question' ? (
                <span className="text-ink-2">It needs you: open the agent to answer.</span>
              ) : (
                lastLine && <span className="text-ink-3 truncate font-mono text-[11.5px]">{lastLine}</span>
              )}
            </>
          ) : (
            <span className="text-ink-3">Starting the agent…</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {openAgent}
          <Button size={28} variant="ghost" onClick={() => void actions.cancel()} disabled={actions.busy !== null}>
            {actions.busy === 'cancel' ? 'Cancelling…' : 'Cancel'}
          </Button>
        </div>
        {actions.error && (
          <span role="alert" className="text-[12px] text-bad">
            {actions.error}
          </span>
        )}
      </section>
    );
  }

  const first = meta.version === 0;
  return (
    <section aria-labelledby={titleId} className={cn('flex flex-col gap-2.5 rounded-xl border border-bad-line bg-bad-bg px-3.5 py-3 box-border', className)}>
      <div className="flex items-center gap-2 text-bad">
        <Icon name="alert-circle" size={16} />
        <h3 id={titleId} className="m-0 text-[13px] font-semibold text-ink">
          {first ? 'Retrieval failed' : 'Update failed'}
        </h3>
      </div>
      <p className="m-0 text-[12.5px] text-ink-2 leading-[1.5] whitespace-pre-wrap break-words">{meta.retrieval?.error || RETRIEVAL_NO_REASON}</p>
      {!first && <p className="m-0 text-[12px] text-ink-3">v{meta.version} is unchanged.</p>}
      {actions.askProject ? (
        <ProjectPrompt actions={actions} label="Retry" />
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <Button size={28} variant="primary" icon="refresh" onClick={() => void actions.refresh()} disabled={actions.busy !== null}>
            {actions.busy === 'refresh' ? 'Starting…' : 'Retry'}
          </Button>
          {openAgent}
          {first && (
            <Button size={28} variant="danger" icon="trash" onClick={onDelete} className="ml-auto">
              Delete
            </Button>
          )}
        </div>
      )}
      {actions.error && (
        <span role="alert" className="text-[12px] text-bad">
          {actions.error}
        </span>
      )}
    </section>
  );
}

/** The grid card's retrieval line: an animated green dot or a red alert icon, always with its text. */
export function RetrievalCardLine({ meta }: { meta: ArtifactMeta }) {
  const line = retrievalLine(meta);
  if (!line) return null;
  return line.tone === 'live' ? (
    <span className="inline-flex items-center gap-1.5 text-[11.5px] text-ok">
      <StatusDot color="var(--color-ok)" size={6} className="motion-safe:animate-pulse" />
      {line.text}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-bad">
      <Icon name="alert-circle" size={12} />
      {line.text}
    </span>
  );
}
