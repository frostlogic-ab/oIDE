/**
 * Command registry behind the command bar (Ctrl/Cmd+K). Core registers its commands at boot
 * (lib/coreCommands.ts); extensions contribute commands through their manifest
 * (`contributes.commands`), which run in the extension host via `extensions.runCommand`. Main can
 * ask the renderer to run any registered command with the `command.invoke` event.
 */

export interface Command {
  /** Stable id, e.g. "oide.spawn" or "<extension>.<command>". */
  id: string;
  title: string;
  /** Group heading in the command bar ("Agents", "Go to", "Extensions"). */
  group?: string;
  /** Extra words that should match the fuzzy filter. */
  keywords?: string[];
  /** Shortcut label shown on the right ("N", "Ctrl K"). */
  hint?: string;
  source?: 'core' | 'extension';
  /** Hidden when this returns false. */
  when?: () => boolean;
  /** Return `{ keepOpen: true }` to keep the command bar open (e.g. to switch to a sub-list). */
  run: () => void | { keepOpen: true } | Promise<void | { keepOpen: true }>;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private listeners = new Set<() => void>();
  private version = 0;

  register(cmds: Command | Command[]): () => void {
    const list = Array.isArray(cmds) ? cmds : [cmds];
    for (const c of list) this.commands.set(c.id, c);
    this.changed();
    return () => {
      for (const c of list) if (this.commands.get(c.id) === c) this.commands.delete(c.id);
      this.changed();
    };
  }

  /** Remove every command from one source (used when the installed extensions change). */
  clearSource(source: Command['source']): void {
    for (const [id, c] of this.commands) if (c.source === source) this.commands.delete(id);
    this.changed();
  }

  get(id: string): Command | undefined {
    return this.commands.get(id);
  }

  list(): Command[] {
    return [...this.commands.values()].filter((c) => !c.when || c.when());
  }

  async run(id: string): Promise<void | { keepOpen: true }> {
    const c = this.commands.get(id);
    if (!c) throw new Error(`Unknown command ${id}`);
    return c.run();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Changes on every register/unregister; for useSyncExternalStore. */
  getVersion(): number {
    return this.version;
  }

  private changed(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }
}

/**
 * Fuzzy subsequence score: higher is better, `null` when `query` is not a subsequence of `text`.
 * Bonuses for matches at word starts and for consecutive runs; prefix matches rank first.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const t = text.toLowerCase();
  if (t.startsWith(q)) return 1000 - t.length;
  const idx = t.indexOf(q);
  if (idx >= 0) return 800 - idx - t.length / 10;
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s\-_./·]/.test(t[found - 1] ?? '');
    score += 10 + (wordStart ? 15 : 0) + (found === prev + 1 ? 10 : 0) - Math.min(found - ti, 10);
    prev = found;
    ti = found + 1;
  }
  return score - t.length / 10;
}

export interface Scored<T> {
  item: T;
  score: number;
}

export function fuzzyFilter<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  if (!query.trim()) return [...items];
  const scored: Scored<T>[] = [];
  for (const item of items) {
    const s = fuzzyScore(query, text(item));
    if (s !== null) scored.push({ item, score: s });
  }
  return scored.sort((a, b) => b.score - a.score).map((s) => s.item);
}

export function filterCommands(cmds: readonly Command[], query: string): Command[] {
  return fuzzyFilter(cmds, query, (c) => [c.title, c.group ?? '', ...(c.keywords ?? [])].join(' '));
}

export const commands = new CommandRegistry();
