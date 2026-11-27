import { create } from 'zustand';
import { oide } from '../lib/bridge';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

/** What a toast announces, so it can be retired when that thing is over. */
export type ToastKind = 'needs-permission' | 'ready-for-review' | 'agent-error';

export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
  agentId?: string;
  action?: { label: string; run: () => void };
  /** A second answer (a question's "No"); shown in place of Dismiss, and closes the toast too. */
  secondary?: { label: string; run: () => void };
  /** ms; 0 = sticky (closed with its button). Defaults: `TOAST_DURATION`. */
  duration?: number;
  /** Toasts with the same key are one toast: a repeat refreshes it instead of stacking. */
  key?: string;
  kind?: ToastKind;
  /** The permission request a `needs-permission` toast is for. */
  requestId?: string;
  /** How many times the same toast was raised (shown as "×2"). */
  count?: number;
}

/** Info and success go quickly, warnings stay longer, errors stay until closed. */
export const TOAST_DURATION: Readonly<Record<ToastLevel, number>> = { info: 5000, success: 5000, warning: 10000, error: 0 };
/** At most this many toasts are on screen; the oldest non-error one gives way first. */
export const MAX_TOASTS = 3;

export type CommandBarMode = 'commands' | 'sessions';
export type HeaderSlotName = 'title' | 'actions';

interface UiState {
  toasts: Toast[];
  /** Adds (or refreshes a duplicate of) a toast; returns its id. */
  pushToast(t: Omit<Toast, 'id' | 'count'>): number;
  dismissToast(id: number): void;
  /** Hover or focus holds a toast on screen; leaving restarts its timer. */
  holdToast(id: number): void;
  releaseToast(id: number): void;

  commandBar: { open: boolean; mode: CommandBarMode; query: string };
  openCommandBar(mode?: CommandBarMode, query?: string): void;
  closeCommandBar(): void;
  setCommandQuery(query: string): void;

  /** DOM nodes of the header slots, registered by the Header (see components/frame/HeaderSlot). */
  headerSlots: Partial<Record<HeaderSlotName, HTMLElement | null>>;
  setHeaderSlot(name: HeaderSlotName, el: HTMLElement | null): void;
}

let nextToastId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

const toastKey = (t: Omit<Toast, 'id' | 'count'>) => t.key ?? `${t.level}|${t.agentId ?? ''}|${t.message}`;
const durationOf = (t: Toast) => t.duration ?? TOAST_DURATION[t.level];

function clearTimer(id: number): void {
  const timer = timers.get(id);
  if (timer) clearTimeout(timer);
  timers.delete(id);
}

export const useUi = create<UiState>()((set, get) => {
  const arm = (t: Toast) => {
    clearTimer(t.id);
    const ms = durationOf(t);
    if (ms > 0) timers.set(t.id, setTimeout(() => get().dismissToast(t.id), ms));
  };
  return {
    toasts: [],
    pushToast: (input) => {
      const key = toastKey(input);
      const list = get().toasts;
      const same = list.find((t) => toastKey(t) === key);
      let toast: Toast;
      if (same) {
        // Dedupe: refresh the existing toast (newest text, timer restarted) and make it the newest.
        toast = { ...same, ...input, id: same.id, count: same.message === input.message ? (same.count ?? 1) + 1 : 1 };
      } else {
        toast = { ...input, id: nextToastId++, count: 1 };
      }
      let next = [...list.filter((t) => t.id !== toast.id), toast];
      while (next.length > MAX_TOASTS) {
        const drop = next.find((t) => t.level !== 'error' && t.id !== toast.id) ?? next[0]!;
        clearTimer(drop.id);
        next = next.filter((t) => t !== drop);
      }
      set({ toasts: next });
      arm(toast);
      return toast.id;
    },
    dismissToast: (id) => {
      clearTimer(id);
      if (!get().toasts.some((t) => t.id === id)) return;
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
    holdToast: (id) => clearTimer(id),
    releaseToast: (id) => {
      const t = get().toasts.find((x) => x.id === id);
      if (t) arm(t);
    },

    commandBar: { open: false, mode: 'commands', query: '' },
    openCommandBar: (mode = 'commands', query = '') => set({ commandBar: { open: true, mode, query } }),
    closeCommandBar: () => set({ commandBar: { open: false, mode: 'commands', query: '' } }),
    setCommandQuery: (query) => set({ commandBar: { ...get().commandBar, query } }),

    headerSlots: {},
    setHeaderSlot: (name, el) => {
      if (get().headerSlots[name] === el) return;
      set({ headerSlots: { ...get().headerSlots, [name]: el } });
    },
  };
});

export const toast = (message: string, level: ToastLevel = 'info', extra: Partial<Omit<Toast, 'id' | 'message' | 'level' | 'count'>> = {}) =>
  useUi.getState().pushToast({ message, level, ...extra });

/** Where the user is looking, for `promptOnScreen`. */
export interface ToastView {
  route: { screen: string; params?: { agentId?: string } };
  scope: string;
  /** The agent's project, when the agent is known. */
  projectId?: string;
}

/**
 * True when the agent's permission prompt is already on screen: its tile on the Wall (in scope) or
 * its own Focus view. A toast would only repeat it, and at small sizes it covered the tile's buttons.
 */
export function promptOnScreen(agentId: string, v: ToastView): boolean {
  if (v.route.screen === 'focus') return v.route.params?.agentId === agentId;
  if (v.route.screen === 'wall') return v.scope === 'all' || (v.projectId !== undefined && v.scope === v.projectId);
  return false;
}

/**
 * Render main's `notify` events as toasts. One needs-permission toast per agent (a newer prompt
 * replaces it); none while that prompt is already on screen (`onScreen`).
 */
export function connectNotifications(onScreen: (agentId: string) => boolean = () => false): () => void {
  return oide.on('notify', ({ level, message, agentId, kind, requestId }) => {
    if (kind === 'needs-permission' && agentId && onScreen(agentId)) return;
    useUi.getState().pushToast({
      level,
      message,
      ...(agentId ? { agentId } : {}),
      ...(kind ? { kind } : {}),
      ...(requestId ? { requestId } : {}),
      ...(kind && agentId ? { key: `${kind}:${agentId}` } : {}),
    });
  });
}

/** The part of an agent summary that decides whether its toasts still apply. */
export interface ToastAgentState {
  status: string;
  pendingPermission?: { requestId: string };
}

/**
 * Retire toasts whose subject is over: a needs-permission toast goes when its prompt is answered
 * (or replaced, or the agent is removed); a ready-for-review toast goes when the agent starts working again.
 * `loaded` is false while the agents list is still loading, so unknown agents are not taken as removed.
 */
export function retireStaleToasts(byId: Readonly<Record<string, ToastAgentState | undefined>>, loaded = true): void {
  const { toasts, dismissToast } = useUi.getState();
  for (const t of toasts) {
    if (!t.kind || !t.agentId) continue;
    const a = byId[t.agentId];
    if (!a) {
      if (loaded) dismissToast(t.id);
      continue;
    }
    if (t.kind === 'needs-permission') {
      const pending = a.pendingPermission?.requestId;
      if (t.requestId ? pending !== t.requestId : a.status !== 'needs-permission') dismissToast(t.id);
    } else if (t.kind === 'ready-for-review' && a.status !== 'ready-for-review') {
      dismissToast(t.id);
    }
  }
}
