/**
 * The composer's `/` menu, as data: the CLI's `init.slash_commands` (strings, no leading "/") turned
 * into labelled, grouped items, and the filter that runs as the user types.
 *
 * Groups, in order: built-in Claude Code CLI commands (`/compact`, `/context`, `/init`, …), the
 * project's skills and custom commands, plugin commands (`plugin:command`), then one group per MCP
 * server for MCP prompts (`mcp__<server>__<prompt>` → "<Server> (MCP)" + "<prompt>").
 */

export interface SlashItem {
  /** The command as the CLI knows it (inserted as `/<name> `). */
  name: string;
  /** What the row shows: `/compact`, or the prompt name inside an MCP or plugin group. */
  label: string;
  group: string;
  groupLabel: string;
  description?: string;
}

/** CLI built-ins we can describe. Anything else the CLI reports still works; it just has no description. */
const BUILTIN_HELP: Record<string, string> = {
  compact: 'Summarize the conversation to free up context (asks first)',
  context: 'Show how the context window is used',
  init: 'Write a CLAUDE.md for this project',
  clear: 'Start a fresh conversation',
  cost: 'Show token usage for this session',
  review: 'Review the changes',
  'security-review': 'Review the changes for security issues',
  'pr-comments': 'Show the comments on this pull request',
  'release-notes': 'Show the CLI release notes',
  model: 'Show or change the model',
  memory: 'Edit memory files',
  status: 'Show the CLI status',
  todos: 'List the current todos',
  usage: 'Show plan usage',
  help: 'Show help',
  agents: 'Manage subagents',
  hooks: 'Show configured hooks',
  mcp: 'Show MCP servers',
  permissions: 'Show permission rules',
  doctor: 'Check the CLI installation',
  export: 'Export the conversation',
  'add-dir': 'Add a working folder',
};

export const BUILTIN_GROUP = 'builtin';
const CUSTOM_GROUP = 'custom';

export function slashHelp(name: string): string | undefined {
  return BUILTIN_HELP[name];
}

/** "claude_ai_HubSpot" → "HubSpot"; "claude_ai_Claude_Docs" → "Claude Docs"; "my_server" → "my server". */
export function mcpServerLabel(server: string): string {
  return server.replace(/^claude_ai_/, '').replace(/_+/g, ' ').trim() || server;
}

/** Group and label one reported command. */
export function slashItem(name: string): SlashItem {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    const server = mcp[1]!;
    return { name, label: mcp[2]!, group: `mcp:${server}`, groupLabel: `${mcpServerLabel(server)} (MCP)` };
  }
  if (name in BUILTIN_HELP) return { name, label: `/${name}`, group: BUILTIN_GROUP, groupLabel: 'Claude Code', description: BUILTIN_HELP[name] };
  const plugin = /^([^:]+):(.+)$/.exec(name);
  if (plugin) {
    const p = plugin[1]!;
    return { name, label: plugin[2]!, group: `plugin:${p}`, groupLabel: `${p.replace(/[-_]+/g, ' ')} (plugin)` };
  }
  return { name, label: `/${name}`, group: CUSTOM_GROUP, groupLabel: 'Skills and custom commands' };
}

function groupRank(group: string): number {
  if (group === BUILTIN_GROUP) return 0;
  if (group === CUSTOM_GROUP) return 1;
  if (group.startsWith('plugin:')) return 2;
  return 3;
}

/** Every command once, grouped (built-ins first, then custom, plugins A–Z, MCP servers A–Z); CLI order kept inside a group. */
export function slashItems(commands: readonly string[]): SlashItem[] {
  const seen = new Set<string>();
  const items: SlashItem[] = [];
  for (const raw of commands) {
    const name = raw.replace(/^\//, '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    items.push(slashItem(name));
  }
  const first = new Map<string, number>();
  items.forEach((it, i) => (first.has(it.group) ? undefined : first.set(it.group, i)));
  return items
    .map((it, i) => ({ it, i }))
    .sort((a, b) => {
      const ga = groupRank(a.it.group);
      const gb = groupRank(b.it.group);
      if (ga !== gb) return ga - gb;
      if (a.it.group !== b.it.group) return ga >= 2 ? a.it.groupLabel.localeCompare(b.it.groupLabel, undefined, { sensitivity: 'base' }) : first.get(a.it.group)! - first.get(b.it.group)!;
      return a.i - b.i;
    })
    .map((x) => x.it);
}

const words = (s: string) => s.split(/[\s_:/-]+/).filter(Boolean);

function isSubsequence(q: string, s: string): boolean {
  let i = 0;
  for (let j = 0; j < s.length && i < q.length; j++) if (s[j] === q[i]) i++;
  return i === q.length;
}

/**
 * 0: the command or its label starts with the query; 1: a word of the label or group does;
 * 2: the label or group contains it; 3: its letters appear in the label in order (fuzzy); null: no match.
 */
export function slashScore(item: SlashItem, query: string): number | null {
  const q = query.replace(/^\//, '').toLowerCase();
  if (!q) return 0;
  const name = item.name.toLowerCase();
  const label = item.label.replace(/^\//, '').toLowerCase();
  // The server or plugin name ("hub" finds HubSpot's prompts); not the built-in or custom group titles.
  const group = item.group.includes(':') ? item.groupLabel.replace(/ \((MCP|plugin)\)$/, '').toLowerCase() : '';
  if (name.startsWith(q) || label.startsWith(q)) return 0;
  if (words(label).some((w) => w.startsWith(q)) || words(group).some((w) => w.startsWith(q))) return 1;
  // Not the full name for these two: every MCP prompt's name contains "mcp__claude_ai_".
  if (label.includes(q) || (group && group.includes(q))) return 2;
  if (isSubsequence(q, label)) return 3;
  return null;
}

/**
 * Items matching `query` (with or without the leading "/"); fuzzy matches only when there is nothing better. Groups stay together; a group with a
 * better match comes first (prefix matches lead), ties keep the group order; inside a group the
 * better matches come first, then the original order.
 */
export function filterSlashItems(items: readonly SlashItem[], query: string): SlashItem[] {
  const q = query.replace(/^\//, '');
  if (!q) return [...items];
  const scored = items.flatMap((it, i) => {
    const s = slashScore(it, q);
    return s === null ? [] : [{ it, i, s }];
  });
  const groupBest = new Map<string, { s: number; i: number }>();
  for (const x of scored) {
    const g = groupBest.get(x.it.group);
    if (!g) groupBest.set(x.it.group, { s: x.s, i: x.i });
    else if (x.s < g.s) g.s = x.s;
  }
  // Fuzzy (letters in order) only when nothing matches better.
  const best = Math.min(...scored.map((x) => x.s));
  return scored
    .filter((x) => x.s < 3 || best === 3)
    .sort((a, b) => {
      if (a.it.group !== b.it.group) {
        const ga = groupBest.get(a.it.group)!;
        const gb = groupBest.get(b.it.group)!;
        return ga.s - gb.s || ga.i - gb.i;
      }
      return a.s - b.s || a.i - b.i;
    })
    .map((x) => x.it);
}

/** The text the composer gets when a command is picked. */
export function insertText(item: SlashItem): string {
  return `/${item.name} `;
}
