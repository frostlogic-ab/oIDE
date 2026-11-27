import { create } from 'zustand';
import type { ProjectScript } from '@oide/protocol';
import { oide } from '../lib/bridge';
import { useAgents } from './agents';

/**
 * Terminal sessions, grouped by where they show: `files` (the Files screen's Terminal panel) and
 * `agent:<id>` (Focus › Inspector › Terminal). A session outlives the view that shows it, so a dev
 * server keeps running when you switch screens or agents; it ends when its tab is closed, or when
 * the agent whose worktree it runs in is archived or removed (a shell would hold the folder open).
 *
 * The pty itself is started by the view once xterm has measured its size (components/terminal/
 * TerminalView.tsx, which loads xterm lazily); this store only holds what the tabs show.
 */

export type TermStatus = 'starting' | 'running' | 'exited' | 'error';

export interface TermSession {
  key: string;
  group: string;
  cwd: string;
  /** Tab label: the script's name, or "Terminal N". */
  title: string;
  /** Shown before the title, dimmed (the project and checkout in Files). */
  context?: string;
  kind: 'shell' | 'script';
  /** For `kind: 'script'`: what main runs (it finds the script again by id). */
  script?: Pick<ProjectScript, 'id' | 'name' | 'command' | 'runner'>;
  terminalId?: string;
  status: TermStatus;
  exitCode?: number | null;
  error?: string;
}

export interface TermGroup {
  order: string[];
  active?: string;
  /** Files: the Terminal panel is shown. */
  open: boolean;
  /** Files: the panel's height in px. */
  height?: number;
  /** "Terminal N" counter, so closed numbers are not reused at once (as in VS Code). */
  seq: number;
}

export interface OpenOptions {
  context?: string;
}

interface TerminalsState {
  sessions: Record<string, TermSession>;
  groups: Record<string, TermGroup>;
  /** A new interactive shell in `cwd`; becomes the group's active tab and opens its panel. */
  openShell(group: string, cwd: string, opts?: OpenOptions): string;
  /** A new terminal that runs `script` in `cwd` (VS Code's Run Script). */
  runScript(group: string, cwd: string, script: ProjectScript, opts?: OpenOptions): string;
  /** Kills the session's process and drops its tab; the neighbour tab becomes active. */
  close(key: string): void;
  closeWhere(pred: (s: TermSession) => boolean): void;
  setActive(group: string, key: string): void;
  setPanelOpen(group: string, open: boolean): void;
  setHeight(group: string, height: number): void;
  // ---- used by TerminalView
  started(key: string, terminalId: string): void;
  failed(key: string, error: string): void;
  exited(terminalId: string, code: number | null): void;
}

let nextKey = 0;
const disposers = new Map<string, () => void>();

/** TerminalView registers how to dispose a session's xterm; called when the session closes. */
export function onSessionDisposed(key: string, fn: () => void): void {
  disposers.set(key, fn);
}

const emptyGroup = (): TermGroup => ({ order: [], open: false, seq: 0 });

export const useTerminals = create<TerminalsState>((set, get) => {
  const add = (group: string, make: (g: TermGroup) => Omit<TermSession, 'key' | 'group' | 'status'>): string => {
    const key = `term-${++nextKey}`;
    set((st) => {
      const g = st.groups[group] ?? emptyGroup();
      const seq = g.seq + 1;
      const session: TermSession = { key, group, status: 'starting', ...make({ ...g, seq }) };
      return {
        sessions: { ...st.sessions, [key]: session },
        groups: { ...st.groups, [group]: { ...g, seq, order: [...g.order, key], active: key, open: true } },
      };
    });
    return key;
  };

  return {
    sessions: {},
    groups: {},
    openShell: (group, cwd, opts) => add(group, (g) => ({ cwd, kind: 'shell', title: `Terminal ${g.seq}`, ...(opts?.context ? { context: opts.context } : {}) })),
    runScript: (group, cwd, script, opts) =>
      add(group, () => ({
        cwd,
        kind: 'script',
        title: script.name,
        script: { id: script.id, name: script.name, command: script.command, runner: script.runner },
        ...(opts?.context ? { context: opts.context } : {}),
      })),
    close: (key) => {
      const s = get().sessions[key];
      if (!s) return;
      if (s.terminalId && s.status === 'running') void oide.invoke('terminal.kill', { terminalId: s.terminalId }).catch(() => {});
      disposers.get(key)?.();
      disposers.delete(key);
      set((st) => {
        const sessions = { ...st.sessions };
        delete sessions[key];
        const g = st.groups[s.group] ?? emptyGroup();
        const i = g.order.indexOf(key);
        const order = g.order.filter((k) => k !== key);
        const active = g.active === key ? (order[Math.min(i, order.length - 1)] ?? undefined) : g.active;
        return { sessions, groups: { ...st.groups, [s.group]: { ...g, order, active } } };
      });
    },
    closeWhere: (pred) => {
      for (const s of Object.values(get().sessions)) if (pred(s)) get().close(s.key);
    },
    setActive: (group, key) =>
      set((st) => {
        const g = st.groups[group];
        if (!g || !g.order.includes(key) || g.active === key) return st;
        return { groups: { ...st.groups, [group]: { ...g, active: key } } };
      }),
    setPanelOpen: (group, open) =>
      set((st) => {
        const g = st.groups[group] ?? emptyGroup();
        return g.open === open ? st : { groups: { ...st.groups, [group]: { ...g, open } } };
      }),
    setHeight: (group, height) =>
      set((st) => {
        const g = st.groups[group] ?? emptyGroup();
        return { groups: { ...st.groups, [group]: { ...g, height } } };
      }),
    started: (key, terminalId) => patch(key, { terminalId, status: 'running' }),
    failed: (key, error) => patch(key, { status: 'error', error }),
    exited: (terminalId, code) => {
      const s = Object.values(get().sessions).find((x) => x.terminalId === terminalId);
      if (s) patch(s.key, { status: 'exited', exitCode: code });
    },
  };

  function patch(key: string, p: Partial<TermSession>): void {
    set((st) => {
      const s = st.sessions[key];
      return s ? { sessions: { ...st.sessions, [key]: { ...s, ...p } } } : st;
    });
  }
});

export const normPath = (p: string): string => p.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();

/** Is `p` the folder `root` or inside it? */
export function isInside(p: string, root: string): boolean {
  const a = normPath(p);
  const b = normPath(root);
  return a === b || a.startsWith(`${b}/`);
}

// An agent that is archived or removed loses its worktree: close the shells that run in it (and its
// Focus terminals), or Windows could not delete the folder they hold open.
let worktrees = new Map<string, string | undefined>();
useAgents.subscribe((st) => {
  const next = new Map<string, string | undefined>();
  for (const a of Object.values(st.byId)) next.set(a.id, a.worktreePath);
  for (const [id, path] of worktrees) {
    if (next.has(id) && next.get(id) === path) continue;
    useTerminals.getState().closeWhere((s) => s.group === `agent:${id}` || (!!path && !next.has(id) && isInside(s.cwd, path)));
  }
  worktrees = next;
});
