import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import { Icon, Kbd, StatusDot, agentStatusMeta, cn } from '@oide/ui';
import type { AgentSummary } from '@oide/protocol';
import { commands, filterCommands, fuzzyFilter, type Command } from '../../lib/commands';
import { useKeymapScope } from '../../lib/useKeymap';
import { agentsInScope, useAgents } from '../../stores/agents';
import { projectName, useProjects } from '../../stores/projects';
import { navigate } from '../../stores/router';
import { useUi } from '../../stores/ui';

type Row =
  | { kind: 'command'; id: string; command: Command; group: string }
  | { kind: 'agent'; id: string; agent: AgentSummary; group: string };

/** Ctrl/Cmd+K: fuzzy command palette over the command registry plus "Jump to session". */
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
    const cmdRows: Row[] = filterCommands(commands.list(), query).map((command) => ({
      kind: 'command',
      id: command.id,
      command,
      group: command.group ?? 'Commands',
    }));
    if (!query.trim()) return cmdRows;
    return [...cmdRows, ...agentRows(fuzzyFilter(agents, query, (a) => a.title).slice(0, 5))];
  }, [version, byId, order, projects, mode, query]);

  useEffect(() => setActive(0), [query, mode]);

  const runRow = async (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === 'agent') {
      close();
      navigate('focus', { agentId: row.agent.id });
      return;
    }
    const result = await row.command.run();
    if (!(result && typeof result === 'object' && result.keepOpen)) close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive((i) => Math.min(rows.length - 1, i + 1));
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
    else if (e.key === 'Enter') void runRow(rows[active]);
    else if (e.key === 'Escape') close();
    else if (e.key === 'Backspace' && !query && mode === 'sessions') openBar('commands');
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  useEffect(() => {
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, listId]);

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
            aria-activedescendant={rows[active] ? `${listId}-${active}` : undefined}
            aria-autocomplete="list"
            aria-label={mode === 'sessions' ? 'Find a session' : 'Search commands'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={mode === 'sessions' ? 'Type an agent name' : 'Spawn an agent, jump to a session, or run a command'}
            className="flex-1 min-w-0 h-full border-0 outline-none bg-transparent text-ink text-[14px] placeholder:text-ink-3 focus-visible:outline-none"
          />
          <Kbd>Esc</Kbd>
        </div>
        <div id={listId} role="listbox" aria-label="Results" className="max-h-[360px] overflow-y-auto py-1.5">
          {rows.length === 0 && <div className="px-4 py-6 text-center text-ink-3 text-[12.5px]">No matches</div>}
          {rows.map((row, i) => {
            const header = row.group !== lastGroup ? row.group : null;
            lastGroup = row.group;
            return (
              <div key={row.id}>
                {header && <div className="px-4 pt-2 pb-1 text-[11px] font-semibold tracking-[0.08em] uppercase text-ink-3">{header}</div>}
                <div
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  onMouseMove={() => setActive(i)}
                  onClick={() => void runRow(row)}
                  className={cn('mx-1.5 flex items-center gap-2.5 h-9 px-2.5 rounded-sm cursor-pointer text-[13px]', i === active ? 'bg-selected text-ink' : 'text-ink-2')}
                >
                  {row.kind === 'command' ? (
                    <>
                      <span className="flex-1 truncate">{row.command.title}</span>
                      {row.command.hint && <Kbd>{row.command.hint}</Kbd>}
                    </>
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
