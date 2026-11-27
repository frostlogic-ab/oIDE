/**
 * Files (docs/wiki/raw/design/Files.dc.html): with All projects, one lazy tree per project, each
 * with its own branch / agent-worktree menu; one Monaco editor (lazy, at most one live); a banner
 * when an agent is changing the open file; file history with agent attribution; Mentioned in.
 * Wiki: screen-files.md.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, EmptyState, Spinner } from '@oide/ui';
import { NEEDS_YOU, type AgentSummary, type ArtifactMeta, type CommitInfo, type ContentMatch, type Project } from '@oide/protocol';
import { HeaderSlot } from '../../components/frame/HeaderSlot';
import { invokeOr, ipcErrorMessage, oide } from '../../lib/bridge';
import { keymap } from '../../lib/keymap';
import { useKeymapScope } from '../../lib/useKeymap';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { navigate, useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { toast } from '../../stores/ui';
import { useGit, useGitData } from '../SourceControl/gitStore';
import { C, commitAuthor, shortBranch, timeAgo } from '../SourceControl/model';
import type { EditorPaneProps, EditorStatus, SelectionInfo } from './EditorPane';
import { joinPath, tabId, useFiles, type FileTab } from './filesStore';
import { SearchPanel, type SearchCheckout } from './SearchPanel';
import { useSearch } from './searchStore';
import { TreePanel, type Marker, type ProjectTreeInfo } from './TreePanel';
import { ResizableAside } from '../../components/ResizableAside';
import { PANELS } from '../../lib/panels';
import { useTerminals } from '../../stores/terminals';
import { FILES_TERMINALS, TerminalDock, toggleFilesTerminal } from './TerminalDock';

const EditorPane = lazy(() => import('./EditorPane'));
const SECTION_LABEL = 'text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3';

export default function FilesScreen() {
  const allProjects = useProjects((s) => s.list);
  const scope = useScope((s) => s.scope);
  const agents = useAgents((s) => s.byId);
  const git = useGit((s) => s.byProject);
  const route = useRouter((s) => s.route);
  const files = useFiles();
  const projects = useMemo(() => allProjects.filter((p) => scope === 'all' || p.id === scope), [allProjects, scope]);
  useGitData(projects.map((p) => p.id));

  const trees: ProjectTreeInfo[] = useMemo(
    () =>
      projects.map((project) => {
        const worktrees = git[project.id]?.worktrees ?? [];
        const markers = new Map<string, Marker[]>();
        for (const w of worktrees) {
          const a = w.agentId ? agents[w.agentId] : undefined;
          if (!a || a.status === 'done' || a.status === 'stopped') continue;
          const m = markerFor(a);
          for (const f of w.changedFiles) markers.set(f, [...(markers.get(f) ?? []), m]);
        }
        return { project, worktrees, markers, gitLoaded: git[project.id]?.loadedAt !== undefined };
      }),
    [projects, git, agents],
  );

  // Open a file from route params ({ root, path, line }) once.
  const params = useMemo<{ root?: string; path?: string; line?: number }>(() => (route.screen === 'files' ? route.params : {}), [route]);
  const applied = useRef<string>('');
  const [reveal, setReveal] = useState<EditorPaneProps['reveal']>();
  useEffect(() => {
    const key = JSON.stringify(params);
    if (!params.root || applied.current === key) return;
    const projectId = projectForRoot(params.root, allProjects, agents, git);
    if (!projectId) return; // wait for projects / worktrees to load
    applied.current = key;
    files.setProjectOpen(projectId, true);
    files.setCheckout(projectId, params.root);
    if (params.path) {
      files.openFile(projectId, params.root, params.path);
      if (params.line) setReveal({ tabId: tabId(params.root, params.path), line: params.line, nonce: Date.now() });
    }
  }, [params, allProjects, agents, git, files]);

  // Quick open (Ctrl/Cmd+K): open the file in its project and checkout, reveal it in the tree.
  const pending = files.pending;
  useEffect(() => {
    if (!pending) return;
    const projectId = projectForRoot(pending.root, allProjects, agents, git);
    if (!projectId) return;
    files.clearPending(pending.nonce);
    files.setProjectOpen(projectId, true);
    files.setCheckout(projectId, pending.root);
    files.openFile(projectId, pending.root, pending.path);
    const tab = tabId(pending.root, pending.path);
    setReveal(pending.line ? { tabId: tab, line: pending.line, ...(pending.column !== undefined ? { column: pending.column } : {}), nonce: pending.nonce, focus: true } : undefined);
    useSearch.getState().setOpen(false);
    files.revealPath(pending.root, pending.path);
  }, [pending, allProjects, agents, git, files]);

  // Files › Search (header button, Ctrl/Cmd+Shift+F).
  const searchOpen = useSearch((st) => st.open);
  const showSearch = useSearch((st) => st.show);
  const setSearchOpen = useSearch((st) => st.setOpen);
  // Files › Terminal: new shells open in the active file's checkout, else the first project's.
  const termHome = useMemo(() => {
    const t = files.tabs.find((x) => x.id === files.active);
    const project = (t && allProjects.find((p) => p.id === t.projectId)) ?? projects[0];
    if (!project) return undefined;
    const root = t?.projectId === project.id ? t.root : (files.checkout[project.id] ?? project.path);
    const w = (git[project.id]?.worktrees ?? []).find((x) => x.path === root);
    return { cwd: root, context: `${project.name}${w ? `·${shortBranch(w.branch)}` : ''}` };
  }, [files.tabs, files.active, files.checkout, allProjects, projects, git]);
  const terminalOpen = useTerminals((st) => st.groups[FILES_TERMINALS]?.open ?? false);
  const toggleTerminal = () => toggleFilesTerminal(termHome?.cwd, termHome?.context);

  useKeymapScope('files', { 'files.search': () => showSearch(), 'files.terminal': toggleTerminal });
  const searchKey = keymap.label('files.search');
  const terminalKey = keymap.label('files.terminal');
  const checkouts: SearchCheckout[] = useMemo(
    () =>
      projects.map((project) => {
        const root = files.checkout[project.id] ?? project.path;
        const w = (git[project.id]?.worktrees ?? []).find((x) => x.path === root);
        return { project, root, label: w ? shortBranch(w.branch) : 'main' };
      }),
    [projects, files.checkout, git],
  );
  const openMatch = useCallback(
    (root: string, path: string, m?: ContentMatch) => {
      const projectId = projectForRoot(root, allProjects, agents, git);
      if (!projectId) return;
      files.openFile(projectId, root, path);
      if (m) setReveal({ tabId: tabId(root, path), line: m.line, column: m.column, length: m.length, nonce: Date.now() + Math.random() });
    },
    [allProjects, agents, git, files],
  );

  const active = files.tabs.find((t) => t.id === files.active);
  const activeProject = allProjects.find((p) => p.id === active?.projectId);
  const [status, setStatus] = useState<EditorStatus>();
  // In the store, not local state: the screen unmounts when you leave Files, the editor models don't.
  const dirty = files.dirty;
  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const info = useFileInfo(active);

  const checkoutLabel = (t: FileTab | undefined) => {
    if (!t) return 'main';
    const w = (git[t.projectId]?.worktrees ?? []).find((x) => x.path === t.root);
    return w ? shortBranch(w.branch) : 'main';
  };

  const editingAgents = info.editing.map((id) => agents[id]).filter((a): a is AgentSummary => Boolean(a));
  const editor = editingAgents[0];
  const editorWorktree = editor ? (git[editor.projectId]?.worktrees ?? []).find((w) => w.agentId === editor.id) : undefined;
  const viewingAgentCopy = Boolean(active && editorWorktree && editorWorktree.path === active.root);

  const ask = (sel: SelectionInfo) => {
    if (!active) return;
    const base = active.path.split('/').pop() ?? active.path;
    const range = sel.endLine > sel.startLine ? `${sel.startLine}-${sel.endLine}` : `${sel.startLine}`;
    navigate('spawn', {
      projectId: active.projectId,
      context: [{ kind: 'file', path: active.path, title: sel.text ? `${base}:${range}` : base }],
    });
  };

  const sendTo = editor
    ? {
        label: `Send to ${editor.title}`,
        run: async (sel: SelectionInfo) => {
          const lines = sel.endLine > sel.startLine ? `lines ${sel.startLine}-${sel.endLine}` : `line ${sel.startLine}`;
          const text = `Look at ${sel.path} ${lines}:\n\n\`\`\`\n${sel.text}\n\`\`\``;
          try {
            await oide.invoke('agents.send', { agentId: editor.id, message: { kind: 'text', text } });
            toast(`Sent the selection to ${editor.title}`, 'success');
          } catch (err) {
            toast(`Couldn't send: ${ipcErrorMessage(err)}`, 'error');
          }
        },
      }
    : undefined;

  const switchCheckout = (root: string) => {
    if (!active) return;
    files.setCheckout(active.projectId, root);
    files.openFile(active.projectId, root, active.path);
  };

  const closeTab = (t: FileTab) => {
    if (dirty[t.id] && !window.confirm(`${t.path} has unsaved changes. Close it anyway?`)) return;
    files.closeTab(t.id);
  };

  return (
    <>
      <HeaderSlot name="actions">
        <Button variant="secondary" size={28} icon="search" aria-pressed={searchOpen} aria-keyshortcuts="Control+Shift+F Meta+Shift+F" onClick={() => showSearch({ toggle: true })} kbd={searchKey || undefined}>
          Search
        </Button>
        <Button variant="secondary" size={28} icon="terminal" aria-pressed={terminalOpen} aria-keyshortcuts="Control+`" disabled={!termHome && !terminalOpen} onClick={toggleTerminal} kbd={terminalKey || undefined}>
          Terminal
        </Button>
      </HeaderSlot>
      {searchOpen ? (
        <SearchPanel checkouts={checkouts} currentProjectId={active?.projectId} onOpen={openMatch} onClose={() => setSearchOpen(false)} />
      ) : (
        <TreePanel trees={trees} scoped={scope !== 'all'} onSearch={() => showSearch()} searchHint={searchKey} />
      )}

      <main className="flex-1 min-w-[360px] min-h-0 flex flex-col">
        <div className="flex items-stretch bg-chrome border-b border-line min-h-9">
          <div role="tablist" aria-label="Open files" className="flex min-w-0 overflow-x-auto">
            {files.tabs.map((t) => {
              const selected = t.id === files.active;
              const pName = allProjects.find((p) => p.id === t.projectId)?.name ?? t.projectId;
              const co = checkoutLabel(t);
              const base = t.path.split('/').pop();
              return (
                <div key={t.id} className={`group flex items-center shrink-0 border-t-2 ${selected ? 'border-accent bg-ground' : 'border-transparent'}`}>
                  <button
                    type="button"
                    role="tab"
                    id={`tab-${t.id}`}
                    aria-selected={selected}
                    aria-controls="files-editor"
                    title={`${pName}${co !== 'main' ? ` (${co})` : ''} › ${t.path}`}
                    onClick={() => files.setActive(t.id)}
                    className={`h-[34px] pl-3.5 pr-1.5 border-0 bg-transparent font-mono text-[12px] whitespace-nowrap cursor-pointer ${selected ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
                  >
                    <span className={selected ? 'text-ink-3' : undefined}>
                      {pName}
                      {co !== 'main' ? `·${co}` : ''} ›
                    </span>{' '}
                    {base}
                    {dirty[t.id] && (
                      <span className="ml-1.5 text-warn" aria-label="unsaved changes">
                        ●
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close ${base}`}
                    onClick={() => closeTab(t)}
                    className={`w-5 h-5 mr-2 rounded-xs border-0 bg-transparent text-ink-3 text-[13px] leading-none cursor-pointer hover:bg-raised hover:text-ink ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
          <div className="flex-1" />
          {active && status && (
            <div className="flex items-center gap-2.5 px-3 text-[11.5px] text-ink-3 shrink-0">
              {status.readOnly && <span>Read only</span>}
              <span className="font-mono">
                Ln {status.line}, Col {status.column}
                {status.language ? ` · ${active.path.endsWith('.json') ? 'JSON' : status.language}` : ''}
              </span>
              {dirty[active.id] && (
                <button
                  type="button"
                  className="h-6 px-2 rounded-sm border border-line-3 bg-transparent text-ink text-[11.5px] cursor-pointer hover:bg-raised disabled:opacity-50"
                  disabled={status.saving}
                  onClick={() => void saveRef.current?.()}
                  aria-keyshortcuts="Control+S Meta+S"
                >
                  {status.saving ? 'Saving…' : 'Save'}
                </button>
              )}
            </div>
          )}
        </div>

        {active && editor && (
          <Banner
            agent={editor}
            viewingAgentCopy={viewingAgentCopy}
            checkout={checkoutLabel(active)}
            onSwitch={() => switchCheckout(viewingAgentCopy ? (activeProject?.path ?? active.root) : (editorWorktree?.path ?? active.root))}
            canSwitch={Boolean(viewingAgentCopy ? activeProject : editorWorktree)}
          />
        )}

        <div id="files-editor" role="tabpanel" aria-labelledby={active ? `tab-${active.id}` : undefined} className="flex-1 min-h-0 flex flex-col">
          {active ? (
            <Suspense
              fallback={
                <div className="flex-1 flex items-center justify-center">
                  <Spinner label="Loading the editor" />
                </div>
              }
            >
              <EditorPane
                tabs={files.tabs}
                active={active}
                reveal={reveal}
                onStatus={setStatus}
                onDirty={files.setDirty}
                onAsk={ask}
                sendTo={sendTo}
                saveRef={saveRef}
              />
            </Suspense>
          ) : (
            <EmptyState icon="file" title="Pick a file" description="Choose a file in the tree. A dot marks files an agent is changing." className="flex-1" />
          )}
        </div>
        <TerminalDock newCwd={termHome?.cwd} newContext={termHome?.context} />
      </main>

      <ResizableAside panel={PANELS.filesActivity} aria-label="File activity" className="flex flex-col gap-3 p-4 bg-panel border-l border-line box-border overflow-auto">
        <h2 className={`m-0 ${SECTION_LABEL}`}>This file's history</h2>
        {!active && <span className="text-[12.5px] text-ink-3">Open a file to see who changed it.</span>}
        {active && (
          <ul className="list-none m-0 p-0 flex flex-col gap-2.5 text-[12.5px] text-ink-2">
            {editingAgents.map((a) => {
              const w = (git[a.projectId]?.worktrees ?? []).find((x) => x.agentId === a.id);
              return (
                <li key={a.id} className="flex flex-col gap-0.5">
                  <a
                    href={`#focus/${a.id}`}
                    className="text-ink-2 no-underline hover:text-ink"
                    onClick={(e) => {
                      e.preventDefault();
                      navigate('focus', { agentId: a.id });
                    }}
                  >
                    {a.title}
                  </a>
                  <span className="text-[11.5px] text-ink-3">
                    {NEEDS_YOU.has(a.status) ? 'waiting on you' : 'editing now'}
                    {w ? ` · worktree ${shortBranch(w.branch)}` : ''}
                  </span>
                </li>
              );
            })}
            {info.loading && <Spinner size={12} label="Loading history" />}
            {info.history.map((c, i) => (
              <li key={c.sha} className="flex flex-col gap-0.5" title={`${c.sha.slice(0, 7)} ${c.message}`}>
                <span>{commitAuthor(c)}</span>
                <span className="text-[11.5px] text-ink-3">
                  {i === info.history.length - 1 && info.history.length > 1 ? 'created' : `committed on ${checkoutLabel(active)}`} · {timeAgo(c.ts)}
                </span>
              </li>
            ))}
            {!info.loading && !info.history.length && !editingAgents.length && <li className="text-ink-3">No commits touch this file yet.</li>}
          </ul>
        )}
        {active && (
          <>
            <h2 className={`m-0 mt-2 ${SECTION_LABEL}`}>Mentioned in</h2>
            {info.mentions.length === 0 ? (
              <span className="text-[12.5px] text-ink-3">No artifacts mention this file.</span>
            ) : (
              <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
                {info.mentions.map((m) => (
                  <li key={m.id}>
                    <a
                      href={`#artifacts/${m.id}`}
                      className="text-[12.5px] text-ink-2 no-underline hover:text-ink"
                      onClick={(e) => {
                        e.preventDefault();
                        navigate('artifacts', { artifactId: m.id });
                      }}
                    >
                      {m.title} · {m.kind}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
        <div className="flex-1" />
        <span className="text-[12px] text-ink-3 leading-normal">A full editor is here when you need it. Language servers come from extensions.</span>
      </ResizableAside>
    </>
  );
}

function Banner({
  agent,
  viewingAgentCopy,
  checkout,
  onSwitch,
  canSwitch,
}: {
  agent: AgentSummary;
  viewingAgentCopy: boolean;
  checkout: string;
  onSwitch(): void;
  canSwitch: boolean;
}) {
  const waiting = NEEDS_YOU.has(agent.status);
  const tone = waiting
    ? { bg: 'bg-warn-bg', border: 'border-warn-line', text: 'text-[#EBDDBF]', link: 'text-warn', dot: C.warn }
    : { bg: 'bg-ok-bg-2', border: 'border-ok-line', text: 'text-[#C9E9DA]', link: 'text-ok-bright', dot: C.ok };
  return (
    <div role="status" className={`flex items-center gap-2.5 mt-3 mx-4 px-3 py-2.5 rounded-lg border flex-wrap ${tone.bg} ${tone.border}`}>
      <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: tone.dot }} />
      <span className={`flex-1 min-w-[240px] ${tone.text}`}>
        {viewingAgentCopy ? (
          <>
            You're viewing the worktree of <b>{agent.title}</b>, which is changing this file. Your edits go straight into its work.
          </>
        ) : (
          <>
            <b>{agent.title}</b> is changing this file in its worktree{waiting ? ' and is waiting on you' : ''}. You're viewing{' '}
            <span className="font-mono text-[12px]">{checkout}</span>, so your edits won't clash.
          </>
        )}
      </span>
      {canSwitch && (
        <button type="button" onClick={onSwitch} className={`h-7 px-2.5 rounded-sm border bg-transparent text-[12px] cursor-pointer hover:bg-raised ${tone.border} ${tone.text}`}>
          {viewingAgentCopy ? 'See main version' : "See agent's version"}
        </button>
      )}
      <a
        href={`#focus/${agent.id}`}
        className={`text-[12px] underline underline-offset-2 ${tone.link}`}
        onClick={(e) => {
          e.preventDefault();
          navigate('focus', { agentId: agent.id });
        }}
      >
        Open agent
      </a>
    </div>
  );
}

function markerFor(a: AgentSummary): Marker {
  if (NEEDS_YOU.has(a.status)) return { agentId: a.id, color: C.warn, title: `Being edited by ${a.title} (waiting on you)` };
  if (a.status === 'ready-for-review') return { agentId: a.id, color: C.review, title: `Ready for review: ${a.title}` };
  return { agentId: a.id, color: C.ok, title: `Being edited by ${a.title}` };
}

function projectForRoot(
  root: string,
  projects: Project[],
  agents: Record<string, AgentSummary>,
  git: ReturnType<typeof useGit.getState>['byProject'],
): string | undefined {
  const norm = (p: string) => p.replace(/[\\/]+$/, '').toLowerCase();
  const r = norm(root);
  return (
    projects.find((p) => norm(p.path) === r)?.id ??
    Object.values(agents).find((a) => a.worktreePath && norm(a.worktreePath) === r)?.projectId ??
    Object.entries(git).find(([, g]) => g.worktrees.some((w) => norm(w.path) === r))?.[0]
  );
}

/** History, editing agents and mentions for the open file. */
function useFileInfo(tab: FileTab | undefined) {
  const [state, setState] = useState<{ history: CommitInfo[]; editing: string[]; mentions: ArtifactMeta[]; loading: boolean }>({
    history: [],
    editing: [],
    mentions: [],
    loading: false,
  });
  useEffect(() => {
    if (!tab) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, history: [], editing: [], mentions: [] }));
    void Promise.all([
      invokeOr('files.history', { root: tab.root, path: tab.path }, [] as CommitInfo[]).catch(() => [] as CommitInfo[]),
      invokeOr('files.editingAgents', { path: joinPath(tab.root, tab.path) }, [] as string[]).catch(() => [] as string[]),
      invokeOr('files.mentionedIn', { root: tab.root, path: tab.path }, [] as ArtifactMeta[]).catch(() => [] as ArtifactMeta[]),
    ]).then(([history, editing, mentions]) => {
      if (!cancelled) setState({ history, editing, mentions, loading: false });
    });
    const off = oide.on('agents.summary', () => {
      void invokeOr('files.editingAgents', { path: joinPath(tab.root, tab.path) }, [] as string[])
        .then((editing) => !cancelled && setState((s) => (s.editing.join() === editing.join() ? s : { ...s, editing })))
        .catch(() => {});
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [tab]);
  return state;
}
