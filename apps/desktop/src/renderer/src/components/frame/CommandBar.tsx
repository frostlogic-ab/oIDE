import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Icon, Kbd, StatusDot, agentStatusMeta, cn } from '@oide/ui';
import { parseQuickOpenQuery, type AgentSummary } from '@oide/protocol';
import { commands, fuzzyFilter } from '../../lib/commands';
import { buildCommandBarRows, openQuickOpenResult, recentRows, useQuickOpenFiles, useQuickOpenRoots, type CommandBarRow } from '../../lib/quickOpen';
import { trackCommand } from '../../lib/telemetry';
import { useKeymapScope } from '../../lib/useKeymap';
import { useFiles } from '../../screens/Files/filesStore';
import { agentsInScope, useAgents } from '../../stores/agents';
import { projectName, useProjects } from '../../stores/projects';
import { navigate } from '../../stores/router';
import { useUi } from '../../stores/ui';

type Row = CommandBarRow;

/**
 * Ctrl/Cmd+K: quick open and command palette. Plain text finds files by name in the projects in
 * scope, mixed with commands and sessions in sections; `>` restricts to commands; `name:42` opens
 * at a line. "Jump to session" switches to an agent list.
 */
export function CommandBar() {
  const { open, mode, query } = useUi((s) => s.commandBar);
  if (!open) return null;
  return <CommandBarPanel mode={mode} query={query} />;
}

function CommandBarPanel({ mode, query }: { mode: 'commands' | 'sessions'; query: string }) {
  const close = useUi((s) => s.closeCommandBar);
  const setQuery = useUi((s) => s.setCommandQuery);
  const openBar = useUi((s) => s.openCommandBar);
  const version = useSyncExternalStore(
    (cb) => commands.subscribe(cb),
    () => commands.getVersion(),
  );
  const byId = useAgents((s) => s.byId);
  const order = useAgents((s) => s.order);
  const projects = useProjects((s) => s.list);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const opener = useRef<HTMLElement | null>(null);
  const roots = useQuickOpenRoots();
  const recent = useFiles((s) => s.recent);
  const commandOnly = query.trimStart().startsWith('>');
  const found = useQuickOpenFiles(query, roots, mode === 'commands' && !commandOnly);
  const rootLabel = useMemo(() => new Map(roots.map((r) => [r.root, r.label])), [roots]);

  useKeymapScope('command-bar', {}, { modal: true });

  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => {
      if (opener.current && document.contains(opener.current)) opener.current.focus();
    };
  }, []);

  const rows: Row[] = useMemo(() => {
    void version;
    const agents = agentsInScope(byId, order, 'all');
    const agentRows = (list: AgentSummary[]): Row[] => list.map((agent) => ({ kind: 'agent', id: `agent:${agent.id}`, agent, group: 'Sessions' }));
    if (mode === 'sessions') return agentRows(fuzzyFilter(agents, query, (a) => `${a.title} ${projectName(projects, a.projectId)}`));
    // File results belong to the query they were fetched for (an older answer is not shown).
    const files = found.query === query ? found.results : [];
    return buildCommandBarRows({ query, commands: commands.list(), agents, files, recent: recentRows(recent, roots) });
  }, [version, byId, order, projects, mode, query, found, recent, roots]);

  useEffect(() => setActive(0), [query, mode]);
  // Rows change as file results arrive: keep the highlight on a real row (never -1 or past the end).
  const current = Math.max(0, Math.min(active, rows.length - 1));
  // A file search applies to this query but its (debounced) answer has not arrived yet.
  const searching = mode === 'commands' && !commandOnly && roots.length > 0 && parseQuickOpenQuery(query).query !== '' && found.query !== query;

  const runRow = async (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'agent') {
      close();
      navigate('focus', { agentId: row.agent.id });
      return;
    }
    if (row.kind === 'file') {
      close();
      openQuickOpenResult(row);
      return;
    }
    trackCommand(row.command.id, row.command.source);
    const result = await row.command.run();
    if (!(result && typeof result === 'object' && result.keepOpen)) close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive(Math.max(0, Math.min(rows.length - 1, current + 1)));
    else if (e.key === 'ArrowUp') setActive(Math.max(0, current - 1));
    else if (e.key === 'Enter') void runRow(rows[current]);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Backspace' && !query && mode === 'sessions') openBar('commands');
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [current, listId]);

  let lastGroup = '';
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4 bg-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command bar"
        className="w-[640px] max-w-full flex flex-col bg-card border border-line-3 rounded-2xl shadow-dialog overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 h-12 border-b border-line">
          <Icon name="search" className="text-ink-3" />
          {mode === 'sessions' && <span className="text-[12px] text-ink-3 whitespace-nowrap">Jump to session ›</span>}
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={rows[current] ? `${listId}-${current}` : undefined}
            aria-autocomplete="list"
            aria-label={mode === 'sessions' ? 'Find a session' : 'Search files and commands'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={mode === 'sessions' ? 'Type an agent name' : 'Open a file, run a command (type > for commands only), or jump to a session'}
            className="flex-1 min-w-0 h-full border-0 outline-none bg-transparent text-ink text-[14px] placeholder:text-ink-3 focus-visible:outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div id={listId} role="listbox" aria-label="Results" className="max-h-[360px] overflow-y-auto py-1.5">
          {rows.length === 0 && <div className="px-4 py-6 text-center text-ink-3 text-[12.5px]">{searching ? 'Searching files…' : 'No matches'}</div>}
          {rows.map((row, i) => {
            const header = row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            return (
              <div key={row.id}>
                {header && <div className="px-4 pt-2 pb-1 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">{header}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === current}
                  onMouseMove={() => setActive(i)}
                  onClick={() => void runRow(row)}
                  className={cn('mx-1.5 flex items-center gap-2.5 h-9 px-2.5 rounded-sm cursor-pointer text-[13px]', i === current ? 'bg-selected text-ink' : 'text-ink-2')}
                >
                  {row.kind === 'command' ? (
                    <>
                      <span className="flex-1 truncate">{row.command.title}</span>
                      {row.command.hint && <Kbd>{row.command.hint}</Kbd>}
                    </>
                  ) : row.kind === 'file' ? (
                    <FileRowContent match={row.match} label={rootLabel.get(row.match.root) ?? ''} line={row.line} />
                  ) : (
                    <>
                      <StatusDot status={row.agent.status} />
                      <span className="flex-1 truncate">{row.agent.title}</span>
                      <span className="text-[11.5px] text-ink-3 whitespace-nowrap">
                        {projectName(projects, row.agent.projectId)} · <span style={{ color: agentStatusMeta(row.agent.status).color }}>{agentStatusMeta(row.agent.status).label}</span>
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-4 px-4 h-8 border-t border-line text-[11px] text-ink-3">
          <span className="flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to move
          </span>
          <span className="flex items-center gap-1.5">
            <Kbd>Enter</Kbd> to run
          </span>
          {mode === 'commands' && (
            <>
              <span className="flex items-center gap-1.5">
                <Kbd>&gt;</Kbd> commands only
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>:42</Kbd> go to line
              </span>
            </>
          )}
          {mode === 'sessions' && (
            <span className="flex items-center gap-1.5">
              <Kbd>Backspace</Kbd> for commands
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

/** A file result: name and folder with the matched characters marked, project (and worktree) on the right. */
function FileRowContent({ match, label, line }: { match: { path: string; positions: number[] }; label: string; line?: number | undefined }) {
  const slash = match.path.lastIndexOf('/');
  const hit = new Set(match.positions);
  const mark = (from: number, to: number) => {
    const out: Array<{ text: string; hit: boolean }> = [];
    for (let i = from; i < to; i++) {
      const h = hit.has(i);
      const last = out[out.length - 1];
      if (last && last.hit === h) last.text += match.path[i];
      else out.push({ text: match.path[i]!, hit: h });
    }
    return out.map((p, i) =>
      p.hit ? (
        <span key={i} className="text-link font-semibold">
          {p.text}
        </span>
      ) : (
        <span key={i}>{p.text}</span>
      ),
    );
  };
  return (
    <>
      <Icon name="file" size={14} className="text-ink-3 shrink-0" />
      <span className="shrink-0 max-w-[45%] truncate">{mark(slash + 1, match.path.length)}</span>
      <span className="flex-1 min-w-0 truncate font-mono text-[11.5px] text-ink-3">{slash > 0 ? mark(0, slash) : null}</span>
      <span className="text-[11.5px] text-ink-3 whitespace-nowrap">
        {label}
        {line !== undefined ? ` · line ${line}` : ''}
      </span>
    </>
  );
}
