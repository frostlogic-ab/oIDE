import { create } from 'zustand';
import type { EventPayload, InstalledExtension } from '@oide/protocol';
import { DEFAULT_ACCENT, setAccent } from '@oide/ui';
import { invokeOr, oide } from '../lib/bridge';
import { navigate, useRouter } from '../stores/router';
import { useSettings } from '../stores/settings';
import { findPanel, panelTabId, themeForAccent, themeOptions, THEME_TOKEN_VARS } from './model';
import { connectPanelBridge } from './panelBridge';

type HostState = EventPayload<'extensions.hostState'>;

/** A request to show an inspector panel (from `ctx.panels.open` or a command). Focus's inspector picks it up. */
export interface PanelRequest {
  tab: `ext:${string}`;
  agentId?: string;
  n: number;
}

interface ExtensionsState {
  installed: InstalledExtension[];
  loaded: boolean;
  /** Host code state per extension name (`reloading` shows on its panels). */
  hostState: Record<string, HostState>;
  panelRequest: PanelRequest | null;
  set(list: InstalledExtension[]): void;
  load(): Promise<void>;
}

export const useExtensions = create<ExtensionsState>()((set) => ({
  installed: [],
  loaded: false,
  hostState: {},
  panelRequest: null,
  set: (installed) => set({ installed: Array.isArray(installed) ? installed : [], loaded: true }),
  load: async () => {
    const list = await invokeOr('extensions.installed', undefined, [] as InstalledExtension[]).catch(
      () => [] as InstalledExtension[],
    );
    set({ installed: Array.isArray(list) ? list : [], loaded: true });
  },
}));

let requests = 0;

/**
 * Show a panel: inspector panels open as a tab in Focus (for `agentId`, or the agent already in
 * Focus); without an agent to show them for, and for `screen` panels, they open full screen.
 */
export function openPanel(extension: string, panelId: string, agentId?: string): void {
  const p = findPanel(useExtensions.getState().installed, extension, panelId);
  if (!p) return;
  const route = useRouter.getState().route;
  const focused = route.screen === 'focus' ? route.params.agentId : undefined;
  const target = agentId ?? focused;
  if (p.location === 'inspector' && target) {
    useExtensions.setState({
      panelRequest: { tab: panelTabId(extension, panelId), agentId: target, n: ++requests },
    });
    if (focused !== target) navigate('focus', { agentId: target });
    return;
  }
  navigate('extension', { extension, panelId });
}

/** Apply the allow-listed tokens of the theme whose accent is Settings `ui.accent`. */
export function applyTheme(): void {
  if (typeof document === 'undefined') return;
  const accent = useSettings.getState().settings?.ui.accent ?? DEFAULT_ACCENT;
  const theme = themeForAccent(themeOptions(useExtensions.getState().installed), accent);
  const root = document.documentElement;
  for (const cssVar of Object.values(THEME_TOKEN_VARS))
    if (cssVar !== '--color-accent') root.style.removeProperty(cssVar);
  setAccent(accent, root);
  if (theme) for (const [cssVar, value] of Object.entries(theme.vars)) root.style.setProperty(cssVar, value);
}

/** Subscribe to main's extension events and start the panel bridge. Called once from boot. */
export function connectExtensions(): () => void {
  void useExtensions.getState().load();
  const offs = [
    oide.on('extensions.changed', (list) => useExtensions.getState().set(list)),
    oide.on('extensions.hostState', (s) =>
      useExtensions.setState((st) => ({ hostState: { ...st.hostState, [s.name]: s } })),
    ),
    oide.on('extensions.panelOpen', ({ extension, panelId, agentId }) =>
      openPanel(extension, panelId, agentId),
    ),
    connectPanelBridge(),
    useSettings.subscribe((s, prev) => {
      if (s.settings?.ui.accent !== prev.settings?.ui.accent) applyTheme();
    }),
    useExtensions.subscribe((s, prev) => {
      if (s.installed !== prev.installed) applyTheme();
    }),
  ];
  return () => offs.forEach((o) => o());
}
