import { create } from 'zustand';
import type { Project } from '@oide/protocol';
import { invokeOr, oide } from '../lib/bridge';

interface ProjectsState {
  list: Project[];
  loaded: boolean;
  load(): Promise<void>;
  /** Opens a folder (picker when `path` is omitted). Returns the project, or null if cancelled. */
  open(path?: string): Promise<Project | null>;
  remove(projectId: string): Promise<void>;
  set(list: Project[]): void;
}

export const useProjects = create<ProjectsState>()((set) => ({
  list: [],
  loaded: false,
  load: async () => {
    const list = await invokeOr('projects.list', undefined, []);
    set({ list, loaded: true });
  },
  open: async (path) => {
    const project = await oide.invoke('projects.open', path ? { path } : {});
    if (project) set((s) => ({ list: s.list.some((p) => p.id === project.id) ? s.list : [...s.list, project] }));
    return project;
  },
  remove: async (projectId) => {
    await oide.invoke('projects.remove', { projectId });
    set((s) => ({ list: s.list.filter((p) => p.id !== projectId) }));
  },
  set: (list) => set({ list, loaded: true }),
}));

export function projectName(list: Project[], projectId: string | undefined): string {
  return list.find((p) => p.id === projectId)?.name ?? projectId ?? '';
}

export function connectProjects(): () => void {
  return oide.on('projects.changed', (list) => useProjects.getState().set(list));
}
