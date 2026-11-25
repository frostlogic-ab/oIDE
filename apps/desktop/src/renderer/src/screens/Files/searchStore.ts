import { create } from 'zustand';
import type { ContentFileResult, SearchResultsEvent } from '@oide/protocol';
import { ipcErrorMessage, oide } from '../../lib/bridge';

/**
 * Files › Search state: the query and its options, and the streamed results of the current
 * `files.searchContent` (batches arrive as `files.searchResults` events with our `searchId`;
 * batches of any other id are ignored). Wiki: screen-files.md › Search.
 */
export type SearchScope = 'checkout' | 'all';
export type SearchStatus = 'idle' | 'searching' | 'done' | 'error';

export interface SearchForm {
  query: string;
  replacement: string;
  replaceOpen: boolean;
  isRegex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  include: string;
  exclude: string;
  filtersOpen: boolean;
  scope: SearchScope;
}

interface SearchState extends SearchForm {
  open: boolean;
  /** Bumped to focus (and select) the query field. */
  focusNonce: number;
  searchId?: string;
  status: SearchStatus;
  error?: string;
  truncated: boolean;
  files: ContentFileResult[];
  stats?: SearchResultsEvent['stats'];
  /** `${root}::${path}` → collapsed in the results. */
  collapsed: Record<string, boolean>;
  /** The form the current results were searched with (Replace uses exactly these options). */
  ran?: Pick<SearchForm, 'query' | 'isRegex' | 'matchCase' | 'wholeWord'>;

  setOpen(open: boolean): void;
  /** Open (or focus) the panel; with `toggle`, close it when it is open. */
  show(opts?: { toggle?: boolean; query?: string }): void;
  update(patch: Partial<SearchForm>): void;
  run(roots: string[], maxResults?: number): Promise<void>;
  cancel(): void;
  clear(): void;
  toggleCollapsed(key: string): void;
  onBatch(e: SearchResultsEvent): void;
}

export const resultKey = (r: { root: string; path: string }) => `${r.root}::${r.path}`;
export const MAX_RESULTS = 2000;

let seq = 0;

export const useSearch = create<SearchState>()((set, get) => ({
  open: false,
  focusNonce: 0,
  query: '',
  replacement: '',
  replaceOpen: false,
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: '',
  exclude: '',
  filtersOpen: false,
  scope: 'all',
  status: 'idle',
  truncated: false,
  files: [],
  collapsed: {},

  setOpen: (open) => set({ open }),
  show: (opts = {}) => {
    if (opts.toggle && get().open) return set({ open: false });
    set({ open: true, focusNonce: get().focusNonce + 1, ...(opts.query !== undefined ? { query: opts.query } : {}) });
  },
  update: (patch) => set(patch),

  run: async (roots, maxResults = MAX_RESULTS) => {
    const prev = get().searchId;
    if (prev && get().status === 'searching') void oide.invoke('files.cancelSearch', { searchId: prev }).catch(() => {});
    const { query, isRegex, matchCase, wholeWord, include, exclude } = get();
    if (!query || !roots.length) {
      set({ searchId: undefined, status: 'idle', files: [], error: undefined, truncated: false, stats: undefined, ran: undefined });
      return;
    }
    const searchId = `s${Date.now().toString(36)}${(++seq).toString(36)}`;
    set({ searchId, status: 'searching', files: [], error: undefined, truncated: false, stats: undefined, collapsed: {}, ran: { query, isRegex, matchCase, wholeWord } });
    try {
      await oide.invoke('files.searchContent', { searchId, roots, query, isRegex, matchCase, wholeWord, include, exclude, maxResults });
    } catch (err) {
      if (get().searchId === searchId) set({ status: 'error', error: ipcErrorMessage(err) });
    }
  },

  cancel: () => {
    const id = get().searchId;
    if (!id || get().status !== 'searching') return;
    void oide.invoke('files.cancelSearch', { searchId: id }).catch(() => {});
    set({ status: 'done' });
  },

  clear: () => {
    get().cancel();
    set({ query: '', searchId: undefined, status: 'idle', files: [], error: undefined, truncated: false, stats: undefined, ran: undefined });
  },

  toggleCollapsed: (key) => set({ collapsed: { ...get().collapsed, [key]: !get().collapsed[key] } }),

  onBatch: (e) => {
    const s = get();
    if (e.searchId !== s.searchId) return;
    const files = e.files.length ? [...s.files, ...e.files] : s.files;
    if (!e.done) return set({ files, truncated: e.truncated });
    set({
      files,
      truncated: e.truncated,
      stats: e.stats,
      status: e.error ? 'error' : 'done',
      ...(e.error ? { error: e.error } : {}),
    });
  },
}));

export function matchCount(files: readonly ContentFileResult[]): number {
  let n = 0;
  for (const f of files) n += f.matches.length;
  return n;
}
