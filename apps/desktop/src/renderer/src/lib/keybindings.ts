import type { Settings } from '@oide/protocol';
import { useSettings } from '../stores/settings';
import { toast } from '../stores/ui';
import { ipcErrorMessage } from './bridge';
import { keymap, type Keymap, type KeybindingPatch } from './keymap';

/** Where older builds kept rebinds (browser storage). Moved into Settings once, then removed. */
export const LEGACY_STORAGE_KEY = 'oide.keybindings';

function takeLegacy(): Record<string, string[]> | undefined {
  try {
    if (typeof localStorage === 'undefined') return undefined;
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (raw === null) return undefined;
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const out: Record<string, string[]> = {};
    for (const [action, combos] of Object.entries(parsed)) {
      if (Array.isArray(combos) && combos.every((c) => typeof c === 'string' && c.length > 0)) out[action] = combos.slice(0, 4) as string[];
    }
    return Object.keys(out).length ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keyboard shortcut rebinds live in Settings (`keybindings`): the keymap follows `settings.changed`
 * and every rebind is saved with `settings.update`. Called once from boot.
 */
export function connectKeybindings(km: Keymap = keymap): () => void {
  const save = (patch: KeybindingPatch) => {
    useSettings
      .getState()
      .update({ keybindings: patch })
      .catch((err: unknown) => toast(`Could not save the shortcut: ${ipcErrorMessage(err)}`, 'error'));
  };
  km.setPersist(save);

  let migrated = false;
  const apply = (s: Settings | null) => {
    if (!s) return;
    km.setOverrides(s.keybindings ?? {});
    if (migrated) return;
    migrated = true;
    const legacy = takeLegacy();
    // Saved rebinds in Settings win; browser storage only fills an empty set.
    if (legacy && Object.keys(s.keybindings ?? {}).length === 0) {
      km.setOverrides(legacy);
      save(legacy);
    }
  };
  apply(useSettings.getState().settings);
  const off = useSettings.subscribe((st, prev) => {
    if (st.settings !== prev.settings) apply(st.settings);
  });
  return () => {
    off();
    km.setPersist(null);
  };
}
