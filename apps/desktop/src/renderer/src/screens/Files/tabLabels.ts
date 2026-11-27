/**
 * Editor tab labels, like VS Code: a tab shows only the file name; when several open tabs share a
 * name, each also gets a short dim hint that tells them apart (the project, ·checkout when not main,
 * and the shortest trailing part of the folder that differs). The full place is in the tooltip.
 */
export interface TabLabelInput {
  id: string;
  path: string;
  /** Project name plus `·checkout` when the tab is not on the main checkout. */
  context: string;
}

export interface TabLabel {
  name: string;
  /** Set only when another open tab has the same name. */
  hint?: string;
}

const dirOf = (path: string) => path.split('/').slice(0, -1);
const nameOf = (path: string) => path.split('/').pop() ?? path;

/** The shortest trailing folder part (k segments) that is different for every distinct folder. */
function folderHints(dirs: string[][]): Map<string, string> {
  const distinct = [...new Map(dirs.map((d) => [d.join('/'), d])).values()];
  const max = Math.max(...distinct.map((d) => d.length));
  let k = 1;
  for (; k < max; k++) {
    const keys = distinct.map((d) => d.slice(-k).join('/'));
    if (new Set(keys).size === keys.length) break;
  }
  return new Map(
    distinct.map((d) => {
      const full = d.join('/');
      if (d.length === 0) return [full, '/'];
      return [full, d.length > k ? `…/${d.slice(-k).join('/')}` : full];
    }),
  );
}

export function tabLabels(tabs: TabLabelInput[]): Map<string, TabLabel> {
  const out = new Map<string, TabLabel>();
  const groups = new Map<string, TabLabelInput[]>();
  for (const t of tabs) {
    const name = nameOf(t.path);
    groups.set(name, [...(groups.get(name) ?? []), t]);
  }
  for (const [name, group] of groups) {
    if (group.length === 1) {
      out.set(group[0]!.id, { name });
      continue;
    }
    const needContext = new Set(group.map((t) => t.context)).size > 1;
    const dirs = group.map((t) => dirOf(t.path));
    const needDirs = new Set(dirs.map((d) => d.join('/'))).size > 1;
    const hints = needDirs ? folderHints(dirs) : undefined;
    for (const t of group) {
      const parts = [needContext ? t.context : undefined, hints?.get(dirOf(t.path).join('/'))].filter(Boolean);
      out.set(t.id, { name, hint: parts.length ? parts.join(' › ') : undefined });
    }
  }
  return out;
}
