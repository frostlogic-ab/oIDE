import { create } from 'zustand';
import type { Settings } from '@oide/protocol';
import { setAccent, DEFAULT_ACCENT } from '@oide/ui';
import { isNotImplemented, oide } from '../lib/bridge';

/**
 * Global settings (main owns them; `settings.changed` broadcasts updates). `settings` is null until
 * loaded or when main has no settings service yet; use `useSetting(selector, fallback)`.
 * The accent colour is applied to the document whenever settings change.
 */
interface SettingsState {
  settings: Settings | null;
  load(): Promise<void>;
  /** Deep-merge patch, e.g. `{ ui: { accent: '#7FC8A9' } }` (main validates). */
  update(patch: Record<string, unknown>): Promise<Settings | null>;
  apply(settings: Settings): void;
}

function applyAccent(settings: Settings | null): void {
  if (typeof document !== 'undefined') setAccent(settings?.ui.accent ?? DEFAULT_ACCENT);
}

export const useSettings = create<SettingsState>()((set) => ({
  settings: null,
  load: async () => {
    try {
      const settings = await oide.invoke('settings.get', undefined);
      set({ settings });
      applyAccent(settings);
    } catch (err) {
      if (!isNotImplemented(err)) throw err;
    }
  },
  update: async (patch) => {
    const settings = await oide.invoke('settings.update', { patch });
    set({ settings });
    applyAccent(settings);
    return settings;
  },
  apply: (settings) => {
    set({ settings });
    applyAccent(settings);
  },
}));

/** Read one setting with a fallback while settings are not loaded. */
export function useSetting<T>(select: (s: Settings) => T, fallback: T): T {
  return useSettings((st) => (st.settings ? select(st.settings) : fallback));
}

export function connectSettings(): () => void {
  return oide.on('settings.changed', (s) => useSettings.getState().apply(s));
}
