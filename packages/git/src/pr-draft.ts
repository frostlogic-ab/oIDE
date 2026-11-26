import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult } from '@oide/protocol';
import { isSafeRef, toGit, type Repo } from './git.js';

/**
 * Pull request title and description that follow the project's own conventions: its PR template
 * (filled with the agent's summary and checks) and, when the project asks for Conventional Commits
 * titles (commitlint, release-please, semantic-release, a PR-title check, or its own history), a
 * `type(scope): subject` title. The agent's own draft (submit_for_review `pr`) wins over all of it;
 * this is the fallback when the agent gave none. Reads files only; never runs project code.
 */

export interface PrTemplate {
  /** Repo-relative path, forward slashes. */
  path: string;
  text: string;
}

export interface PrConventions {
  template?: PrTemplate;
  /** The project wants Conventional Commits PR titles. */
  conventional: boolean;
  /** What told us so. */
  conventionalSource?: 'commitlint' | 'release-please' | 'semantic-release' | 'workflow' | 'history';
}

export const CONVENTIONAL_TYPES = ['feat', 'fix', 'perf', 'security', 'revert', 'deps', 'docs', 'refactor', 'test', 'build', 'ci', 'chore', 'style'] as const;
export type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];

/** `type(scope)!: subject`; a few extra types projects commonly allow (`wip`, `release`) count too. */
const CONVENTIONAL = /^([a-z]+)(\(([A-Za-z0-9._/ -]+)\))?(!)?: (\S.*)$/;
const KNOWN_TYPES = new Set<string>([...CONVENTIONAL_TYPES, 'release', 'wip', 'feature', 'bugfix', 'hotfix', 'i18n', 'types']);

export function parseConventional(subject: string): { type: string; scope?: string; breaking: boolean; subject: string } | undefined {
  const m = CONVENTIONAL.exec(subject.trim());
  if (!m || !KNOWN_TYPES.has(m[1]!)) return undefined;
  return { type: m[1]!, ...(m[3] ? { scope: m[3] } : {}), breaking: !!m[4], subject: m[5]! };
}

const TEMPLATE_DIRS = ['.github', '', 'docs'];
const TEMPLATE_FILE = /^pull_request_template\.(md|markdown|txt)$/i;
const TEMPLATE_MAX = 64 * 1024;

async function list(dir: string): Promise<Array<{ name: string; dir: boolean }>> {
  try {
    return (await readdir(dir, { withFileTypes: true })).map((e) => ({ name: e.name, dir: e.isDirectory() }));
  } catch {
    return [];
  }
}

async function readSmall(path: string, max = TEMPLATE_MAX): Promise<string | undefined> {
  try {
    const buf = await readFile(path);
    if (buf.length > max) return undefined;
    return buf.toString('utf8').replace(/\r\n/g, '\n');
  } catch {
    return undefined;
  }
}

/** GitHub's PR template locations, in GitHub's order; a template folder gives its `default` file, else the first. */
export async function findPrTemplate(root: string): Promise<PrTemplate | undefined> {
  for (const d of TEMPLATE_DIRS) {
    const entries = await list(join(root, d));
    const file = entries.find((e) => !e.dir && TEMPLATE_FILE.test(e.name));
    if (file) {
      const text = await readSmall(join(root, d, file.name));
      if (text?.trim()) return { path: [d, file.name].filter(Boolean).join('/'), text };
    }
    const folder = entries.find((e) => e.dir && e.name.toLowerCase() === 'pull_request_template');
    if (folder) {
      const files = (await list(join(root, d, folder.name))).filter((e) => !e.dir && /\.(md|markdown|txt)$/i.test(e.name)).map((e) => e.name).sort();
      const pick = files.find((n) => /^default\./i.test(n)) ?? files[0];
      const text = pick ? await readSmall(join(root, d, folder.name, pick)) : undefined;
      if (pick && text?.trim()) return { path: [d, folder.name, pick].filter(Boolean).join('/'), text };
    }
  }
  return undefined;
}

const COMMITLINT = /^(\.commitlintrc(\.(json|ya?ml|js|cjs|mjs|ts))?|commitlint\.config\.(js|cjs|mjs|ts|cts|mts))$/;
const RELEASE_PLEASE = /^(release-please-config\.json|\.release-please-manifest\.json)$/;
const SEMANTIC_RELEASE = /^(\.releaserc(\.(json|ya?ml|js|cjs|mjs))?|release\.config\.(js|cjs|mjs))$/;
const WORKFLOW_HINT = /semantic-pull-request|conventional[- ]commits?|commitlint|release-please|semantic-release/i;

/** Config files that ask for Conventional Commits, without running anything. */
export async function detectConventionalConfig(root: string): Promise<PrConventions['conventionalSource']> {
  const top = (await list(root)).filter((e) => !e.dir).map((e) => e.name);
  if (top.some((n) => COMMITLINT.test(n))) return 'commitlint';
  if (top.some((n) => RELEASE_PLEASE.test(n))) return 'release-please';
  if (top.some((n) => SEMANTIC_RELEASE.test(n))) return 'semantic-release';
  const pkg = top.includes('package.json') ? await readSmall(join(root, 'package.json'), 1024 * 1024) : undefined;
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as Record<string, unknown>;
      if (j.commitlint) return 'commitlint';
      if (j.release) return 'semantic-release';
    } catch {
      // Not JSON: ignore.
    }
  }
  const wf = join(root, '.github', 'workflows');
  for (const e of (await list(wf)).filter((x) => !x.dir && /\.ya?ml$/i.test(x.name)).slice(0, 50)) {
    const text = await readSmall(join(wf, e.name), 256 * 1024);
    if (text && WORKFLOW_HINT.test(text)) return 'workflow';
  }
  return undefined;
}

/** Most of the recent subjects (at least 5 of them) already follow Conventional Commits. */
export function historyIsConventional(subjects: readonly string[]): boolean {
  const s = subjects.filter((x) => !/^Merge (branch|pull request|remote-tracking)/.test(x));
  if (s.length < 5) return false;
  return s.filter((x) => parseConventional(x)).length / s.length >= 0.6;
}

async function subjects(repo: Repo, range: string, limit: number): Promise<string[]> {
  try {
    const out = await toGit(repo).out(['log', '--no-merges', `-n${limit}`, '--format=%s', '--end-of-options', range, '--']);
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Template and title rules of the checkout at `root` (an agent's worktree carries the same files). */
export async function readPrConventions(root: string, opts: { baseRef?: string } = {}): Promise<PrConventions> {
  const [template, source] = await Promise.all([findPrTemplate(root), detectConventionalConfig(root)]);
  let conventionalSource = source;
  if (!conventionalSource) {
    const base = opts.baseRef && isSafeRef(opts.baseRef) ? opts.baseRef : 'HEAD';
    if (historyIsConventional(await subjects(root, base, 30))) conventionalSource = 'history';
  }
  return { ...(template ? { template } : {}), conventional: !!conventionalSource, ...(conventionalSource ? { conventionalSource } : {}) };
}

/** Subjects of the commits on `branch` that are not on `base`, newest first. */
export function branchSubjects(repo: Repo, base: string, branch: string): Promise<string[]> {
  if (!isSafeRef(base) || !isSafeRef(branch)) return Promise.resolve([]);
  return subjects(repo, `${base}..${branch}`, 100);
}

// ---------------------------------------------------------------- composing

/** Higher wins when the branch mixes commit types (a feature with a fix in it is a feature). */
const TYPE_RANK: readonly string[] = ['feat', 'fix', 'perf', 'security', 'revert', 'deps', 'refactor', 'docs', 'test', 'build', 'ci', 'chore', 'style'];
const ALIAS: Record<string, string> = { feature: 'feat', bugfix: 'fix', hotfix: 'fix', types: 'refactor', i18n: 'feat', wip: 'chore', release: 'chore' };

/** A type for a plain title when the branch's commits do not say. */
function typeFromWords(title: string): ConventionalType {
  const t = title.toLowerCase();
  if (/\b(fix|fixes|fixed|bug|crash|broken|regression|error|wrong|repair)\b/.test(t)) return 'fix';
  if (/\b(docs?|readme|wiki|documentation|changelog)\b/.test(t)) return 'docs';
  if (/\b(tests?|e2e|coverage|flaky)\b/.test(t)) return 'test';
  if (/\b(ci|workflows?|pipeline)\b/.test(t)) return 'ci';
  if (/\b(refactor|clean ?up|simplify|rename)\b/.test(t)) return 'refactor';
  if (/\b(perf|performance|faster|speed up|slow)\b/.test(t)) return 'perf';
  if (/\b(bump|upgrade|dependenc(y|ies)|deps)\b/.test(t)) return 'deps';
  return 'feat';
}

/** Lower-case the first letter (commitlint's default forbids sentence case), but keep acronyms like `CI` or `PR`. */
function lowerFirst(s: string): string {
  const word = /^\S+/.exec(s)?.[0] ?? '';
  if (word.length > 1 && word === word.toUpperCase()) return s;
  if (/^[A-Z][a-z]*[A-Z]/.test(word)) return s; // camelCase / brand names: GitHub, macOS
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * A Conventional Commits title for `title`: kept when it already is one; otherwise typed from the
 * branch's own conventional commits (the strongest type, their shared scope, `!` if any breaks) or,
 * failing that, from the title's words.
 */
export function conventionalTitle(title: string, commits: readonly string[] = []): string {
  const clean = title.trim().replace(/\s+/g, ' ').replace(/[.。]+$/, '');
  if (parseConventional(clean)) return clean;
  const parsed = commits.map(parseConventional).filter((c): c is NonNullable<typeof c> => !!c);
  const types = parsed.map((c) => ALIAS[c.type] ?? c.type);
  const ranked = types.filter((t) => TYPE_RANK.includes(t)).sort((a, b) => TYPE_RANK.indexOf(a) - TYPE_RANK.indexOf(b));
  const type = ranked[0] ?? typeFromWords(clean);
  const scopes = new Set(parsed.map((c) => c.scope));
  const scope = parsed.length && scopes.size === 1 ? [...scopes][0] : undefined;
  const breaking = parsed.some((c) => c.breaking);
  return `${type}${scope ? `(${scope})` : ''}${breaking ? '!' : ''}: ${lowerFirst(clean)}`;
}

export function checksMarkdown(checks: readonly CheckResult[], heading = true): string {
  if (!checks.length) return '';
  const mark = { passed: '[x]', failed: '[ ] FAILED', warning: '[ ] warning', skipped: '[ ] skipped' } as const;
  const lines = checks.map((c) => `- ${mark[c.status]} ${c.name}${c.detail ? `: ${c.detail}` : ''}`);
  return (heading ? ['Checks the agent ran:', ...lines] : lines).join('\n');
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const SUMMARY_HEADING = /\b(summary|description|what|changes?|overview|about|motivation|context|purpose|details)\b/i;
const TESTING_HEADING = /\b(test(s|ed|ing)?|checks?|verif(y|ied|ication)|validation|qa)\b/i;

/**
 * Fill a PR template: the summary goes under its first summary-like heading (Summary, Description,
 * What changed…), the checks under its first testing-like heading (How I tested it, Testing…). The
 * rest of the template (checklists, comments for the reviewer) is kept as written. Without such
 * headings the summary goes on top and the checks at the end.
 */
export function fillTemplate(template: string, summary: string, checks: readonly CheckResult[]): string {
  const lines = template.replace(/\r\n/g, '\n').split('\n');
  const headings = lines.map((l, i) => ({ i, m: HEADING.exec(l) })).filter((h) => h.m);
  const summaryAt = headings.find((h) => SUMMARY_HEADING.test(h.m![2]!) && !TESTING_HEADING.test(h.m![2]!))?.i;
  const testingAt = headings.find((h) => TESTING_HEADING.test(h.m![2]!))?.i;
  const checksText = checksMarkdown(checks, false);
  const inserts = new Map<number, string>();
  if (summaryAt !== undefined && summary.trim()) inserts.set(summaryAt, summary.trim());
  if (testingAt !== undefined && checksText) inserts.set(testingAt, checksText);

  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    out.push(lines[i]!);
    const add = inserts.get(i);
    if (add === undefined) continue;
    // After the heading's guidance comment (`<!-- … -->`), so the reviewer still sees the prompt in the editor.
    let j = i + 1;
    while (j < lines.length && !lines[j]!.trim()) j++;
    if (j < lines.length && lines[j]!.trim().startsWith('<!--')) {
      let k = j;
      while (k < lines.length && !lines[k]!.includes('-->')) k++;
      for (let x = i + 1; x <= Math.min(k, lines.length - 1); x++) out.push(lines[x]!);
      i = Math.min(k, lines.length - 1);
    }
    out.push('', add);
  }
  let body = out.join('\n');
  if (summaryAt === undefined && summary.trim()) body = `${summary.trim()}\n\n${body}`;
  if (testingAt === undefined && checksText) body = `${body.trimEnd()}\n\n${checksMarkdown(checks)}`;
  return `${body.trimEnd()}\n`;
}

export interface PrDraftInput {
  /** The agent's title (fallback title). */
  title: string;
  summary?: string;
  checks?: readonly CheckResult[];
  /** The agent's own draft from submit_for_review; used as written. */
  agentDraft?: { title: string; body: string };
  conventions: PrConventions;
  /** Subjects of the branch's commits (for the Conventional Commits type and scope). */
  commits?: readonly string[];
}

export type PrDraftSource = 'agent' | 'template' | 'plain';

/** Title and body for `gh pr create`, and where they came from. */
export function composePr(input: PrDraftInput): { title: string; body: string; source: PrDraftSource } {
  if (input.agentDraft?.title.trim()) {
    const title = input.agentDraft.title.trim();
    return { title: input.conventions.conventional ? conventionalTitle(title, input.commits) : title, body: input.agentDraft.body, source: 'agent' };
  }
  const summary = input.summary ?? '';
  const checks = input.checks ?? [];
  const title = input.conventions.conventional ? conventionalTitle(input.title, input.commits) : input.title.trim();
  if (input.conventions.template) return { title, body: fillTemplate(input.conventions.template.text, summary, checks), source: 'template' };
  return { title, body: [summary.trim(), checksMarkdown(checks)].filter(Boolean).join('\n\n'), source: 'plain' };
}
