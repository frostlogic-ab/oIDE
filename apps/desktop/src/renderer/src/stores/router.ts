import { create } from 'zustand';
import type { ContextChip, UsageRange } from '@oide/protocol';

/**
 * Typed in-app router. No URLs: a screen id plus typed params, with a back/forward history
 * (Alt+Left / Alt+Right). Screens live in src/renderer/src/screens/<Name>/index.tsx and are
 * listed in screens/registry.tsx.
 */
export interface ScreenParams {
  wall: Record<string, never>;
  focus: { agentId: string; subagentId?: string };
  /**
   * `context`: chips to pre-fill (Artifacts › Give to an agent passes the artifact). `card`: the board
   * card the agent is started from (Start an agent): the new agents are linked to it on the board.
   */
  spawn: { projectId?: string; goal?: string; context?: ContextChip[]; card?: { boardId: string; cardId: string } };
  'source-control': Record<string, never>;
  /** `path`: a changed file to open on (Focus > Inspector rows); falls back to the first file if it is not in the diff. */
  review: { agentId: string; path?: string };
  files: { root?: string; path?: string; line?: number };
  artifacts: { artifactId?: string };
  marketplace: { extension?: string };
  settings: { section?: string };
  /** Usage stats (status bar › Tokens today); `range` defaults to 7 days. */
  usage: { range?: UsageRange };
  /** A full-screen extension panel (`contributes.panels` with `location: "screen"`). */
  extension: { extension: string; panelId: string };
}

export type ScreenId = keyof ScreenParams;

export type Route = { [K in ScreenId]: { screen: K; params: ScreenParams[K] } }[ScreenId];

export const SCREEN_IDS: ScreenId[] = ['wall', 'focus', 'spawn', 'source-control', 'review', 'files', 'artifacts', 'marketplace', 'settings', 'usage', 'extension'];

interface RouterState {
  route: Route;
  back: Route[];
  forward: Route[];
  navigate<K extends ScreenId>(screen: K, ...params: ScreenParams[K] extends Record<string, never> ? [] | [ScreenParams[K]] : [ScreenParams[K]]): void;
  /** Replace the current route without adding history (e.g. J/K moving between agents in Focus). */
  replace<K extends ScreenId>(screen: K, ...params: ScreenParams[K] extends Record<string, never> ? [] | [ScreenParams[K]] : [ScreenParams[K]]): void;
  goBack(): void;
  goForward(): void;
}

const MAX_HISTORY = 50;

function sameRoute(a: Route, b: Route): boolean {
  return a.screen === b.screen && JSON.stringify(a.params) === JSON.stringify(b.params);
}

export const useRouter = create<RouterState>()((set, get) => ({
  route: { screen: 'wall', params: {} },
  back: [],
  forward: [],
  navigate: (screen, ...rest) => {
    const next = { screen, params: rest[0] ?? {} } as Route;
    const { route, back } = get();
    if (sameRoute(route, next)) return;
    set({ route: next, back: [...back, route].slice(-MAX_HISTORY), forward: [] });
  },
  replace: (screen, ...rest) => {
    set({ route: { screen, params: rest[0] ?? {} } as Route });
  },
  goBack: () => {
    const { route, back, forward } = get();
    const prev = back[back.length - 1];
    if (!prev) return;
    set({ route: prev, back: back.slice(0, -1), forward: [route, ...forward].slice(0, MAX_HISTORY) });
  },
  goForward: () => {
    const { route, back, forward } = get();
    const next = forward[0];
    if (!next) return;
    set({ route: next, back: [...back, route].slice(-MAX_HISTORY), forward: forward.slice(1) });
  },
}));

/** Non-hook helper for commands and keymap handlers. */
export const navigate: RouterState['navigate'] = (...args) => useRouter.getState().navigate(...args);
