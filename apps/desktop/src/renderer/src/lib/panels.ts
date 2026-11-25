import { PANEL_WIDTH_LIMITS } from '@oide/protocol';

/**
 * Every resizable sidebar in the app. `side` is where the sidebar sits, so its resize edge is the
 * opposite one (a left sidebar is dragged by its right edge). `min` is the narrowest width at which
 * the sidebar's content still fits; `max` keeps the main area usable. The user's widths are stored
 * in `settings.ui.panelWidths[id]` (see `usePanelWidth`).
 */
export interface PanelSpec {
  id: string;
  side: 'left' | 'right';
  /** Lower-case name used in the handle's label ("Resize the projects sidebar"). */
  label: string;
  defaultWidth: number;
  min: number;
  max: number;
}

const panel = (id: string, side: PanelSpec['side'], label: string, defaultWidth: number, min: number, max: number): PanelSpec => ({ id, side, label, defaultWidth, min, max });

export const PANELS = {
  wallProjects: panel('wall.projects', 'left', 'projects sidebar', 248, 200, 520),
  wallArtifacts: panel('wall.artifacts', 'right', 'artifacts sidebar', 280, 240, 560),
  focusAgents: panel('focus.agents', 'left', 'agents sidebar', 216, 180, 440),
  focusInspector: panel('focus.inspector', 'right', 'inspector', 340, 300, 720),
  filesTree: panel('files.tree', 'left', 'file tree', 270, 200, 640),
  filesSearch: panel('files.search', 'left', 'search sidebar', 300, 260, 640),
  filesActivity: panel('files.activity', 'right', 'file activity sidebar', 300, 240, 560),
  reviewFiles: panel('review.files', 'left', 'changed files sidebar', 260, 200, 600),
  reviewSummary: panel('review.summary', 'right', 'review summary', 340, 280, 600),
  sourceControlSide: panel('scm.side', 'right', 'source control sidebar', 320, 260, 560),
  artifactsDetails: panel('artifacts.details', 'right', 'artifact details', 380, 300, 720),
  marketplaceCategories: panel('marketplace.categories', 'left', 'categories sidebar', 220, 180, 420),
  marketplaceDetails: panel('marketplace.details', 'right', 'extension details', 380, 300, 720),
  settingsSections: panel('settings.sections', 'left', 'settings sections', 230, 190, 420),
} as const satisfies Record<string, PanelSpec>;

/** Keyboard steps on a focused resize handle (Shift takes the big step). */
export const PANEL_KEY_STEP = 16;
export const PANEL_KEY_STEP_BIG = 64;

/** The width a panel renders at: a whole number inside the panel's own min and max. */
export function clampPanelWidth(spec: PanelSpec, width: number | undefined | null): number {
  const w = typeof width === 'number' && Number.isFinite(width) ? width : spec.defaultWidth;
  const min = Math.max(spec.min, PANEL_WIDTH_LIMITS.min);
  const max = Math.min(spec.max, PANEL_WIDTH_LIMITS.max);
  return Math.round(Math.min(max, Math.max(min, w)));
}

/**
 * Width after dragging the handle `dx` px to the right from `startWidth`. A left sidebar grows when
 * its right edge moves right; a right sidebar grows when its left edge moves left.
 */
export function dragPanelWidth(spec: PanelSpec, startWidth: number, dx: number): number {
  return clampPanelWidth(spec, startWidth + (spec.side === 'left' ? dx : -dx));
}

/**
 * Width after a key on the focused handle, or null when the key does nothing. Arrows move the edge
 * the way they point; Home and End jump to the narrowest and widest.
 */
export function keyPanelWidth(spec: PanelSpec, width: number, key: string, big: boolean): number | null {
  const step = big ? PANEL_KEY_STEP_BIG : PANEL_KEY_STEP;
  switch (key) {
    case 'ArrowLeft':
      return dragPanelWidth(spec, width, -step);
    case 'ArrowRight':
      return dragPanelWidth(spec, width, step);
    case 'Home':
      return clampPanelWidth(spec, spec.min);
    case 'End':
      return clampPanelWidth(spec, spec.max);
    default:
      return null;
  }
}
