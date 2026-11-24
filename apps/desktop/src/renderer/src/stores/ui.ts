import { create } from 'zustand';
import { oide } from '../lib/bridge';

export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

export interface Toast {
  id: number;
  level: ToastLevel;
  message: string;
  agentId?: string;
  action?: { label: string; run: () => void };
  /** ms; 0 = sticky. Default 6000 (errors 10000). */
  duration?: number;
}

export type CommandBarMode = 'commands' | 'sessions';
export type HeaderSlotName = 'title' | 'actions';

interface UiState {
  toasts: Toast[];
  pushToast(t: Omit<Toast, 'id'>): number;
  dismissToast(id: number): void;

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

export const useUi = create<UiState>()((set, get) => ({
  toasts: [],
  pushToast: (t) => {
    const id = nextToastId++;
    set({ toasts: [...get().toasts, { ...t, id }].slice(-5) });
    const duration = t.duration ?? (t.level === 'error' ? 10000 : 6000);
    if (duration > 0) timers.set(id, setTimeout(() => get().dismissToast(id), duration));
    return id;
  },
  dismissToast: (id) => {
    const timer = timers.get(id);
    if (timer) clearTimeout(timer);
    timers.delete(id);
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
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
}));

export const toast = (message: string, level: ToastLevel = 'info', extra: Partial<Omit<Toast, 'id' | 'message' | 'level'>> = {}) =>
  useUi.getState().pushToast({ message, level, ...extra });

/** Render main's `notify` events as toasts. */
export function connectNotifications(): () => void {
  return oide.on('notify', ({ level, message, agentId }) => {
    useUi.getState().pushToast({ level, message, agentId });
  });
}
