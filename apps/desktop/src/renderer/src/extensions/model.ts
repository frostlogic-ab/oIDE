/**
 * Extension UI contributions as the renderer sees them (pure functions over `extensions.installed`).
 * Panels, themes, artifact types and deploy targets; see docs/wiki/pages/extensions.md, "UI
 * contributions".
 */
import type { InstalledExtension } from '@oide/protocol';

/** Same rule as main for one project: off in the project wins, then on in the project or globally. */
export function isOnFor(ext: InstalledExtension, projectId: string): boolean {
  if (ext.disabledProjects.includes(projectId)) return false;
  return ext.enabledGlobally || ext.enabledProjects.includes(projectId);
}

/** Main serves UI (panels, viewers) only for extensions that are on somewhere. */
export function isOnSomewhere(ext: InstalledExtension): boolean {
  return ext.enabledGlobally || ext.enabledProjects.length > 0;
}

export interface PanelRef {
  /** Extension (package) name. */
  extension: string;
  displayName: string;
  id: string;
  title: string;
  location: 'inspector' | 'screen';
}

/** Contributed panels at one location; for the inspector only those on for `projectId`. */
export function panelsAt(
  installed: readonly InstalledExtension[],
  location: PanelRef['location'],
  projectId?: string,
): PanelRef[] {
  const out: PanelRef[] = [];
  for (const e of installed) {
    if (projectId ? !isOnFor(e, projectId) : !isOnSomewhere(e)) continue;
    for (const p of e.manifest.oide.contributes.panels) {
      if (p.location === location)
        out.push({
          extension: e.name,
          displayName: e.displayName,
          id: p.id,
          title: p.title,
          location: p.location,
        });
    }
  }
  return out;
}

export function findPanel(
  installed: readonly InstalledExtension[],
  extension: string,
  panelId: string,
): PanelRef | undefined {
  const e = installed.find((x) => x.name === extension);
  const p = e?.manifest.oide.contributes.panels.find((x) => x.id === panelId);
  return e && p
    ? { extension: e.name, displayName: e.displayName, id: p.id, title: p.title, location: p.location }
    : undefined;
}

/** Inspector tab id of an extension panel. `::` cannot occur in a package name. */
export function panelTabId(extension: string, panelId: string): `ext:${string}` {
  return `ext:${extension}::${panelId}`;
}

export function parsePanelTabId(tab: string): { extension: string; panelId: string } | undefined {
  if (!tab.startsWith('ext:')) return undefined;
  const i = tab.indexOf('::', 4);
  if (i < 0) return undefined;
  return { extension: tab.slice(4, i), panelId: tab.slice(i + 2) };
}

// ------------------------------------------------------------------------------- themes

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Theme tokens the renderer applies, and the CSS variable each one sets. Everything else in a
 * theme's `tokens` is ignored: an extension can recolour the accent family, not the whole UI.
 */
export const THEME_TOKEN_VARS: Record<string, string> = {
  accent: '--color-accent',
  'accent-contrast': '--color-on-accent',
  link: '--color-link',
  'link-hover': '--color-link-hover',
};

export interface ThemeOption {
  /** `<extension>:<theme id>` */
  key: string;
  id: string;
  label: string;
  /** The theme's `accent` token; stored as Settings `ui.accent`. */
  value: string;
  extension: string;
  /** CSS variable → colour, only allow-listed tokens with `#rrggbb` values. */
  vars: Record<string, string>;
}

/** Themes of extensions that are on, with a valid `accent` token. First one wins for a repeated accent. */
export function themeOptions(installed: readonly InstalledExtension[]): ThemeOption[] {
  const out: ThemeOption[] = [];
  const seen = new Set<string>();
  for (const e of installed) {
    if (!isOnSomewhere(e)) continue;
    for (const t of e.manifest.oide.contributes.themes) {
      const accent = t.tokens['accent'];
      if (!accent || !HEX.test(accent) || seen.has(accent.toUpperCase())) continue;
      seen.add(accent.toUpperCase());
      const vars: Record<string, string> = {};
      for (const [token, v] of Object.entries(t.tokens)) {
        const cssVar = THEME_TOKEN_VARS[token];
        if (cssVar && HEX.test(v)) vars[cssVar] = v;
      }
      out.push({
        key: `${e.name}:${t.id}`,
        id: t.id,
        label: t.label,
        value: accent.toUpperCase(),
        extension: e.displayName,
        vars,
      });
    }
  }
  return out;
}

/** The theme whose accent is `accent` (Settings `ui.accent`), if any. */
export function themeForAccent(
  options: readonly ThemeOption[],
  accent: string | undefined,
): ThemeOption | undefined {
  const a = (accent ?? '').toUpperCase();
  return options.find((o) => o.value === a);
}

/** The theme after the one for `accent` (wraps), for "Next accent colour". */
export function nextTheme(
  options: readonly ThemeOption[],
  accent: string | undefined,
): ThemeOption | undefined {
  if (!options.length) return undefined;
  const i = options.findIndex((o) => o.value === (accent ?? '').toUpperCase());
  return options[(i + 1) % options.length];
}

// ------------------------------------------------------------------------ artifact types

export interface ArtifactTypeRef {
  extension: string;
  displayName: string;
  id: string;
  label: string;
}

/** Resolve an artifact's `type` (`<extension>:<type id>`) to an extension that is on and declares it. */
export function artifactTypeOf(
  installed: readonly InstalledExtension[],
  type: string | undefined,
): ArtifactTypeRef | undefined {
  if (!type) return undefined;
  const i = type.lastIndexOf(':');
  if (i <= 0) return undefined;
  const name = type.slice(0, i);
  const id = type.slice(i + 1);
  const e = installed.find((x) => x.name === name);
  if (!e || !isOnSomewhere(e)) return undefined;
  const t = e.manifest.oide.contributes.artifactTypes.find((x) => x.id === id);
  return t ? { extension: e.name, displayName: e.displayName, id: t.id, label: t.label } : undefined;
}

// ------------------------------------------------------------------------ deploy targets

export interface DeployTargetRef {
  extension: string;
  displayName: string;
  id: string;
  title: string;
}

export function deployTargetsFor(
  installed: readonly InstalledExtension[],
  projectId: string,
): DeployTargetRef[] {
  return installed
    .filter((e) => isOnFor(e, projectId))
    .flatMap((e) =>
      e.manifest.oide.contributes.deployTargets.map((d) => ({
        extension: e.name,
        displayName: e.displayName,
        id: d.id,
        title: d.title,
      })),
    );
}

/** Short text for a deploy target's result (`{ message }`, `{ url }` or a string). */
export function deployResultText(title: string, result: unknown): { text: string; url?: string } {
  if (typeof result === 'string' && result.trim()) return { text: result.trim().slice(0, 300) };
  if (result && typeof result === 'object') {
    const r = result as { message?: unknown; url?: unknown };
    const url = typeof r.url === 'string' && /^https:\/\//i.test(r.url) ? r.url : undefined;
    const text =
      typeof r.message === 'string' && r.message.trim() ? r.message.trim().slice(0, 300) : `${title}: done`;
    return url ? { text, url } : { text };
  }
  return { text: `${title}: done` };
}

// ------------------------------------------------------------------------- panel bridge

/** Messages whose `type` starts with `oide:` are between the app and a frame; they never reach host code. */
export function isAppMessage(data: unknown): data is { type: `oide:${string}` } & Record<string, unknown> {
  return (
    !!data &&
    typeof data === 'object' &&
    typeof (data as { type?: unknown }).type === 'string' &&
    (data as { type: string }).type.startsWith('oide:')
  );
}
