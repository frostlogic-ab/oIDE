import { homedir } from 'node:os';

/**
 * Redaction for everything oIDE writes to its own logs, crash reports and copyable diagnostics.
 * It removes, in order:
 *
 * - values the app registered as secret (`addSecret`: MCP per-agent secrets, keys read from the keychain);
 * - well-known token shapes (API keys, GitHub / Slack / AWS / Google tokens, JWTs, `Bearer …`);
 * - `key=value` / `"key": "value"` pairs whose key looks secret (token, secret, password, api key, auth…);
 * - credentials in URLs (`https://user:pass@host`, `?token=…`);
 * - the user's home folder (→ `~`) and any extra path prefixes (userData → `<userData>`).
 *
 * Objects are walked (depth and size capped): keys that look secret and every value under an
 * `env` key are replaced, so environment values never reach a log file.
 */

export const REDACTED = '[redacted]';

const TOKEN_PATTERNS: RegExp[] = [
  /\bsk-ant-[A-Za-z0-9_-]{8,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** Key names whose values are secret. */
export const SECRET_KEY = /(?:token|secret|passw(?:or)?d|^pwd$|api[_-]?key|apikey|^auth$|authorization|credential|private[_-]?key|session[_-]?key|cookie)/i;

const BEARER = /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
// key: value / key=value / "key": "value" with a secret-looking key.
const KV = /((?:["']?)[A-Za-z0-9_.-]*(?:token|secret|passw(?:or)?d|pwd|api[_-]?key|apikey|authorization|credential|private[_-]?key|session[_-]?key|cookie)[A-Za-z0-9_.-]*["']?\s*[:=]\s*)(["']?)(?!\d+\b)([^\s"',;&}]{6,})\2/gi;
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi;
const URL_SECRET_PARAM = /([?&](?:access_token|token|key|api_key|apikey|secret|sig|signature|password|code)=)[^&#\s]+/gi;

export interface RedactorOptions {
  /** Home folder to replace with `~` (default `os.homedir()`). */
  home?: string;
  /** Extra path prefixes and their replacement, e.g. `{ [userData]: '<userData>' }`. */
  paths?: Record<string, string>;
  /** Max string length kept (longer strings are cut). */
  maxString?: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Both slash styles of a path, case-insensitive (Windows and macOS file systems ignore case). */
function pathPattern(p: string): RegExp | null {
  const trimmed = p.replace(/[\\/]+$/, '');
  if (trimmed.length < 3) return null;
  const parts = trimmed.split(/[\\/]+/).map(escapeRe);
  // file:///C:/Users/x and C:\Users\x and C:/Users/x; also URL-encoded spaces.
  const body = parts.map((seg) => seg.replace(/ /g, '(?: |%20)')).join('[\\\\/]+');
  return new RegExp(body, 'gi');
}

/**
 * Every value read from `store` is registered with `redactor`, so keychain secrets (custom model
 * keys, extension secrets, MCP OAuth tokens, custom server env secrets) never reach a log line.
 */
export function redactSecretReads<T extends { get(key: string): string | undefined }>(store: T, redactor: Redactor): T {
  const read = store.get.bind(store);
  store.get = (key: string) => {
    const v = read(key);
    redactor.addStoredSecret(v);
    return v;
  };
  return store;
}

const NOT_A_SECRET_FIELD = /(?:type|endpoint|url|uri|expires(?:_?(?:in|at))?|scope)$/i;

export class Redactor {
  private readonly secrets = new Set<string>();
  private pathRules: Array<{ re: RegExp; to: string }> = [];
  private readonly maxString: number;

  constructor(opts: RedactorOptions = {}) {
    this.maxString = opts.maxString ?? 8000;
    const rules: Array<[string, string]> = Object.entries(opts.paths ?? {});
    let home = opts.home;
    if (home === undefined) {
      try {
        home = homedir();
      } catch {
        home = '';
      }
    }
    if (home) rules.push([home, '~']);
    // Longest prefix first, so userData (inside home) wins over home.
    rules.sort((a, b) => b[0].length - a[0].length);
    for (const [p, to] of rules) {
      const re = pathPattern(p);
      if (re) this.pathRules.push({ re, to });
    }
  }

  /** Register a concrete secret value (ignored when shorter than 6 characters). */
  addSecret(value: string | undefined | null): void {
    if (typeof value === 'string' && value.length >= 6) this.secrets.add(value);
  }

  /** Register the values of secret-looking variables in an env map. */
  addEnvSecrets(env: Record<string, string | undefined>): void {
    for (const [k, v] of Object.entries(env)) if (SECRET_KEY.test(k)) this.addSecret(v);
  }

  /**
   * Register a value read from the keychain. A JSON object (stored OAuth tokens, client info) also
   * registers its string leaves under secret-looking keys (`access_token`, `client_secret`, …).
   */
  addStoredSecret(value: string | undefined | null): void {
    if (typeof value !== 'string') return;
    this.addSecret(value);
    if (!value.startsWith('{')) return;
    try {
      const walk = (v: unknown, depth: number): void => {
        if (depth > 4 || !v || typeof v !== 'object') return;
        for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
          // `token_type: "Bearer"`, `token_endpoint`, … describe a token; they are not one.
          if (typeof x === 'string' && SECRET_KEY.test(k) && !NOT_A_SECRET_FIELD.test(k)) this.addSecret(x);
          else walk(x, depth + 1);
        }
      };
      walk(JSON.parse(value), 0);
    } catch {
      // Not JSON: the whole value is registered already.
    }
  }

  /** Add a path prefix rule after construction (e.g. a project folder). */
  addPath(prefix: string, to: string): void {
    const re = pathPattern(prefix);
    if (!re) return;
    this.pathRules.push({ re, to });
    this.pathRules.sort((a, b) => b.re.source.length - a.re.source.length);
  }

  string(input: string): string {
    let s = input;
    for (const v of this.secrets) if (s.includes(v)) s = s.split(v).join(REDACTED);
    for (const re of TOKEN_PATTERNS) s = s.replace(re, REDACTED);
    s = s.replace(BEARER, (_m, kind: string) => `${kind} ${REDACTED}`);
    s = s.replace(URL_USERINFO, `$1${REDACTED}@`);
    s = s.replace(URL_SECRET_PARAM, `$1${REDACTED}`);
    s = s.replace(KV, (_m, key: string, q: string) => `${key}${q}${REDACTED}${q}`);
    for (const { re, to } of this.pathRules) s = s.replace(re, to);
    if (s.length > this.maxString) s = `${s.slice(0, this.maxString)}… [${s.length - this.maxString} more chars]`;
    return s;
  }

  /** Deep-redact any value into something JSON-safe. */
  value(input: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
    if (input === null || input === undefined) return input;
    if (typeof input === 'string') return this.string(input);
    if (typeof input === 'number' || typeof input === 'boolean') return input;
    if (typeof input === 'bigint') return input.toString();
    if (typeof input === 'function' || typeof input === 'symbol') return `[${typeof input}]`;
    if (input instanceof Error) {
      const out: Record<string, unknown> = { name: input.name, message: this.string(input.message) };
      if (input.stack) out.stack = this.string(input.stack);
      const code = (input as { code?: unknown }).code;
      if (typeof code === 'string' || typeof code === 'number') out.code = code;
      return out;
    }
    if (typeof input !== 'object') return String(input);
    if (seen.has(input)) return '[circular]';
    if (depth >= 6) return '[…]';
    seen.add(input);
    if (Array.isArray(input)) {
      const arr = input.slice(0, 50).map((v) => this.value(v, depth + 1, seen));
      if (input.length > 50) arr.push(`[${input.length - 50} more]`);
      return arr;
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (++n > 100) {
        out['…'] = 'more keys';
        break;
      }
      // Only string values: `inputTokens: 1200` is a count, not a secret.
      if (SECRET_KEY.test(k) && typeof v === 'string') out[k] = v === '' ? v : REDACTED;
      else if (/^env$/i.test(k) && v && typeof v === 'object') out[k] = Object.fromEntries(Object.keys(v).map((ek) => [ek, REDACTED]));
      else out[k] = this.value(v, depth + 1, seen);
    }
    return out;
  }

  /** Format log arguments as one redacted line. */
  format(args: unknown[]): string {
    return args
      .map((a) => {
        if (typeof a === 'string') return this.string(a);
        const v = this.value(a);
        // An Error prints as its stack. A plain object that merely has a `stack` field (a screen
        // error report) stays JSON, so its name and message are kept (SEC-35).
        if (a instanceof Error && v && typeof v === 'object' && typeof (v as { stack?: unknown }).stack === 'string') {
          return (v as { stack: string }).stack;
        }
        try {
          return JSON.stringify(v);
        } catch {
          return String(v);
        }
      })
      .join(' ');
  }
}
