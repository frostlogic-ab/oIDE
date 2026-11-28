import { Suspense, lazy, useEffect, useRef, type KeyboardEvent } from 'react';
import { Button, EmptyState, Icon, IconButton, Spinner } from '@oide/ui';
import { useTerminals, type TermSession } from '../../stores/terminals';

/** xterm loads with the first terminal shown. */
const TerminalView = lazy(() => import('./TerminalView'));

/** Groups that already opened their first shell by themselves (Focus), so closing it stays closed. */
const autoStarted = new Set<string>();

export interface TerminalTabsProps {
  /** `files`, or `agent:<id>` for an agent's Focus terminal. */
  group: string;
  /** Names the region ("Terminals in the agent's worktree"). */
  label: string;
  /** Where "New terminal" opens a shell; without it the button is disabled. */
  newCwd?: string;
  /** Shown before a new shell's title (the project and checkout in Files). */
  newContext?: string;
  /** Open one shell by itself the first time the group is shown empty (Focus). */
  autoStart?: boolean;
  visible: boolean;
  /** Files: hides the panel (sessions keep running). */
  onHide?: () => void;
}

/**
 * Several terminals in one place, as in VS Code's terminal panel: a tab per session (a shell, or a
 * script run from Files › Run), a button for a new shell, and a close button per tab that kills its
 * process. Only the active tab's xterm is in the DOM; the others keep running.
 */
export function TerminalTabs({ group, label, newCwd, newContext, autoStart, visible, onHide }: TerminalTabsProps) {
  const g = useTerminals((s) => s.groups[group]);
  const sessions = useTerminals((s) => s.sessions);
  const { openShell, close, setActive } = useTerminals.getState();
  const list = (g?.order ?? []).map((k) => sessions[k]).filter((s): s is TermSession => !!s);
  const active = list.find((s) => s.key === g?.active) ?? list[0];
  const openNew = () => newCwd && openShell(group, newCwd, newContext ? { context: newContext } : undefined);

  useEffect(() => {
    if (!autoStart || !visible || !newCwd || autoStarted.has(group)) return;
    autoStarted.add(group);
    if (!(useTerminals.getState().groups[group]?.order.length ?? 0)) openShell(group, newCwd);
  }, [autoStart, visible, newCwd, group, openShell]);

  const newButtonRef = useRef<HTMLButtonElement | null>(null);

  /** Closes a tab, then keeps keyboard focus in the strip: on the neighbour tab (next, else previous), or the New terminal button. */
  const closeTab = (i: number) => {
    const closing = list[i];
    if (!closing) return;
    // A running script or install (a dev server, a long build) dies with its tab: one stray click or
    // Delete must not cost its output. An idle shell closes without asking, as in VS Code.
    if (closing.kind !== 'shell' && closing.status === 'running' && !window.confirm(`${closing.title} is still running. Stop it and close the tab?`)) return;
    const neighbour = list[i + 1] ?? list[i - 1];
    // Closing a background tab leaves the active one alone; closing the active one hands over to its neighbour.
    const target = closing.key === active?.key ? neighbour : active;
    close(closing.key);
    if (target) setActive(group, target.key);
    requestAnimationFrame(() => {
      (target ? document.getElementById(`term-tab-${target.key}`) : newButtonRef.current)?.focus();
    });
  };

  const onTabKey = (e: KeyboardEvent, i: number) => {
    const to = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (e.key === 'Delete') {
      e.preventDefault();
      closeTab(i);
      return;
    }
    if (to === null || !list.length) return;
    e.preventDefault();
    const next = list[(to + list.length) % list.length]!;
    setActive(group, next.key);
    document.getElementById(`term-tab-${next.key}`)?.focus();
  };

  return (
    <section aria-label={label} className="flex-1 min-h-0 flex flex-col">
      <div className="flex items-center gap-0.5 h-8 pl-1 pr-1.5 border-b border-line bg-panel shrink-0">
        <div role="tablist" aria-label={`${label}: open terminals`} className="flex-1 min-w-0 flex items-stretch h-full overflow-x-auto [scrollbar-width:none]">
          {list.map((s, i) => {
            const selected = s.key === active?.key;
            return (
              <div key={s.key} className={`group flex items-center shrink-0 border-b-2 ${selected ? 'border-accent text-ink' : 'border-transparent text-ink-3 hover:text-ink-2'}`}>
                <button
                  type="button"
                  role="tab"
                  id={`term-tab-${s.key}`}
                  aria-selected={selected}
                  aria-controls={`term-panel-${group}`}
                  tabIndex={selected ? 0 : -1}
                  title={`${s.script ? s.script.command : 'Shell'} · ${s.cwd}${statusText(s) ? ` · ${statusText(s)}` : ''}`}
                  onClick={() => setActive(group, s.key)}
                  onKeyDown={(e) => onTabKey(e, i)}
                  className="h-full flex items-center gap-1.5 pl-2 pr-1 border-0 bg-transparent text-inherit text-[12px] whitespace-nowrap cursor-pointer"
                >
                  <Icon name={s.kind === 'script' ? 'play' : s.kind === 'install' ? 'download' : 'terminal'} size={12} className={dotClass(s)} />
                  {s.context && <span className="text-ink-3">{s.context} ›</span>}
                  <span className={s.kind === 'script' ? 'font-mono text-[11.5px]' : undefined}>{s.title}</span>
                  {statusText(s) && <span className={`text-[11px] ${s.status === 'error' || (s.exitCode ?? 0) !== 0 ? 'text-bad' : 'text-ink-3'}`}>{statusText(s)}</span>}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${s.context ? `${s.context} › ` : ''}${s.title}`}
                  title={s.status === 'running' ? 'Close and stop the process' : 'Close'}
                  onClick={() => closeTab(i)}
                  className={`w-5 h-5 mr-1 flex items-center justify-center rounded-xs border-0 bg-transparent text-ink-3 cursor-pointer hover:bg-raised hover:text-ink ${selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            );
          })}
        </div>
        <IconButton ref={newButtonRef} icon="plus" aria-label="New terminal" title={newCwd ? `New terminal in ${newCwd}` : 'New terminal'} disabled={!newCwd} onClick={openNew} />
        {onHide && <IconButton icon="chevron-down" aria-label="Hide the terminal panel" title="Hide the terminal panel (terminals keep running)" onClick={onHide} />}
      </div>
      <div id={`term-panel-${group}`} role="tabpanel" aria-labelledby={active ? `term-tab-${active.key}` : undefined} className="flex-1 min-h-0 flex flex-col">
        {active ? (
          <Suspense
            fallback={
              <div className="p-4">
                <Spinner size={14} label="Loading the terminal" />
              </div>
            }
          >
            <TerminalView key={active.key} session={active} visible={visible} label={`${active.title} terminal, in ${active.cwd}`} />
          </Suspense>
        ) : (
          <EmptyState
            icon="terminal"
            title="No terminals open"
            description={newCwd ? 'Open a shell here, or run a script from Files › Run.' : 'A terminal opens once there is a folder to run it in.'}
            action={newCwd ? <Button variant="secondary" size={28} icon="plus" onClick={openNew}>New terminal</Button> : undefined}
            className="flex-1"
          />
        )}
      </div>
    </section>
  );
}

function statusText(s: TermSession): string {
  if (s.status === 'error') return 'failed';
  if (s.status !== 'exited') return '';
  return s.exitCode === null || s.exitCode === undefined ? 'exited' : `exited ${s.exitCode}`;
}

function dotClass(s: TermSession): string {
  if (s.status === 'error' || (s.status === 'exited' && (s.exitCode ?? 0) !== 0)) return 'text-bad';
  if (s.status === 'exited') return 'text-ink-4';
  return s.kind === 'shell' ? 'text-ink-3' : 'text-ok';
}
