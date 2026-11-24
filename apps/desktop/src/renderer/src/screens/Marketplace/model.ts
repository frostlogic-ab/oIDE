/**
 * Pure helpers for the Marketplace screen: one list item type over index entries, installed
 * records and custom servers; filters and sorts; monograms; risk labels; command/JSON parsing.
 */
import type { CustomServer, ExtensionUpdate, InstalledExtension, MarketplaceEntry, ToolRisk } from '@oide/protocol';
import { MARKETPLACE_CATEGORIES } from '@oide/protocol';

export type CategoryId = (typeof MARKETPLACE_CATEGORIES)[number]['id'] | 'installed' | 'custom' | 'updates';

export const YOURS: Array<{ id: CategoryId; label: string }> = [
  { id: 'installed', label: 'Installed' },
  { id: 'custom', label: 'Custom' },
  { id: 'updates', label: 'Updates' },
];

export function categoryLabel(id: CategoryId): string {
  return MARKETPLACE_CATEGORIES.find((c) => c.id === id)?.label ?? YOURS.find((c) => c.id === id)?.label ?? id;
}

export interface ToolInfo {
  name: string;
  risk: ToolRisk;
  description?: string;
  /** MCP server the tool belongs to (extensions) — used for `mcp__<server>__<tool>`. */
  server?: string;
  enabled?: boolean;
}

export interface Capabilities {
  network: string[];
  spawn: boolean;
  fs: string[];
}

export type ItemState = 'install' | 'installed' | 'builtin' | 'update';

export interface ListItem {
  key: string;
  kind: 'entry' | 'local' | 'custom';
  name: string;
  displayName: string;
  publisher: string;
  description: string;
  categories: string[];
  downloads: number;
  updatedAt?: string;
  entry?: MarketplaceEntry;
  installed?: InstalledExtension;
  custom?: CustomServer;
  update?: ExtensionUpdate;
  tools: ToolInfo[];
  capabilities: Capabilities | null;
  /** Custom servers and folder/git extensions are not reviewed by the marketplace. */
  reviewed: boolean;
  state: ItemState;
}

export const TINTS = ['#9DBBFA', '#7FC8A9', '#E6E8EB', '#F2C078', '#C4A7E7'] as const;

export function tintFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TINTS[h % TINTS.length]!;
}

/** "Browser preview" → "Bp", "Git" → "G". */
export function monogram(displayName: string): string {
  const words = displayName.replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) {
    const w = words[0]!;
    return w.length <= 4 ? w[0]!.toUpperCase() : w[0]!.toUpperCase() + w[1]!.toLowerCase();
  }
  return words[0]![0]!.toUpperCase() + words[1]![0]!.toLowerCase();
}

/** Risk from MCP tool annotations: readOnlyHint → read; destructiveHint or no hint → ask. */
export function riskFromHints(t: { readOnlyHint?: boolean; destructiveHint?: boolean }): ToolRisk {
  if (t.destructiveHint) return 'ask';
  return t.readOnlyHint ? 'read' : 'ask';
}

export const RISK_LABEL: Record<ToolRisk, string> = { read: 'read only', ask: 'asks first' };
export const RISK_COLOR: Record<ToolRisk, string> = { read: '#7FC8A9', ask: '#F2C078' };

/** Server names allowed by the CustomServer schema. */
export function sanitizeServerName(name: string): string {
  return name.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
}

/** `mcp__<server>__<tool>` with characters outside `[A-Za-z0-9_-]` replaced by `_`. */
export function qualifiedToolName(server: string, tool: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_');
  return `mcp__${clean(server)}__${clean(tool)}`;
}

function manifestTools(ext: InstalledExtension): ToolInfo[] {
  return Object.entries(ext.manifest.oide.mcpServers).flatMap(([server, def]) =>
    Object.entries(def.tools).map(([name, t]) => ({
      name,
      risk: t.risk,
      description: t.description,
      server,
      enabled: !ext.disabledTools.includes(qualifiedToolName(server, name)),
    })),
  );
}

function stateOf(entry: MarketplaceEntry | undefined, installed: InstalledExtension | undefined, update: ExtensionUpdate | undefined): ItemState {
  if (entry?.source === 'builtin' || installed?.source === 'builtin') return 'builtin';
  if (update) return 'update';
  return installed ? 'installed' : 'install';
}

/** Merge the index, installed records and custom servers into one list. */
export function buildItems(index: MarketplaceEntry[], installed: InstalledExtension[], custom: CustomServer[], updates: ExtensionUpdate[]): ListItem[] {
  const items: ListItem[] = [];
  for (const entry of index) {
    const rec = installed.find((i) => i.name === entry.name);
    const update = rec ? updates.find((u) => u.id === rec.id) : undefined;
    const v = entry.versions[0];
    items.push({
      key: `e:${entry.name}`,
      kind: 'entry',
      name: entry.name,
      displayName: entry.displayName,
      publisher: entry.publisher,
      description: entry.description,
      categories: entry.categories,
      downloads: entry.downloads,
      updatedAt: entry.updatedAt,
      entry,
      installed: rec,
      update,
      tools: rec ? manifestTools(rec) : (v?.tools ?? []).map((t) => ({ name: t.name, risk: t.risk, description: t.description })),
      capabilities: rec
        ? { network: rec.manifest.oide.capabilities.network, spawn: rec.manifest.oide.capabilities.spawn, fs: rec.manifest.oide.capabilities.fs }
        : { network: v?.capabilities?.network ?? [], spawn: v?.capabilities?.spawn ?? false, fs: [] },
      reviewed: entry.verified || entry.source === 'builtin',
      state: stateOf(entry, rec, update),
    });
  }
  for (const rec of installed) {
    if (index.some((e) => e.name === rec.name)) continue;
    const m = rec.manifest.oide;
    items.push({
      key: `x:${rec.id}`,
      kind: 'local',
      name: rec.name,
      displayName: rec.displayName,
      publisher: m.publisher ?? (rec.source === 'builtin' ? 'oide' : 'you'),
      description: rec.manifest.description ?? '',
      categories: m.categories.length ? m.categories : Object.keys(m.mcpServers).length ? ['agent-tools'] : [],
      downloads: 0,
      installed: rec,
      update: updates.find((u) => u.id === rec.id),
      tools: manifestTools(rec),
      capabilities: { network: m.capabilities.network, spawn: m.capabilities.spawn, fs: m.capabilities.fs },
      reviewed: rec.reviewed,
      state: stateOf(undefined, rec, updates.find((u) => u.id === rec.id)),
    });
  }
  for (const server of custom) {
    items.push({
      key: `c:${server.id}`,
      kind: 'custom',
      name: server.name,
      displayName: customDisplayName(server),
      publisher: 'You',
      description: customDescription(server),
      categories: ['agent-tools'],
      downloads: 0,
      custom: server,
      tools: server.tools.map((t) => ({ name: t.name, risk: t.risk, description: t.description, enabled: t.enabled })),
      capabilities: null,
      reviewed: false,
      state: 'installed',
    });
  }
  return items;
}

/** "team-wiki" → "Team wiki". */
export function customDisplayName(server: CustomServer): string {
  const base = server.serverInfo?.replace(/\s+v?\d[\w.-]*$/, '') || server.name.replace(/[-_]+/g, ' ');
  return base.charAt(0).toUpperCase() + base.slice(1);
}

export function customSource(server: CustomServer): string {
  const t = server.transport;
  if (t.kind === 'http') return `${t.url}${t.auth === 'oauth' ? ' · signed in with OAuth' : t.auth === 'header' ? ' · header token' : ''}`;
  return [t.command, ...t.args].join(' ');
}

function customDescription(server: CustomServer): string {
  const how = server.route === 'url' ? 'added by URL' : server.route === 'import' ? 'imported from another app' : server.route === 'command' ? 'a local command' : 'an extension';
  return `MCP server ${how}. ${server.tools.length} ${server.tools.length === 1 ? 'tool' : 'tools'}.`;
}

export function isCustomLike(item: ListItem): boolean {
  return item.kind === 'custom' || item.installed?.source === 'folder' || item.installed?.source === 'git';
}

export function inCategory(item: ListItem, cat: CategoryId): boolean {
  if (cat === 'installed') return Boolean(item.installed) || item.kind === 'custom';
  if (cat === 'custom') return isCustomLike(item);
  if (cat === 'updates') return Boolean(item.update);
  return item.categories.includes(cat);
}

export type SortId = 'installs' | 'updated' | 'name';

export function filterItems(items: ListItem[], cat: CategoryId, query: string, sort: SortId): ListItem[] {
  const q = query.trim().toLowerCase();
  const out = items.filter(
    (i) =>
      inCategory(i, cat) &&
      (!q || [i.displayName, i.name, i.publisher, i.description, ...i.tools.map((t) => t.name)].some((s) => s.toLowerCase().includes(q))),
  );
  const byName = (a: ListItem, b: ListItem) => a.displayName.localeCompare(b.displayName);
  if (sort === 'name') return out.sort(byName);
  if (sort === 'updated') return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || byName(a, b));
  // Most installed; custom and local ones (0 downloads) keep a stable order at the end.
  return out.sort((a, b) => b.downloads - a.downloads);
}

/** Effective per-project state of an installed extension. */
export function enabledIn(ext: InstalledExtension, projectId: string): boolean {
  if (ext.disabledProjects.includes(projectId)) return false;
  return ext.enabledProjects.includes(projectId) || ext.enabledGlobally;
}

/** Quote-aware command-line splitter: `npx -y "@a/b c" --root .` → ["npx", "-y", "@a/b c", "--root", "."]. */
export function splitCommandLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else cur += ch;
  }
  if (has || cur) out.push(cur);
  return out;
}

export interface PastedServer {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Parse pasted JSON in the standard `{ "mcpServers": { name: { command, args, env } } }` format. */
export function parsePastedJson(text: string): { servers: PastedServer[]; error?: string } {
  if (!text.trim()) return { servers: [] };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return { servers: [], error: `Not valid JSON: ${(err as Error).message}` };
  }
  const root = data && typeof data === 'object' ? (data as Record<string, unknown>) : null;
  const map = root && typeof root.mcpServers === 'object' && root.mcpServers ? (root.mcpServers as Record<string, unknown>) : null;
  if (!map) return { servers: [], error: 'Expected an object with an "mcpServers" key.' };
  const servers: PastedServer[] = [];
  for (const [name, raw] of Object.entries(map)) {
    const def = raw as { command?: unknown; args?: unknown; env?: unknown; url?: unknown };
    if (typeof def?.command !== 'string') {
      return { servers: [], error: typeof def?.url === 'string' ? `"${name}" is a remote server: add it with From a URL.` : `"${name}" has no "command".` };
    }
    const args = Array.isArray(def.args) ? def.args.map(String) : [];
    const env: Record<string, string> = {};
    if (def.env && typeof def.env === 'object') for (const [k, v] of Object.entries(def.env)) env[k] = String(v);
    servers.push({ name, command: def.command, args, env });
  }
  if (!servers.length) return { servers: [], error: 'No servers found under "mcpServers".' };
  return { servers };
}
