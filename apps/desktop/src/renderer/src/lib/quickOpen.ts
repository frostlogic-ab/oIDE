import { useEffect, useMemo, useState } from 'react';
import { parseQuickOpenQuery, type AgentSummary, type FileNameMatch, type Project } from '@oide/protocol';
import { invokeOr } from './bridge';
import { filterCommands, fuzzyFilter, type Command } from './commands';
import { useFiles } from '../screens/Files/filesStore';
import { useGit } from '../screens/SourceControl/gitStore';
import { shortBranch } from '../screens/SourceControl/model';
import { navigate, useRouter } from '../stores/router';
import { useProjects } from '../stores/projects';
import { useScope } from '../stores/scope';

/**
 * Quick open in the command bar (Ctrl/Cmd+K), VS Code style: plain text finds files by name in the
 * projects in scope (`files.findByName`, ranked in main) mixed with commands and sessions; a `>`
 * prefix shows commands only; `name:42` (or `name:42:7`) opens at that line. Wiki: desktop-shell.md.
 */

export type CommandBarRow =
  | { kind: 'command'; id: string; command: Command; group: string }
  | { kind: 'agent'; id: string; agent: AgentSummary; group: string }
  | { kind: 'file'; id: string; match: FileNameMatch; group: string; line?: number; column?: number };

export const FILES_GROUP = 'Files';
export const RECENT_GROUP = 'Recently opened';
const MAX_RECENT = 5;
const MAX_FILES = 20;
const MAX_COMMANDS_WITH_FILES = 8;

export interface QuickOpenRoot {
  root: string;
  projectId: string;
  /** "oide" or "oide · shell-layout" */
  label: string;
}

/** The checkout Files shows for each project in scope (main or an agent worktree). */
export function useQuickOpenRoots(): QuickOpenRoot[] {
  const projects = useProjects((s) => s.list);
  const scope = useScope((s) => s.scope);
  const checkout = useFiles((s) => s.checkout);
  const git = useGit((s) => s.byProject);
  return useMemo(() => quickOpenRoots(projects, scope, checkout, git), [projects, scope, checkout, git]);
}

export function quickOpenRoots(
  projects: readonly Project[],
  scope: string,
  checkout: Record<string, string>,
  git: Record<string, { worktrees: Array<{ path: string; branch: string }> } | undefined>,
): QuickOpenRoot[] {
  return projects
    .filter((p) => scope === 'all' || p.id === scope)
    .map((p) => {
      const root = checkout[p.id] ?? p.path;
      const w = root === p.path ? undefined : git[p.id]?.worktrees.find((x) => x.path === root);
      return { root, projectId: p.id, label: w ? `${p.name} · ${shortBranch(w.branch)}` : p.name };
    });
}

/** File-name results for the command bar query (debounced; stale answers are dropped). */
export function useQuickOpenFiles(query: string, roots: readonly QuickOpenRoot[], enabled: boolean): { results: FileNameMatch[]; query: string } {
  const recent = useFiles((s) => s.recent);
  const [state, setState] = useState<{ results: FileNameMatch[]; query: string }>({ results: [], query: '' });
  const rootsKey = roots.map((r) => r.root).join('\n');
  useEffect(() => {
    const parsed = parseQuickOpenQuery(query);
    if (!enabled || !parsed.query || !rootsKey) {
      setState({ results: [], query });
      return;
    }
    let cancelled = false;
    const list = rootsKey.split('\n');
    const inScope = new Set(list);
    const t = setTimeout(() => {
      invokeOr('files.findByName', { roots: list, query: parsed.query, limit: 40, recent: recent.filter((r) => inScope.has(r.root)).slice(0, 50) }, { results: [] as FileNameMatch[], total: 0, stale: false })
        .then((r) => !cancelled && setState({ results: r.results, query }))
        .catch(() => !cancelled && setState({ results: [], query }));
    }, 40);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, rootsKey, enabled, recent]);
  return state;
}

/** Recently opened files in scope, for the empty query. */
export function recentRows(recent: ReadonlyArray<{ root: string; path: string }>, roots: readonly QuickOpenRoot[]): FileNameMatch[] {
  const inScope = new Set(roots.map((r) => r.root));
  return recent
    .filter((r) => inScope.has(r.root))
    .slice(0, MAX_RECENT)
    .map((r) => ({ root: r.root, path: r.path, score: 0, positions: [], recent: true }));
}

/** True when the query reads as a command title (prefix or substring), so commands lead. */
function commandsLead(cmds: readonly Command[], q: string): boolean {
  const t = q.trim().toLowerCase();
  return t.length > 0 && cmds.some((c) => c.title.toLowerCase().includes(t));
}

/**
 * Rows of the command bar in commands mode, in sections:
 * - `>` prefix: commands only (VS Code convention);
 * - empty query: recently opened files, then every command;
 * - text: Recently opened + Files and Commands (commands first when the text is part of a command
 *   title, so "marketpl" still runs "Go to Marketplace" on Enter), then up to 5 sessions.
 */
export function buildCommandBarRows(input: {
  query: string;
  commands: readonly Command[];
  agents: readonly AgentSummary[];
  files: readonly FileNameMatch[];
  recent: readonly FileNameMatch[];
}): CommandBarRow[] {
  const raw = input.query.trimStart();
  const cmdRow = (command: Command): CommandBarRow => ({ kind: 'command', id: command.id, command, group: command.group ?? 'Commands' });
  if (raw.startsWith('>')) return filterCommands(input.commands, raw.slice(1)).map(cmdRow);

  const { query: name, line, column } = parseQuickOpenQuery(input.query);
  const fileRow = (match: FileNameMatch): CommandBarRow => ({
    kind: 'file',
    id: `file:${match.root}::${match.path}`,
    match,
    group: match.recent ? RECENT_GROUP : FILES_GROUP,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  });
  if (!input.query.trim()) return [...input.recent.map(fileRow), ...filterCommands(input.commands, '').map(cmdRow)];

  const files = [...input.files.filter((f) => f.recent).slice(0, MAX_RECENT), ...input.files.filter((f) => !f.recent).slice(0, MAX_FILES)].map(fileRow);
  const matched = filterCommands(input.commands, input.query);
  const cmds = (files.length ? matched.slice(0, MAX_COMMANDS_WITH_FILES) : matched).map(cmdRow);
  const sessions: CommandBarRow[] = fuzzyFilter(input.agents, input.query, (a) => a.title)
    .slice(0, 5)
    .map((agent) => ({ kind: 'agent', id: `agent:${agent.id}`, agent, group: 'Sessions' }));
  const lead = commandsLead(input.commands, name);
  return lead ? [...cmds, ...files, ...sessions] : [...files, ...cmds, ...sessions];
}

/** Open a quick-open result: switch to Files, select its project and checkout, reveal it in the tree. */
export function openQuickOpenResult(row: { match: FileNameMatch; line?: number; column?: number }): void {
  useFiles.getState().requestOpen({
    root: row.match.root,
    path: row.match.path,
    ...(row.line !== undefined ? { line: row.line } : {}),
    ...(row.column !== undefined ? { column: Math.max(0, row.column - 1) } : {}),
  });
  if (useRouter.getState().route.screen !== 'files') navigate('files', {});
}
