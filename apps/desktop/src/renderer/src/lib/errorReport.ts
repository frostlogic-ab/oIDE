/**
 * Copyable error reports for the screen error boundaries. A report holds the screen, the error's
 * name, a shortened message, and stack / component-stack frames reduced to function names and
 * file base names. Never props, state, transcripts, prompts or code: quoted strings and anything
 * that looks like a path, token or key is stripped. Main redacts again before logging it.
 */

export interface ErrorReportInput {
  screen: string;
  error: unknown;
  componentStack?: string | null;
  appVersion?: string;
  platform?: string;
  now?: Date;
}

export interface ErrorReport {
  screen: string;
  name: string;
  message: string;
  stack: string[];
  componentStack: string[];
  text: string;
}

const TOKENS = [/\bsk-[A-Za-z0-9_-]{8,}/g, /\bgh[pousr]_[A-Za-z0-9]{12,}/g, /\bgithub_pat_[A-Za-z0-9_]{12,}/g, /\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]{6,}/g, /\bBearer\s+\S+/gi];
const PATH = /(?:[a-z][\w+.-]*:\/\/\/?)?(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|private|var|tmp|opt|mnt|Volumes)\/)[^\s'"`()<>]*/g;

export function sanitizeMessage(s: string): string {
  let out = s;
  for (const re of TOKENS) out = out.replace(re, '[redacted]');
  out = out.replace(PATH, (m) => `<path>/${m.replace(/[\\/:]+$/, '').split(/[\\/]/).pop() ?? ''}`);
  out = out
    .replace(/`[^`]*`/g, '`…`')
    .replace(/"(?:[^"\\]|\\.){12,}"/g, '"…"')
    .replace(/'(?:[^'\\]|\\.){12,}'/g, "'…'");
  return out.length > 300 ? `${out.slice(0, 300)}…` : out;
}

/** `at Foo (file:///C:/x/out/renderer/assets/index-abc.js:1:2)` → `at Foo (index-abc.js:1:2)`; Firefox/Safari `fn@url:1:2` too. */
export function reduceFrames(stack: string | null | undefined, max = 15): string[] {
  if (!stack) return [];
  const out: string[] = [];
  for (const raw of stack.split(/\r?\n/)) {
    const line = raw.trim();
    let fn: string | undefined;
    let loc: string | undefined;
    let m = /^at (?:(.+?) )?\(?([^()]*?)\)?$/.exec(line);
    if (m) {
      fn = m[1];
      loc = m[2];
    } else if ((m = /^([^@\s]*)@(.+)$/.exec(line))) {
      fn = m[1];
      loc = m[2];
    } else continue;
    const base = (loc ?? '').split(/[\\/]/).pop()?.replace(/[?#][^:]*/, '') ?? '';
    out.push(`at ${(fn || '<anonymous>').replace(/[^\w.$<> [\]-]/g, '').slice(0, 80)}${base ? ` (${base})` : ''}`);
    if (out.length >= max) break;
  }
  return out;
}

export function buildErrorReport(i: ErrorReportInput): ErrorReport {
  const e = i.error instanceof Error ? i.error : new Error(typeof i.error === 'string' ? i.error : 'Unknown error');
  const name = (e.name || 'Error').replace(/[^\w]/g, '').slice(0, 60) || 'Error';
  const message = sanitizeMessage(e.message ?? '');
  const stack = reduceFrames(e.stack);
  const componentStack = reduceFrames(i.componentStack);
  const lines = [
    `oIDE error report · screen: ${i.screen}`,
    `when: ${(i.now ?? new Date()).toISOString()}${i.appVersion ? ` · oIDE ${i.appVersion}` : ''}${i.platform ? ` · ${i.platform}` : ''}`,
    '',
    `${name}: ${message}`,
    ...stack.map((f) => `  ${f}`),
  ];
  if (componentStack.length) lines.push('', 'Components:', ...componentStack.map((f) => `  ${f}`));
  return { screen: i.screen, name, message, stack, componentStack, text: lines.join('\n') };
}
