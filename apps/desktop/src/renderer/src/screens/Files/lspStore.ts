/**
 * Language-server state the Files screen shows outside Monaco (ADR 0019): the server status of
 * each open document (tab bar) and the diagnostics main streams per file (`lsp.diagnostics`),
 * which tint the tree like VS Code's problem decorations and fill the Problems list. Lives outside
 * the Monaco chunk so the tree can read it before an editor exists.
 */
import { create } from 'zustand';
import type { LspDiagnostic, LspStatus } from '@oide/protocol';
import { oide } from '../../lib/bridge';

export const docKey = (root: string, path: string) => `${root}\0${path}`;

export interface FileProblems {
  errors: number;
  warnings: number;
  list: LspDiagnostic[];
}

interface LspStoreState {
  /** `docKey(root, path)` → that file's diagnostics (files without any are absent). */
  problems: Record<string, FileProblems>;
  /** `docKey(root, path)` → the server state of an open document. */
  status: Record<string, LspStatus>;
  setProblems(root: string, path: string, list: LspDiagnostic[]): void;
  setStatus(root: string, path: string, status: LspStatus | undefined): void;
  /** A server for (`root`, `language`) changed state: every open document it serves follows. */
  applyState(root: string, language: string, status: LspStatus): void;
}

export const useLsp = create<LspStoreState>()((set) => ({
  problems: {},
  status: {},
  setProblems: (root, path, list) =>
    set((s) => {
      const key = docKey(root, path);
      if (!list.length) {
        if (!s.problems[key]) return s;
        const next = { ...s.problems };
        delete next[key];
        return { problems: next };
      }
      const errors = list.filter((d) => d.severity === 1).length;
      const warnings = list.filter((d) => d.severity === 2).length;
      return { problems: { ...s.problems, [key]: { errors, warnings, list } } };
    }),
  setStatus: (root, path, status) =>
    set((s) => {
      const key = docKey(root, path);
      const next = { ...s.status };
      if (status) next[key] = status;
      else delete next[key];
      return { status: next };
    }),
  applyState: (root, language, status) =>
    set((s) => {
      let changed = false;
      const next = { ...s.status };
      for (const [key, cur] of Object.entries(s.status)) {
        if (key.slice(0, key.indexOf('\0')) !== root || cur.language !== language) continue;
        next[key] = status;
        changed = true;
      }
      return changed ? { status: next } : s;
    }),
}));

let subscribed = false;
const listeners = new Set<(root: string, path: string, list: LspDiagnostic[]) => void>();

/** Diagnostics as they arrive (the Monaco side sets its markers from these). */
export function onDiagnostics(fn: (root: string, path: string, list: LspDiagnostic[]) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Subscribe to `lsp.diagnostics` / `lsp.state` once for the window. */
export function ensureLspEvents(): void {
  if (subscribed) return;
  subscribed = true;
  oide.on('lsp.diagnostics', (e) => {
    useLsp.getState().setProblems(e.root, e.path, e.diagnostics);
    for (const fn of listeners) fn(e.root, e.path, e.diagnostics);
  });
  oide.on('lsp.state', (e) => {
    const { root, language, ...status } = e;
    useLsp.getState().applyState(root, language, { ...status, language });
  });
}

export type ProblemLevel = 'error' | 'warning';

export interface RootProblems {
  files: Map<string, { errors: number; warnings: number }>;
  /** Folder → the worst level of the files under it. */
  dirs: Map<string, ProblemLevel>;
}

/** Problems of one checkout, with the folders above each file (VS Code tints those too). */
export function problemsOf(problems: Record<string, FileProblems>, root: string): RootProblems {
  const out: RootProblems = { files: new Map(), dirs: new Map() };
  const prefix = `${root}\0`;
  for (const [key, p] of Object.entries(problems)) {
    if (!key.startsWith(prefix) || (!p.errors && !p.warnings)) continue;
    const path = key.slice(prefix.length);
    out.files.set(path, { errors: p.errors, warnings: p.warnings });
    const level: ProblemLevel = p.errors ? 'error' : 'warning';
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (out.dirs.get(dir) !== 'error') out.dirs.set(dir, level);
    }
  }
  return out;
}

/** "2 errors, 1 warning". */
export function problemSummary(p: { errors: number; warnings: number }): string {
  const parts: string[] = [];
  if (p.errors) parts.push(`${p.errors} error${p.errors === 1 ? '' : 's'}`);
  if (p.warnings) parts.push(`${p.warnings} warning${p.warnings === 1 ? '' : 's'}`);
  return parts.join(', ');
}
