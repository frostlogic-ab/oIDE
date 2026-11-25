import type { Redactor } from '../reliability/redact.js';

/**
 * Scrubbing for error reports that leave the machine (opt-in "Send crash and error reports",
 * docs/wiki/pages/telemetry.md). Stricter than the log redactor it builds on (reliability/redact.ts):
 * logs stay local, these do not.
 *
 * - name: identifier characters only (`TypeError`), else `Error`.
 * - message: secrets and token shapes (the log redactor), then every URL, email, quoted string,
 *   absolute or relative path, file name, UUID, long hex or base64 run, IP address, the user name
 *   and the machine name are replaced by a placeholder (`<path>`, `<url>`, `<email>`, `"…"`,
 *   `<token>`, …). Capped at 500 characters.
 * - stack: only frames inside the app bundle survive, as app-relative paths (`/out/main/index.js`),
 *   with the function name reduced to identifier characters. Every other frame (Node internals,
 *   user files, anything outside the bundle) is dropped. The first line is rebuilt from the
 *   scrubbed name and message, so the raw message never rides along in the stack.
 */

export interface ScrubOptions {
  /** The log redactor: registered secrets, token shapes, `key=value` secrets, home → `~`. */
  redactor?: Redactor;
  /** OS user name (removed wherever it appears as a word). */
  username?: string;
  /** Machine name (removed wherever it appears as a word). */
  hostname?: string;
  /** Folders of the app bundle (app.getAppPath(), resources): frames under them are kept. */
  appRoots?: string[];
  /** Origins that serve the app (the dev server): frames from them are kept. */
  appOrigins?: string[];
}

export interface Scrubber {
  name(s: unknown): string;
  message(s: unknown): string;
  /** App-bundle frames only, in V8 form, behind a `<name>: <message>` line. */
  stack(stack: unknown, name: string, message: string): string;
}

export const MAX_MESSAGE = 500;
export const MAX_FRAMES = 30;

const FILE_EXT =
  'md|mdx|ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|py|rs|go|java|kt|rb|php|c|cc|cpp|h|hpp|cs|swift|m|scala|lua|txt|yml|yaml|toml|ini|cfg|conf|lock|html|htm|css|scss|less|sql|sh|bash|zsh|ps1|bat|cmd|png|jpe?g|gif|webp|svg|ico|pdf|docx?|xlsx?|pptx?|zip|gz|tgz|tar|7z|db|sqlite|log|env|xml|csv|tsv|ipynb|vue|svelte|astro|dart|ex|exs|erl|hs|ml|r|pl|tf|dockerfile|patch|diff|pem|key|crt';

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A whole-word, case-insensitive pattern for a name (null when too short to be meaningful). */
function wordPattern(word: string | undefined): RegExp | null {
  const w = (word ?? '').trim();
  if (w.length < 3) return null;
  return new RegExp(`(?<![A-Za-z0-9])${escapeRe(w)}(?![A-Za-z0-9])`, 'gi');
}

const RULES: Array<[RegExp, string | ((m: string) => string)]> = [
  // URLs of any scheme (file:, http:, vscode:, …), with or without a query: the whole URL goes.
  [/\b[a-z][a-z0-9+.-]{1,20}:\/\/[^\s'"`<>()[\]{}]*/gi, '<url>'],
  // mailto-less emails.
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '<email>'],
  // Quoted content: could be a prompt, code, a project or branch name. Removed whatever its length.
  [/`[^`\n]*`/g, '`…`'],
  [/"(?:[^"\\\n]|\\.)*"/g, '"…"'],
  [/'(?:[^'\\\n]|\\.)*'/g, "'…'"],
  // Absolute paths: Windows drive (both slash styles), UNC, POSIX, home (`~`, also after the redactor).
  [/(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\)[^\s'"`<>|]*/g, '<path>'],
  [/(?<![\w.<>-])~(?:[\\/][^\s'"`<>|]*)?/g, '<path>'],
  [/(?<![\w.<>-])\/[^\s'"`<>|,;()]+/g, '<path>'],
  // Relative paths: anything with a separator between name characters (`src/x.ts`, `a\b`).
  [/(?:[\w.@~$-]+[\\/])+[\w.@~$-]*/g, '<path>'],
  // Bare file names with a known extension (`plan.md`).
  [new RegExp(`(?<![\\w<])[\\w.@$-]+\\.(?:${FILE_EXT})\\b`, 'gi'), '<file>'],
  // Ids and token-like runs.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>'],
  [/\b(?:0x)?[0-9a-f]{16,}\b/gi, '<hex>'],
  [/[A-Za-z0-9+/_=-]{24,}/g, (m) => (/\d/.test(m) || m.length >= 32 || /[+/=_]/.test(m) ? '<token>' : m)],
  // IPv4 and IPv6-looking addresses.
  [/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>'],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '<ip>'],
];

function str(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  try {
    return String(v);
  } catch {
    return '';
  }
}

function normalizeLoc(loc: string): string {
  let s = loc.trim();
  if (/^file:/i.test(s)) {
    s = s.replace(/^file:\/*/i, '');
    try {
      s = decodeURI(s);
    } catch {
      /* keep */
    }
    if (!/^[A-Za-z]:/.test(s)) s = `/${s}`;
  }
  return s.replace(/\\/g, '/');
}

function normalizeRoot(root: string): string {
  return normalizeLoc(root).replace(/\/+$/, '').toLowerCase() + '/';
}

export function createScrubber(o: ScrubOptions = {}): Scrubber {
  const people = [wordPattern(o.username), wordPattern(o.hostname)].filter((r): r is RegExp => !!r);
  const roots = (o.appRoots ?? [])
    .filter((r) => r && r.length >= 3)
    .map(normalizeRoot)
    .sort((a, b) => b.length - a.length);
  const origins = (o.appOrigins ?? [])
    .map((x) => {
      try {
        return new URL(x).origin.toLowerCase();
      } catch {
        return '';
      }
    })
    .filter(Boolean);

  const message = (input: unknown): string => {
    let s = str(input);
    if (s.length > 20_000) s = s.slice(0, 20_000);
    if (o.redactor) s = o.redactor.string(s);
    for (const [re, to] of RULES)
      s = typeof to === 'string' ? s.replace(re, to) : s.replace(re, (m) => to(m));
    // After the rules, so paths and emails that contain the names are removed whole first.
    for (const re of people) s = s.replace(re, '<user>');
    s = s.replace(/\s+/g, ' ').trim();
    return s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE - 1)}…` : s;
  };

  const name = (input: unknown): string => {
    const n = str(input)
      .replace(/[^A-Za-z0-9_$]/g, '')
      .slice(0, 60);
    return /^[A-Za-z_$]/.test(n) ? n : 'Error';
  };

  /** The app-relative location (`/out/main/index.js`) of a frame, or null when it is not an app frame. */
  const appRelative = (loc: string): string | null => {
    const raw = loc.trim();
    const http = /^(https?:\/\/[^/]+)(\/[^?#]*)/i.exec(raw);
    if (http) return origins.includes(http[1]!.toLowerCase()) ? http[2]! : null;
    const n = normalizeLoc(raw.replace(/[?#].*$/, ''));
    const lower = n.toLowerCase();
    for (const r of roots) if (lower.startsWith(r)) return `/${n.slice(r.length)}`;
    return null;
  };

  const stack = (input: unknown, nm: string, msg: string): string => {
    const lines = [`${nm}: ${msg}`];
    let kept = 0;
    for (const rawLine of str(input).split(/\r?\n/).slice(0, 200)) {
      const line = rawLine.trim();
      let fn: string;
      let loc: string;
      let m = /^at (?:(.+?) \()?(.+?)\)?$/.exec(line);
      if (m && line.startsWith('at ')) {
        fn = m[1] ?? '';
        loc = m[2] ?? '';
      } else if ((m = /^([^@\s]*)@(.+)$/.exec(line))) {
        fn = m[1] ?? '';
        loc = m[2] ?? '';
      } else continue;
      const pos = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(loc);
      const file = pos?.[1] ?? loc;
      const rel = appRelative(file);
      if (!rel || !/^\/[\w./@+-]*$/.test(rel) || rel.includes('..')) continue;
      const cleanFn =
        fn
          .replace(/^async /, '')
          .replace(/[^\w.$<>[\]-]/g, '')
          .slice(0, 80) || '<anonymous>';
      lines.push(`    at ${cleanFn} (${rel}${pos?.[2] ? `:${pos[2]}` : ''}${pos?.[3] ? `:${pos[3]}` : ''})`);
      if (++kept >= MAX_FRAMES) break;
    }
    return lines.join('\n');
  };

  return { name, message, stack };
}
