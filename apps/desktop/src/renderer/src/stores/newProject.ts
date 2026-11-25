import { create } from 'zustand';
import type { Project } from '@oide/protocol';

/** The New project dialog's ways in: an existing folder, a clone, or a new repository. */
export type NewProjectTab = 'open' | 'clone' | 'create';

interface NewProjectState {
  open: boolean;
  tab: NewProjectTab;
  show(tab?: NewProjectTab): void;
  hide(): void;
  setTab(tab: NewProjectTab): void;
}

/** One dialog for the whole app (mounted in App.tsx); every "Open project" / "+" opens it. */
export const useNewProject = create<NewProjectState>()((set) => ({
  open: false,
  tab: 'open',
  show: (tab) => set((s) => ({ open: true, tab: tab ?? s.tab })),
  hide: () => set({ open: false }),
  setTab: (tab) => set({ tab }),
}));

export function openNewProject(tab: NewProjectTab = 'open'): void {
  useNewProject.getState().show(tab);
}

const PARENT_KEY = 'oide.newProject.parent';

/** Where clones and new repositories go: the last location used, else the folder that holds the first project. */
export function defaultParent(projects: readonly Project[]): string {
  try {
    const saved = localStorage.getItem(PARENT_KEY);
    if (saved) return saved;
  } catch {
    // Storage unavailable (tests, private mode): fall through.
  }
  const first = projects[0]?.path;
  return first ? parentOf(first) : '';
}

export function rememberParent(parent: string): void {
  try {
    localStorage.setItem(PARENT_KEY, parent);
  } catch {
    // Not fatal: the next dialog asks again.
  }
}

/** `C:\a\b` → `C:\a`, `/a/b` → `/a` (renderer has no node:path). */
export function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (i <= 0) return trimmed.slice(0, i + 1) || trimmed;
  const head = trimmed.slice(0, i);
  return /^[A-Za-z]:$/.test(head) ? `${head}\\` : head;
}

/** `parent` + `name` with the separator `parent` already uses. */
export function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  const sep = parent.includes('\\') ? '\\' : '/';
  return parent.endsWith(sep) ? `${parent}${name}` : `${parent}${sep}${name}`;
}
