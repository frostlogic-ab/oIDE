import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, IconButton, Menu, SectionLabel, Spinner, type MenuItem } from '@oide/ui';
import type { Project, WorktreeInfo } from '@oide/protocol';
import { shortBranch } from '../SourceControl/model';
import { ancestorDirs, useFiles, visibleRows, type TreeRow } from './filesStore';
import { FileIcon } from './fileIcons';
import { ResizableAside } from '../../components/ResizableAside';
import { PANELS } from '../../lib/panels';

/** Row pitch: 22px, flush rows as in the VS Code explorer. */
export const ROW_H = 22;
const HEADER_H = 26;
const SECTION_GAP = 4;
const OVERSCAN = 12;
/** Left padding of a depth-0 row, and the extra indent per level. */
const PAD = 8;
const INDENT = 10;
/** Width of the twistie / file-icon column. */
const GLYPH = 16;

export interface Marker {
  agentId: string;
  color: string;
  title: string;
}

export interface ProjectTreeInfo {
  project: Project;
  worktrees: WorktreeInfo[];
  /** relative path → agents touching it */
  markers: Map<string, Marker[]>;
  /** Worktrees (and so markers) have loaded at least once. */
  gitLoaded: boolean;
}

const DEPTHS = [1, 2, 3] as const;

/**
 * Left column: one tree per project in scope, each with its own branch / worktree menu. The toolbar
 * acts on every open tree (Search, Reveal active file, Expand loaded folders / to a depth, Collapse
 * all); with All projects each project also has its own folder menu.
 */
export function TreePanel({ trees, scoped, onSearch, searchHint }: { trees: ProjectTreeInfo[]; scoped: boolean; onSearch?: () => void; searchHint?: string }) {
  const s = useFiles();
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0 });

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setView({ top: el.scrollTop, height: el.clientHeight });
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : undefined;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, []);

  // Make sure each shown checkout has its root listed, and reveal folders agents are changing.
  useEffect(() => {
    for (const [i, t] of trees.entries()) {
      const root = s.checkout[t.project.id] ?? t.project.path;
      const open = scoped || (s.openProjects[t.project.id] ?? i === 0);
      if (!open) continue;
      if (!s.errors[root]?.['']) void s.loadDir(root, '');
      const key = `${t.project.id}:${root}`;
      if (t.gitLoaded && !s.revealed[key]) {
        s.markRevealed(key);
        const files = [...t.markers.keys()];
        if (files.length) s.expandMany(root, ancestorDirs(files).slice(0, 24));
      }
    }
  }, [trees, scoped, s]);

  let offset = 0;
  const viewport = view.height || 1000; // unmeasured (tests, first paint): render a screenful
  const openRoots = trees.filter((t, i) => scoped || (s.openProjects[t.project.id] ?? i === 0)).map((t) => s.checkout[t.project.id] ?? t.project.path);
  const activeTab = s.tabs.find((t) => t.id === s.active);
  const all = (fn: (root: string) => void) => () => openRoots.forEach(fn);

  return (
    <ResizableAside panel={PANELS.filesTree} aria-label="File tree" className="flex flex-col px-2 pt-1.5 pb-3 bg-panel border-r border-line box-border min-h-0">
      <div role="toolbar" aria-label="File tree actions" className="flex items-center gap-0.5 h-8 pl-1.5 mb-1 shrink-0">
        <SectionLabel as="h2" className="flex-1">
          Files
        </SectionLabel>
        {onSearch && <IconButton icon="search" aria-label="Search in files" title={`Search in files${searchHint ? ` (${searchHint})` : ''}`} onClick={onSearch} />}
        <IconButton icon="locate" aria-label="Reveal active file" title="Reveal active file" disabled={!activeTab} onClick={() => activeTab && revealTab(activeTab)} />
        <IconButton icon="expand-all" aria-label="Expand loaded folders" title="Expand loaded folders" disabled={!openRoots.length} onClick={all((r) => s.expandLoaded(r))} />
        <Menu
          label="Expand to depth"
          align="end"
          triggerClassName="w-5 h-7 flex items-center justify-center rounded-sm border-0 bg-transparent text-ink-3 cursor-pointer hover:bg-raised hover:text-ink"
          trigger={<Icon name="chevron-down" size={12} />}
          items={DEPTHS.map((d) => ({ id: `depth-${d}`, label: `Expand to depth ${d}`, onSelect: all((r) => void s.expandToDepth(r, d)) }))}
        />
        <IconButton icon="collapse-all" aria-label="Collapse all folders" title="Collapse all folders" disabled={!openRoots.length} onClick={all((r) => s.collapseAll(r))} />
      </div>
      <div ref={scroller} className="flex-1 min-h-0 overflow-auto -mx-2">
        {trees.map((t, i) => {
          const p = t.project;
          const root = s.checkout[p.id] ?? p.path;
          // The first project starts open (canvas: oide open, the others closed).
          const open = scoped || (s.openProjects[p.id] ?? i === 0);
          const rows = open ? visibleRows(root, s) : [];
          const top = offset;
          offset += HEADER_H + rows.length * ROW_H + SECTION_GAP;
          return (
            <ProjectTree
              key={p.id}
              info={t}
              root={root}
              open={open}
              scoped={scoped}
              rows={rows}
              windowStart={view.top - top - HEADER_H}
              windowEnd={view.top + viewport - top - HEADER_H}
              scrollTo={(y) => {
                const el = scroller.current;
                if (!el) return;
                const abs = top + HEADER_H + y;
                if (abs < el.scrollTop) el.scrollTop = abs;
                else if (abs + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = abs + ROW_H - el.clientHeight;
              }}
            />
          );
        })}
        {trees.length === 0 && <p className="m-0 px-4 py-1 text-[12px] text-ink-3">No projects in this scope.</p>}
      </div>
      <div className="mt-2 flex flex-col gap-1.5 p-2.5 rounded-lg border border-line-2 text-[11.5px] text-ink-3 shrink-0">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full bg-ok" />
          An agent is changing this file
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="w-[7px] h-[7px] rounded-full bg-warn" />
          That agent is waiting on you
        </span>
        <span className="leading-[1.45] mt-0.5">Each project shows its own branch or agent worktree. The menu next to a project switches it.</span>
      </div>
    </ResizableAside>
  );
}

/** Open the tab's project and checkout in the tree, expand down to the file and scroll to it. */
export function revealTab(t: { projectId: string; root: string; path: string }): void {
  const s = useFiles.getState();
  s.setProjectOpen(t.projectId, true);
  if ((s.checkout[t.projectId] ?? t.root) !== t.root) s.setCheckout(t.projectId, t.root);
  s.revealPath(t.root, t.path);
}

function ProjectTree({
  info,
  root,
  open,
  scoped,
  rows,
  windowStart,
  windowEnd,
  scrollTo,
}: {
  info: ProjectTreeInfo;
  root: string;
  open: boolean;
  scoped: boolean;
  rows: TreeRow[];
  windowStart: number;
  windowEnd: number;
  scrollTo: (y: number) => void;
}) {
  const s = useFiles();
  const p = info.project;
  const [focusKey, setFocusKey] = useState<string>();
  const wantFocus = useRef(false);
  const treeRef = useRef<HTMLDivElement>(null);
  const activeTab = s.tabs.find((t) => t.id === s.active);
  const selectedKey = activeTab && activeTab.root === root ? activeTab.path : undefined;
  const focusIndex = Math.max(0, rows.findIndex((r) => r.key === (focusKey ?? selectedKey)));
  const treeId = `files-tree-${p.id}`;
  const agentCount = info.worktrees.filter((w) => w.agentId).length;
  // VS Code highlights the indent guide of the folder holding the focused row (or of the focused
  // folder itself when it is open).
  const focusRow = focusKey || selectedKey ? rows[focusIndex] : undefined;
  const guideRow = focusRow?.kind === 'dir' && focusRow.expanded ? focusRow : rows.find((x) => x.key === focusRow?.parent);
  const guide = guideRow ? { key: guideRow.contentPath, depth: guideRow.depth } : undefined;

  const first = Math.max(0, Math.floor(windowStart / ROW_H) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil(windowEnd / ROW_H) + OVERSCAN);
  const shown = useMemo(() => {
    const idx = new Set<number>();
    for (let i = first; i < last; i++) idx.add(i);
    if (rows.length) idx.add(Math.min(focusIndex, rows.length - 1)); // keep the roving tab stop in the DOM
    return [...idx].sort((a, b) => a - b);
  }, [first, last, focusIndex, rows.length]);

  // Scroll to (and make the tab stop) a revealed file once its folders have loaded.
  const target = s.revealTarget;
  useEffect(() => {
    if (!target || target.root !== root || !open) return;
    const i = rows.findIndex((r) => r.key === target.path);
    if (i < 0) return;
    setFocusKey(target.path);
    scrollTo(i * ROW_H);
    s.clearRevealTarget(target.nonce);
  }, [target, root, open, rows, scrollTo, s]);

  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    const key = rows[focusIndex]?.key;
    const el = [...(treeRef.current?.querySelectorAll<HTMLElement>('[data-key]') ?? [])].find((n) => n.dataset.key === key);
    el?.focus();
  });

  const moveTo = (i: number) => {
    const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
    if (!r) return;
    setFocusKey(r.key);
    wantFocus.current = true;
    scrollTo(rows.indexOf(r) * ROW_H);
  };

  const activate = (r: TreeRow) => {
    if (r.kind === 'dir') void s.setExpanded(root, r.path, !r.expanded);
    else s.openFile(p.id, root, r.path);
  };

  const onKey = (e: KeyboardEvent, r: TreeRow, i: number) => {
    switch (e.key) {
      case 'ArrowDown':
        moveTo(i + 1);
        break;
      case 'ArrowUp':
        moveTo(i - 1);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(rows.length - 1);
        break;
      case 'ArrowRight':
        if (r.kind === 'dir' && !r.expanded) void s.setExpanded(root, r.path, true);
        else if (r.kind === 'dir') moveTo(i + 1);
        break;
      case 'ArrowLeft':
        if (r.kind === 'dir' && r.expanded) void s.setExpanded(root, r.path, false);
        else if (r.parent) moveTo(rows.findIndex((x) => x.key === r.parent));
        break;
      case '*':
        // Tree convention: expand every sibling folder of the focused row.
        for (const x of rows) if (x.parent === r.parent && x.depth === r.depth && x.kind === 'dir' && !x.expanded) void s.setExpanded(root, x.path, true);
        break;
      case '-':
        if (r.kind === 'dir' && r.expanded) void s.setExpanded(root, r.path, false);
        else if (r.parent) {
          void s.setExpanded(root, r.parent, false);
          moveTo(rows.findIndex((x) => x.key === r.parent));
        }
        break;
      case 'Enter':
      case ' ':
        // A folder that failed to load retries (the row's Retry button is for the mouse).
        if (r.kind === 'dir' && r.error) void s.loadDir(root, r.path, true);
        else activate(r);
        break;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const options = [
    { root: p.path, label: 'main' },
    ...info.worktrees.filter((w) => !w.orphaned).map((w) => ({ root: w.path, label: shortBranch(w.branch) })),
  ];
  const tabHere = activeTab && activeTab.projectId === p.id ? activeTab : undefined;
  const folderActions: MenuItem[] = [
    { id: 'collapse', label: 'Collapse all', onSelect: () => s.collapseAll(root) },
    { id: 'expand', label: 'Expand loaded folders', onSelect: () => (open ? s.expandLoaded(root) : s.setProjectOpen(p.id, true)) },
    ...DEPTHS.map((d) => ({
      id: `depth-${d}`,
      label: `Expand to depth ${d}`,
      onSelect: () => {
        s.setProjectOpen(p.id, true);
        void s.expandToDepth(root, d);
      },
    })),
    { id: 'reveal', label: 'Reveal active file', disabled: !tabHere, onSelect: () => tabHere && revealTab(tabHere) },
  ];

  return (
    <section aria-label={`${p.name} files`} className="flex flex-col mb-1">
      <div className="flex items-center gap-1 pr-2 pl-1" style={{ height: HEADER_H, boxSizing: 'border-box' }}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={treeId}
          disabled={scoped}
          onClick={() => s.setProjectOpen(p.id, !open)}
          className="flex-1 min-w-0 h-full flex items-center gap-0.5 border-0 bg-transparent text-ink text-[11px] font-bold uppercase tracking-[0.04em] px-0.5 text-left whitespace-nowrap cursor-pointer disabled:cursor-default"
        >
          <Icon name="chevron-right" size={14} className={`shrink-0 text-ink-3 transition-transform duration-100 ${open ? 'rotate-90' : ''}`} />
          <span className="truncate">{p.name}</span>
          {agentCount > 0 && (
            <span className="font-normal text-ink-3 text-[11px]" title={`${agentCount} agent ${agentCount === 1 ? 'worktree' : 'worktrees'}`}>
              {agentCount}
              <span className="sr-only"> agent {agentCount === 1 ? 'worktree' : 'worktrees'}</span>
            </span>
          )}
        </button>
        <select
          aria-label={`Branch or worktree shown for ${p.name}`}
          value={root}
          onChange={(e) => s.setCheckout(p.id, e.target.value)}
          className="font-mono h-5 w-24 flex-[0_0_96px] px-1 rounded-sm border border-line-3 bg-card text-ink-2 text-[10.5px]"
        >
          {options.map((o) => (
            <option key={o.root} value={o.root}>
              {o.label}
            </option>
          ))}
        </select>
        {!scoped && (
          <Menu
            label={`Folder actions for ${p.name}`}
            align="end"
            className="-ml-1 -mr-1"
            triggerClassName="w-5 h-5 px-0 flex items-center justify-center rounded-sm border-0 bg-transparent text-ink-3 cursor-pointer hover:bg-raised hover:text-ink"
            trigger={<Icon name="more" size={14} />}
            items={folderActions}
          />
        )}
      </div>
      {open && (
        <div
          id={treeId}
          ref={treeRef}
          role="tree"
          aria-label={`${p.name} (${options.find((o) => o.root === root)?.label ?? 'main'})`}
          className="group/tree relative"
          style={{ height: Math.max(rows.length * ROW_H, s.loading[root]?.[''] || s.errors[root]?.[''] ? ROW_H : 0) }}
        >
          {rows.length === 0 && s.loading[root]?.[''] && (
            <div className="px-2 py-1">
              <Spinner size={12} label={`Loading ${p.name}`} />
            </div>
          )}
          {rows.length === 0 && s.errors[root]?.[''] && (
            <div role="alert" className="flex items-center gap-2 px-2 py-1 text-[12px] text-bad">
              <span className="flex-1 min-w-0 truncate" title={s.errors[root]['']}>
                {s.errors[root]['']}
              </span>
              <button
                type="button"
                onClick={() => void s.loadDir(root, '', true)}
                className="shrink-0 h-5 px-2 rounded-sm border border-line-3 bg-card text-ink-2 text-[11px] cursor-pointer hover:bg-raised hover:text-ink"
              >
                Retry
              </button>
            </div>
          )}
          {shown.map((i) => {
            const r = rows[i]!;
            const markers = r.kind === 'file' ? info.markers.get(r.path) : undefined;
            const selected = r.key === selectedKey;
            return (
              <div
                key={r.key}
                data-key={r.key}
                role="treeitem"
                aria-level={r.depth + 1}
                aria-expanded={r.kind === 'dir' ? r.expanded : undefined}
                aria-selected={selected}
                aria-busy={r.loading || undefined}
                tabIndex={i === focusIndex ? 0 : -1}
                onClick={() => {
                  setFocusKey(r.key);
                  activate(r);
                }}
                onKeyDown={(e) => onKey(e, r, i)}
                onFocus={() => setFocusKey(r.key)}
                className={`group/row absolute left-0 right-0 flex items-center pr-2 text-[13px] cursor-pointer outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-accent)] ${
                  selected ? 'bg-selected text-ink' : 'text-ink-2 hover:bg-raised hover:text-ink'
                }`}
                style={{ top: i * ROW_H, height: ROW_H, paddingLeft: PAD + r.depth * INDENT }}
                title={r.error ?? r.path}
              >
                {/* Indent guides: one line per ancestor level, the focused folder's brighter. */}
                {Array.from({ length: r.depth }, (_, d) => (
                  <span
                    key={d}
                    aria-hidden="true"
                    className={`absolute top-0 bottom-0 w-px ${guide && d === guide.depth && r.key.startsWith(`${guide.key}/`) ? 'bg-ink-4' : 'bg-line-2 group-hover/tree:bg-line-3'}`}
                    style={{ left: PAD + d * INDENT + GLYPH / 2 - 1 }}
                  />
                ))}
                {r.kind === 'dir' ? (
                  <span aria-hidden="true" className="w-4 h-4 shrink-0 flex items-center justify-center text-ink-3">
                    {r.loading ? (
                      <Spinner size={10} />
                    ) : (
                      <Icon name="chevron-right" size={14} className={`transition-transform duration-100 ${r.expanded ? 'rotate-90' : ''}`} />
                    )}
                  </span>
                ) : (
                  <FileIcon name={r.label} />
                )}
                <span className={`flex-1 min-w-0 ml-1.5 truncate whitespace-pre ${r.error ? 'text-bad' : ''}`}>{r.label}</span>
                {r.kind === 'dir' && r.error && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden="true"
                    title={`Retry loading ${r.label} (Enter)`}
                    onClick={(e) => {
                      e.stopPropagation();
                      void s.loadDir(root, r.path, true);
                    }}
                    className="shrink-0 ml-1 h-4 px-1.5 rounded-sm border border-line-3 bg-card text-ink-2 text-[10.5px] cursor-pointer hover:bg-raised hover:text-ink"
                  >
                    Retry
                  </button>
                )}
                {markers?.slice(0, 3).map((m) => (
                  <span key={m.agentId} title={m.title} className="w-[7px] h-[7px] ml-1 rounded-full shrink-0" style={{ background: m.color }} role="img" aria-label={m.title} />
                ))}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

