/**
 * Pure helpers for the Files editor's changes view: a changed file (git colours of the tree) opens on
 * its diff against the version `files.changes` compares against, unified or side by side.
 */
import type { FileChange, FileChangeStatus } from '@oide/protocol';

export type DiffLayout = 'unified' | 'split';
/** `off`: the plain editor (or the Markdown preview). */
export type DiffView = 'off' | DiffLayout;

/** Statuses with a "before" worth comparing against: new files are all additions, deleted ones do not open. */
const DIFFABLE: ReadonlySet<FileChangeStatus> = new Set(['modified', 'renamed', 'conflicted']);

export const canShowDiff = (change: FileChange | undefined): change is FileChange => Boolean(change && DIFFABLE.has(change.status));

/**
 * How a tab shows: the user's choice for that tab, else the last layout they picked (a changed file
 * opens on its changes). A file without changes always shows the plain editor.
 */
export function effectiveDiffView(chosen: DiffView | undefined, layout: DiffLayout, change: FileChange | undefined): DiffView {
  if (!canShowDiff(change)) return 'off';
  return chosen ?? layout;
}

const LAYOUT_KEY = 'oide.files.diffLayout';

export function loadDiffLayout(): DiffLayout {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(LAYOUT_KEY) : null;
    return raw === 'split' ? 'split' : 'unified';
  } catch {
    return 'unified';
  }
}

export function saveDiffLayout(layout: DiffLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    /* private window or blocked storage: the choice lasts for this session */
  }
}
