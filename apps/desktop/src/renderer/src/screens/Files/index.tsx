/**
 * Files (docs/wiki/raw/design/Files.dc.html): with All projects, one lazy tree per project, each
 * with its own branch / agent-worktree menu; one Monaco editor (lazy, at most one live); a banner
 * when an agent is changing the open file; file history with agent attribution; Mentioned in.
 * Wiki: screen-files.md.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ContextMenu, EmptyState, Icon, Spinner } from '@oide/ui';
import { NEEDS_YOU, type AgentSummary, type ArtifactMeta, type CommitInfo, type ContentMatch, type Project } from '@oide/protocol';
import { HeaderSlot } from '../../components/frame/HeaderSlot';
import { invokeOr, ipcErrorMessage, oide } from '../../lib/bridge';
import { keymap } from '../../lib/keymap';
import { trackDiffView, trackMarkdownView } from '../../lib/telemetry';
import { useKeymapScope } from '../../lib/useKeymap';
import { useAgents } from '../../stores/agents';
import { useProjects } from '../../stores/projects';
import { navigate, useRouter } from '../../stores/router';
import { useScope } from '../../stores/scope';
import { toast } from '../../stores/ui';
import { useGit, useGitData } from '../SourceControl/gitStore';
import { C, commitAuthor, shortBranch, timeAgo } from '../SourceControl/model';
import { useChanges, useCheckoutChanges } from './changesStore';
import { effectiveDiffView, type DiffView } from './diffView';
import type { EditorPaneProps, EditorStatus, SelectionInfo } from './EditorPane';
import { joinPath, tabId, useFiles, type FileTab } from './filesStore';
import { isMarkdownPath, type MarkdownView } from './markdownLinks';
import { SearchPanel, type SearchCheckout } from './SearchPanel';
import { useSearch } from './searchStore';
import { TreePanel, type Marker, type ProjectTreeInfo } from './TreePanel';
import { ResizableAside } from '../../components/ResizableAside';
import { PANELS } from '../../lib/panels';
import { useTerminals } from '../../stores/terminals';
import { FILES_TERMINALS, TerminalDock, toggleFilesTerminal } from './TerminalDock';
import { tabLabels } from './tabLabels';

const EditorPane = lazy(() => import('./EditorPane'));
/** The changes view buttons of a changed file's tab. */
const DIFF_VIEWS = [
  { view: 'off', label: 'File', icon: 'file', title: 'Show the file without its changes' },
  { view: 'unified', label: 'Unified', icon: 'diff-unified', title: 'Show the changes in one column, removed lines above added ones' },
  { view: 'split', label: 'Split', icon: 'diff-split', title: 'Show the changes side by side: before on the left, now on the right' },
] as const;
const SECTION_LABEL ='text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3';

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
  const [reveal, setRevealState] = useState<EditorPaneProps['reveal']>();
  // Jumping to a line of a Markdown file shows its source (beside the preview).
  const setReveal = useCallback((r: EditorPaneProps['reveal']) => {
    setRevealState(r);
    if (r && isMarkdownPath(r.tabId.slice(r.tabId.indexOf('::') + 2))) useFiles.getState().setMdView(r.tabId, 'edit');
  }, []);
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
  }, [params, allProjects, agents, git, files, setReveal]);

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
  }, [pending, allProjects, agents, git, files, setReveal]);

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
    [allProjects, agents, git, files, setReveal],
  );

  const active = files.tabs.find((t) => t.id === files.active);
  const activeProject = allProjects.find((p) => p.id === active?.projectId);
  const [status, setStatus] = useState<EditorStatus>();
  // In the store, not local state: the screen unmounts when you leave Files, the editor models don't.
  const dirty = files.dirty;
  const saveRef = useRef<(() => Promise<void>) | null>(null);
  const info = useFileInfo(active);
  // Markdown files open on their rendered page; Edit shows the source beside it.
  // A changed file (git colours of the tree) opens on its changes, unified or side by side; the
  // active tab's checkout is kept loaded even when the tree shows another one.
  useCheckoutChanges(active ? [{ projectId: active.projectId, root: active.root }] : []);
  const activeChanges = useChanges((st) => (active ? st.byRoot[active.root] : undefined));
  const change = active ? activeChanges?.byPath.get(active.path) : undefined;
  const diffView: DiffView = active ? effectiveDiffView(files.diffView[active.id], files.diffLayout, change) : 'off';
  const canDiff = Boolean(active && effectiveDiffView(undefined, files.diffLayout, change) !== 'off');
  const pickDiffView = (view: DiffView) => {
    if (!active || view === diffView) return;
    files.setDiffView(active.id, view);
    trackDiffView(view);
  };
  const markdown = active && isMarkdownPath(active.path) ? (files.mdView[active.id] ?? 'preview') : undefined;
  // While the changes show, the Markdown view buttons are not pressed; picking one leaves the changes.
  const mdView: MarkdownView | undefined = diffView === 'off' ? markdown : undefined;
  const toggleMdView = (target: EventTarget | null) => {
    // Ctrl+Shift+V is paste in a terminal: leave it alone there.
    if (!active || !markdown || (target instanceof Element && target.closest('.xterm'))) return false;
    // From the changes: back to the file's own view; else flip it.
    const next = diffView !== 'off' ? markdown : markdown === 'preview' ? 'edit' : 'preview';
    if (diffView !== 'off') pickDiffView('off');
    files.setMdView(active.id, next);
    trackMarkdownView(next, 'shortcut');
  };
  useKeymapScope('files', { 'files.search': () => showSearch(), 'files.terminal': toggleTerminal, 'files.togglePreview': (e) => toggleMdView(e.target) });
  const previewKey = keymap.label('files.togglePreview');

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

  // Close one or more tabs, asking once when any of them has unsaved changes.
  const closeTabs = (list: FileTab[]) => {
    const unsaved = list.filter((t) => dirty[t.id]);
    if (unsaved.length === 1 && !window.confirm(`${unsaved[0]!.path} has unsaved changes. Close it anyway?`)) return;
    if (unsaved.length > 1 && !window.confirm(`${unsaved.length} files have unsaved changes. Close them anyway?`)) return;
    files.closeTabs(list.map((t) => t.id));
  };
  const closeTab = (t: FileTab) => closeTabs([t]);

  // Tabs show the file name only; a dim hint (project·checkout, folder) only when names clash.
  const labels = tabLabels(
    files.tabs.map((t) => {
      const co = checkoutLabel(t);
      const pName = allProjects.find((p) => p.id === t.projectId)?.name ?? t.projectId;
      return { id: t.id, path: t.path, context: `${pName}${co !== 'main' ? `·${co}` : ''}` };
    }),
  );

  // Right-click (or the Menu key / Shift+F10) on a tab: Close, Close all to the right, Close all.
  const [tabMenu, setTabMenu] = useState<{ at: { x: number; y: number }; tab: FileTab }>();
  const tabMenuItems = (t: FileTab) => {
    const right = files.tabs.slice(files.tabs.findIndex((x) => x.id === t.id) + 1);
    return [
      { id: 'close', label: 'Close', onSelect: () => closeTab(t) },
      { id: 'close-right', label: 'Close all to the right', disabled: right.length === 0, onSelect: () => closeTabs(right) },
      { id: 'close-all', label: 'Close all', onSelect: () => closeTabs(files.tabs) },
    ];
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
              const { name: base, hint } = labels.get(t.id) ?? { name: t.path.split('/').pop() ?? t.path };
              const sep = t.root.includes('\\') ? '\\' : '/';
              const fullPath = `${t.root.replace(/[\\/]+$/, '')}${sep}${t.path.split('/').join(sep)}`;
              return (
                <div
                  key={t.id}
                  className={`group flex items-center shrink-0 border-t-2 ${selected ? 'border-accent bg-ground' : 'border-transparent'}`}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setTabMenu({ at: { x: e.clientX, y: e.clientY }, tab: t });
                  }}
                  // Middle click closes the tab (mousedown is cancelled so it does not start autoscroll).
                  onMouseDown={(e) => {
                    if (e.button === 1) e.preventDefault();
                  }}
                  onAuxClick={(e) => {
                    if (e.button !== 1) return;
                    e.preventDefault();
                    closeTab(t);
                  }}
                >
                  <button
                    type="button"
                    role="tab"
                    id={`tab-${t.id}`}
                    aria-selected={selected}
                    aria-controls="files-editor"
                    title={fullPath}
                    onClick={() => files.setActive(t.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                        e.preventDefault();
                        const b = e.currentTarget.getBoundingClientRect();
                        setTabMenu({ at: { x: b.left + 12, y: b.bottom }, tab: t });
                      }
                    }}
                    className={`h-[34px] pl-3.5 pr-1.5 border-0 bg-transparent font-mono text-[12px] whitespace-nowrap cursor-pointer ${selected ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}
                  >
                    {base}
                    {hint && <span className="ml-1.5 font-sans text-[11px] text-ink-3">{hint}</span>}
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
          {tabMenu && <ContextMenu at={tabMenu.at} label={`Actions for ${tabMenu.tab.path.split('/').pop()}`} items={tabMenuItems(tabMenu.tab)} onClose={() => setTabMenu(undefined)} />}
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
                mdView={mdView}
                diff={diffView === 'off' ? undefined : { layout: diffView, ...(change?.oldPath ? { oldPath: change.oldPath } : {}), refresh: activeChanges }}
                onOpenFile={(path) => files.openFile(active.projectId, active.root, path)}
              />
            </Suspense>
          ) : (
            <EmptyState icon="file" title="Pick a file" description="Choose a file in the tree. A dot marks files an agent is changing." className="flex-1" />
          )}
        </div>
        {active && (
          // The tab bar holds only the open files; everything else about the open file sits in this bar below it.
          <footer aria-label="File status" className="flex items-center gap-2 min-h-8 pl-2 bg-chrome border-t border-line shrink-0 overflow-x-auto">
            {canDiff && (
              <div role="group" aria-label="Changes view" className="flex items-center gap-0.5 p-[2px] rounded-md border border-line-2 bg-card shrink-0">
                {DIFF_VIEWS.filter((o) => o.view !== 'off' || !markdown /* Markdown leaves its changes through Preview / Edit */).map((o) => (
                  <button
                    key={o.view}
                    type="button"
                    aria-pressed={diffView === o.view}
                    title={o.title}
                    onClick={() => pickDiffView(o.view)}
                    className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-sm border-0 text-[11.5px] cursor-pointer ${diffView === o.view ? 'bg-selected text-ink' : 'bg-transparent text-ink-3 hover:text-ink-2'}`}
                  >
                    <Icon name={o.icon} size={13} />
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            {markdown && (
              <div role="group" aria-label="Markdown view" className="flex items-center gap-0.5 p-[2px] rounded-md border border-line-2 bg-card shrink-0">
                {(
                  [
                    { view: 'preview', label: 'Preview', icon: 'eye', title: 'Show the rendered page' },
                    { view: 'edit', label: 'Edit', icon: 'pencil', title: 'Edit the source beside the rendered page' },
                  ] as const
                ).map((o) => (
                  <button
                    key={o.view}
                    type="button"
                    aria-pressed={mdView === o.view}
                    aria-keyshortcuts="Control+Shift+V Meta+Shift+V"
                    title={`${o.title}${previewKey ? ` (${previewKey})` : ''}`}
                    onClick={() => {
                      if (mdView === o.view) return;
                      if (diffView !== 'off') pickDiffView('off');
                      files.setMdView(active.id, o.view);
                      trackMarkdownView(o.view, 'button');
                    }}
                    className={`inline-flex items-center gap-1.5 h-6 px-2 rounded-sm border-0 text-[11.5px] cursor-pointer ${mdView === o.view ? 'bg-selected text-ink' : 'bg-transparent text-ink-3 hover:text-ink-2'}`}
                  >
                    <Icon name={o.icon} size={13} />
                    {o.label}
                  </button>
                ))}
              </div>
            )}
            {status && (
              <div className="flex items-center gap-2.5 ml-auto pr-3 text-[11.5px] text-ink-3 shrink-0">
                {status.readOnly && <span>Read only</span>}
                <span className="font-mono">
                  {mdView !== 'preview' && `Ln ${status.line}, Col ${status.column}`}
                  {status.language ? `${mdView !== 'preview' ? ' · ' : ''}${active.path.endsWith('.json') ? 'JSON' : status.language}` : ''}
                </span>
                {diffView !== 'off' && status.against && (
                  <span title={status.against === 'head' ? 'Uncommitted changes, against the last commit' : 'Everything this branch changed, against where it left its base branch'}>
                    {status.against === 'head' ? 'vs last commit' : 'vs base branch'}
                  </span>
                )}
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
          </footer>
        )}
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
