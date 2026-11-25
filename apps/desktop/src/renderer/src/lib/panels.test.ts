import { describe, expect, it } from 'vitest';
import { PanelWidths, Settings } from '@oide/protocol';
import { PANELS, PANEL_KEY_STEP, PANEL_KEY_STEP_BIG, clampPanelWidth, dragPanelWidth, keyPanelWidth, type PanelSpec } from './panels';

const left: PanelSpec = PANELS.wallProjects;
const right: PanelSpec = PANELS.focusInspector;

describe('panel registry', () => {
  it('has unique ids that the settings schema accepts, with sane limits', () => {
    const specs: PanelSpec[] = Object.values(PANELS);
    expect(new Set(specs.map((p) => p.id)).size).toBe(specs.length);
    for (const p of specs) {
      expect(p.min).toBeLessThanOrEqual(p.defaultWidth);
      expect(p.defaultWidth).toBeLessThanOrEqual(p.max);
      expect(PanelWidths.safeParse({ [p.id]: p.defaultWidth }).success).toBe(true);
      expect(PanelWidths.safeParse({ [p.id]: p.min }).success).toBe(true);
      expect(PanelWidths.safeParse({ [p.id]: p.max }).success).toBe(true);
    }
  });

  it('keeps the design widths as defaults', () => {
    expect(PANELS.wallProjects.defaultWidth).toBe(248);
    expect(PANELS.wallArtifacts.defaultWidth).toBe(280);
    expect(PANELS.focusAgents.defaultWidth).toBe(216);
    expect(PANELS.settingsSections.defaultWidth).toBe(230);
  });
});

describe('clampPanelWidth', () => {
  it('falls back to the default and stays inside min and max', () => {
    expect(clampPanelWidth(left, undefined)).toBe(248);
    expect(clampPanelWidth(left, null)).toBe(248);
    expect(clampPanelWidth(left, Number.NaN)).toBe(248);
    expect(clampPanelWidth(left, 10)).toBe(left.min);
    expect(clampPanelWidth(left, 99_999)).toBe(left.max);
    expect(clampPanelWidth(left, 301.6)).toBe(302);
  });
});

describe('dragPanelWidth', () => {
  it('grows a left sidebar when its right edge moves right', () => {
    expect(dragPanelWidth(left, 248, 40)).toBe(288);
    expect(dragPanelWidth(left, 248, -40)).toBe(208);
  });
  it('grows a right sidebar when its left edge moves left', () => {
    expect(dragPanelWidth(right, 340, -60)).toBe(400);
    expect(dragPanelWidth(right, 340, 60)).toBe(right.min);
  });
  it('never goes past the limits', () => {
    expect(dragPanelWidth(left, 248, -1000)).toBe(left.min);
    expect(dragPanelWidth(left, 248, 1000)).toBe(left.max);
  });
});

describe('keyPanelWidth', () => {
  it('moves the edge the way the arrow points, Shift for a big step', () => {
    expect(keyPanelWidth(left, 248, 'ArrowRight', false)).toBe(248 + PANEL_KEY_STEP);
    expect(keyPanelWidth(left, 400, 'ArrowLeft', true)).toBe(400 - PANEL_KEY_STEP_BIG);
    expect(keyPanelWidth(left, 248, 'ArrowLeft', true)).toBe(left.min);
    expect(keyPanelWidth(right, 340, 'ArrowLeft', false)).toBe(340 + PANEL_KEY_STEP);
  });
  it('jumps with Home and End and ignores other keys', () => {
    expect(keyPanelWidth(left, 248, 'Home', false)).toBe(left.min);
    expect(keyPanelWidth(left, 248, 'End', false)).toBe(left.max);
    expect(keyPanelWidth(left, 248, 'a', false)).toBeNull();
  });
});

describe('settings.ui.panelWidths', () => {
  const base = { claude: {}, models: {}, agents: { notifications: {} }, techniques: [], permissions: {} };
  it('defaults to no stored widths, so settings saved before it still parse', () => {
    expect(Settings.parse({ ...base, ui: {} }).ui.panelWidths).toEqual({});
  });
  it('refuses bad ids, out-of-range and fractional widths, and too many entries', () => {
    expect(PanelWidths.safeParse({ 'wall.projects': 300 }).success).toBe(true);
    expect(PanelWidths.safeParse({ __proto__x: 300 }).success).toBe(false);
    expect(PanelWidths.safeParse({ 'Wall Projects': 300 }).success).toBe(false);
    expect(PanelWidths.safeParse({ 'wall.projects': 50 }).success).toBe(false);
    expect(PanelWidths.safeParse({ 'wall.projects': 5000 }).success).toBe(false);
    expect(PanelWidths.safeParse({ 'wall.projects': 300.5 }).success).toBe(false);
    expect(PanelWidths.safeParse({ 'wall.projects': '300' }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, 300]));
    expect(PanelWidths.safeParse(many).success).toBe(false);
  });
});
