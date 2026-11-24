import { create } from 'zustand';

/**
 * Expanded / collapsed state of transcript parts (subagent cards, tool output, thinking, long diffs),
 * kept outside the rows so it survives virtualization unmounting them. Keys are row-local
 * ("sub:<toolUseId>", "out:<toolUseId>", …). `undefined` means "use the default".
 */
interface FocusUiState {
  expanded: Record<string, boolean>;
  setExpanded(key: string, open: boolean): void;
}

export const useFocusUi = create<FocusUiState>()((set, get) => ({
  expanded: {},
  setExpanded: (key, open) => set({ expanded: { ...get().expanded, [key]: open } }),
}));

/** `[open, toggle]` for one key, with a default while the user has not toggled it. */
export function useExpanded(key: string, fallback = false): [boolean, () => void] {
  const value = useFocusUi((s) => s.expanded[key]);
  const open = value ?? fallback;
  return [open, () => useFocusUi.getState().setExpanded(key, !open)];
}
