import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, Technique } from '@oide/protocol';
import { Button, Dialog, Icon, Toggle, cn } from '@oide/ui';
import { invokeOr, ipcErrorMessage, oide } from '../../lib/bridge';
import { toast } from '../../stores/ui';
import { H1, LoadFailed, Rd, Row, inp, inpSm } from './ui';
import { ExtensionTechniques } from '../../extensions/ExtensionTechniques';

const EDIT_FIELDS = ['name', 'description', 'text', 'placement', 'enabledByDefault'] as const;

export function isTechniqueEdited(t: Technique, builtIns: Technique[] | null): boolean {
  const b = builtIns?.find((x) => x.id === t.id);
  return Boolean(b && EDIT_FIELDS.some((f) => b[f] !== t[f]));
}

export function TechniquesSection({ projects, builtIns }: { projects: Project[]; builtIns: Technique[] | null }) {
  const [scope, setScope] = useState<string>('all');
  const projectId = scope === 'all' ? undefined : scope;
  const [list, setList] = useState<Technique[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Bumped by Try again to reload the list. */
  const [attempt, setAttempt] = useState(0);
  const [fromExtensions, setFromExtensions] = useState<Technique[]>([]);
  const [open, setOpen] = useState<string>('');
  const [confirmDelete, setConfirmDelete] = useState<Technique | null>(null);
  const [confirmReset, setConfirmReset] = useState<Technique | null>(null);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pending = useRef(new Map<string, Technique>());

  useEffect(() => {
    let live = true;
    setList(null);
    setLoadError(null);
    void invokeOr('settings.techniques', { projectId }, []).then((all) => {
      if (!live) return;
      // "All projects" edits the global list; a project shows the techniques stored in its .oide/techniques.json.
      // Techniques extensions contribute are listed apart, read-only.
      setFromExtensions(all.filter((t) => t.extension));
      const own = all.filter((t) => !t.extension);
      const next = projectId ? own.filter((t) => t.scope === 'project') : own.filter((t) => t.scope !== 'project');
      setList(next);
      // As on the canvas, the first technique opens expanded so its editor is visible.
      setOpen(next[0]?.id ?? '');
    }, (err: unknown) => live && setLoadError(ipcErrorMessage(err)));
    return () => {
      live = false;
    };
  }, [projectId, attempt]);

  const persist = useCallback(
    async (t: Technique) => {
      try {
        await oide.invoke('settings.saveTechnique', { technique: t, projectId });
      } catch (err) {
        toast(`Could not save ${t.name}: ${ipcErrorMessage(err)}`, 'error');
      }
    },
    [projectId],
  );

  const flush = (id: string) => {
    const t = pending.current.get(id);
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    pending.current.delete(id);
    if (t) void persist(t);
  };

  useEffect(() => {
    const ts = timers.current;
    const waiting = pending.current;
    return () => {
      // Save anything still waiting when the section unmounts.
      for (const id of [...waiting.keys()]) flush(id);
      ts.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const listRef = useRef(list);
  listRef.current = list;
  const update = (id: string, patch: Partial<Technique>, immediate = false) => {
    const l = listRef.current;
    if (!l) return;
    const next = l.map((t) => (t.id === id ? { ...t, ...patch } : t));
    listRef.current = next;
    setList(next);
    pending.current.set(id, next.find((x) => x.id === id)!);
    const old = timers.current.get(id);
    if (old) clearTimeout(old);
    timers.current.set(id, setTimeout(() => flush(id), immediate ? 0 : 400));
  };

  const add = async () => {
    const t: Technique = {
      id: `tech-${Date.now().toString(36)}`,
      name: 'New technique',
      description: 'Describe what it makes the agent do.',
      text: '',
      placement: 'first-message',
      builtIn: false,
      enabledByDefault: false,
      scope: projectId ? 'project' : 'global',
    };
    setList((l) => [...(l ?? []), t]);
    setOpen(t.id);
    await persist(t);
  };

  const remove = async (t: Technique) => {
    setConfirmDelete(null);
    try {
      await oide.invoke('settings.deleteTechnique', { id: t.id, projectId });
      setList((l) => l?.filter((x) => x.id !== t.id) ?? l);
      setOpen('');
    } catch (err) {
      toast(`Could not delete ${t.name}: ${ipcErrorMessage(err)}`, 'error');
    }
  };

  const reset = (t: Technique) => {
    setConfirmReset(null);
    const b = builtIns?.find((x) => x.id === t.id);
    if (b) update(t.id, { name: b.name, description: b.description, text: b.text, placement: b.placement, enabledByDefault: b.enabledByDefault }, true);
  };

  const techs = list ?? [];
  const onT = techs.filter((t) => t.enabledByDefault);
  const msg = onT.filter((t) => t.placement === 'first-message');
  const sys = onT.filter((t) => t.placement === 'system-prompt');

  return (
    <>
      <H1>Techniques</H1>
      <Rd>
        Instructions oIDE adds to an agent's prompt behind the scenes when you spawn it. They show up under Advanced techniques in Spawn agent, where you can switch each one on or off for that agent.
      </Rd>

      <Row
        title="Save techniques for"
        desc={
          <>
            Project techniques are stored in the project's <span className="font-mono">.oide/techniques.json</span>, so they can be shared with your team through git.
          </>
        }
      >
        {({ titleId, descId }) => (
          <select aria-labelledby={titleId} aria-describedby={descId} className={inp} value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                This project: {p.name}
              </option>
            ))}
          </select>
        )}
      </Row>

      <div className="flex items-center gap-2.5 mt-[22px]">
        <h2 className="m-0 flex-1 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">
          {techs.length} {techs.length === 1 ? 'technique' : 'techniques'} · {onT.length} on by default
        </h2>
        <button type="button" onClick={() => void add()} className="h-[30px] px-3 rounded-[7px] border border-line-3 bg-transparent text-ink text-[12.5px] hover:bg-raised">
          + Add technique
        </button>
      </div>

      <div className="flex flex-col gap-2 mt-2.5">
        {list === null && !loadError && <Rd>Loading…</Rd>}
        {list === null && loadError && <LoadFailed what="techniques" error={loadError} onRetry={() => setAttempt((n) => n + 1)} />}
        {list !== null && techs.length === 0 && (
          <Rd>
            {projectId
              ? "No techniques for this project yet. Add one and it is saved to the project's .oide/techniques.json."
              : 'No global techniques yet. Add one and it is offered in every project.'}
          </Rd>
        )}
        {techs.map((t) => {
          const isOpen = open === t.id;
          const edited = isTechniqueEdited(t, builtIns);
          const panelId = `tech-panel-${t.id}`;
          return (
            <div key={t.id} className={cn('flex flex-col rounded-xl border', isOpen ? 'border-accent bg-[#131A26]' : 'border-line-2 bg-panel')}>
              <button
                type="button"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => {
                  if (isOpen) flush(t.id);
                  setOpen(isOpen ? '' : t.id);
                }}
                className="flex items-center gap-3 px-3.5 py-3 border-0 bg-transparent text-ink text-left text-[13px]"
              >
                <span aria-hidden="true" className={cn('w-2 h-2 rounded-full shrink-0', t.enabledByDefault ? 'bg-ok' : 'bg-line-hover')} />
                <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                  <span className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold">{t.name}</span>
                    <span className="text-[11px] px-[7px] py-px rounded-[9px] border border-line-3 text-ink-3">{t.builtIn ? 'Built in' : 'Yours'}</span>
                    {edited && <span className="text-[11px] text-warn">edited</span>}
                  </span>
                  <span className="text-[12px] text-ink-3">{t.description}</span>
                </span>
                <span className="text-[12px] text-ink-3 whitespace-nowrap">{t.enabledByDefault ? 'On by default' : 'Off by default'}</span>
                <Icon name={isOpen ? 'chevron-down' : 'chevron-right'} size={12} className="text-ink-3" />
              </button>
              {isOpen && (
                <div id={panelId} className="flex flex-col gap-3 px-3.5 pt-1 pb-3.5 border-t border-line-2" onBlur={() => flush(t.id)}>
                  <div className="flex gap-3 flex-wrap mt-2.5">
                    <label className="flex-[1_1_220px] flex flex-col gap-1.5 text-[12px] text-ink-2">
                      Name
                      <input type="text" className={inp} value={t.name} onChange={(e) => update(t.id, { name: e.target.value })} />
                    </label>
                    <label className="flex-[2_1_300px] flex flex-col gap-1.5 text-[12px] text-ink-2">
                      Short description (shown in Spawn agent)
                      <input type="text" className={inp} value={t.description} onChange={(e) => update(t.id, { description: e.target.value })} />
                    </label>
                  </div>
                  <label className="flex flex-col gap-1.5 text-[12px] text-ink-2">
                    Text added to the prompt
                    <textarea
                      rows={5}
                      className={cn(inpSm, 'h-auto p-2.5 font-mono leading-[1.55] resize-y')}
                      value={t.text}
                      onChange={(e) => update(t.id, { text: e.target.value })}
                    />
                  </label>
                  <div className="flex gap-4 flex-wrap items-end">
                    <label className="flex flex-col gap-1.5 text-[12px] text-ink-2">
                      Add it to
                      <select
                        className={cn(inp, 'w-[300px]')}
                        value={t.placement}
                        onChange={(e) => update(t.id, { placement: e.target.value as Technique['placement'] }, true)}
                        aria-describedby={`${panelId}-hint`}
                      >
                        <option value="first-message">End of the agent's first message</option>
                        <option value="system-prompt">System prompt (--append-system-prompt)</option>
                      </select>
                    </label>
                    <Toggle className="h-[34px]" checked={t.enabledByDefault} onChange={(v) => update(t.id, { enabledByDefault: v }, true)} label="On by default for new agents" />
                  </div>
                  <span id={`${panelId}-hint`} className="text-[12px] text-ink-3 leading-[1.45]">
                    {t.placement === 'system-prompt'
                      ? 'Passed to the Claude Code CLI with --append-system-prompt, so it applies for the whole session and is not visible as part of the first message.'
                      : 'Appended after your goal in the first message the agent receives. Good for instructions about how to finish the task.'}
                  </span>
                  <div className="flex gap-2 flex-wrap">
                    {t.builtIn && edited && (
                      <button type="button" onClick={() => setConfirmReset(t)} className="h-[30px] px-3 rounded-[7px] border border-line-3 bg-transparent text-ink text-[12.5px] hover:bg-raised">
                        Reset to default
                      </button>
                    )}
                    {!t.builtIn && (
                      <button type="button" onClick={() => setConfirmDelete(t)} className="h-[30px] px-3 rounded-[7px] border border-[#5A2E33] bg-transparent text-bad text-[12.5px] hover:bg-bad-bg">
                        Delete technique
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <ExtensionTechniques list={fromExtensions} />

      <h2 className="m-0 mt-[22px] text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">What a new agent receives</h2>
      <Rd className="mt-1.5">With the techniques that are on by default. Your goal comes first, then each technique in the order above.</Rd>
      <div className="font-mono mt-2.5 p-3.5 rounded-xl border border-line-2 bg-chrome text-[12px] leading-[1.6] text-ink-2 flex flex-col gap-2.5">
        <span className="text-ink-3">First message</span>
        <span className="text-ink">[Your goal from Spawn agent]</span>
        {msg.map((t) => (
          <span key={t.id} className="pl-2.5 border-l-2 border-accent whitespace-pre-wrap">
            {t.text || '(empty)'}
          </span>
        ))}
        {sys.length > 0 && (
          <>
            <span className="text-ink-3 mt-1">Appended to the system prompt</span>
            {sys.map((t) => (
              <span key={t.id} className="pl-2.5 border-l-2 border-violet whitespace-pre-wrap">
                {t.text || '(empty)'}
              </span>
            ))}
          </>
        )}
      </div>
      <Rd className="mt-2.5">The agent's transcript shows which techniques were added, so nothing is hidden from you after spawning.</Rd>

      <Dialog
        open={Boolean(confirmReset)}
        onClose={() => setConfirmReset(null)}
        title={`Reset ${builtIns?.find((x) => x.id === confirmReset?.id)?.name ?? confirmReset?.name ?? ''} to its default?`}
        description="Your edits to its name, description and text are lost."
        footer={
          <>
            <Button size={32} onClick={() => setConfirmReset(null)}>
              Cancel
            </Button>
            <Button size={32} variant="danger" onClick={() => confirmReset && reset(confirmReset)}>
              Reset
            </Button>
          </>
        }
      />

      <Dialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        title={`Delete ${confirmDelete?.name ?? ''}?`}
        description={
          projectId
            ? "Its text is removed from this project's .oide/techniques.json (git history keeps any committed copy)."
            : "Its text is removed from your global techniques and can't be recovered."
        }
        footer={
          <>
            <Button size={32} onClick={() => setConfirmDelete(null)}>
              Cancel
            </Button>
            <Button size={32} variant="danger" onClick={() => confirmDelete && void remove(confirmDelete)}>
              Delete
            </Button>
          </>
        }
      />
    </>
  );
}
