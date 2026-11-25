#!/usr/bin/env node
// record.mjs: record fresh, sanitized fixtures from the installed Claude Code CLI, for the weekly
// CLI compatibility job (.github/workflows/cli-compat.yml) and test/conformance/cli-compat.test.ts.
//
//   node tools/fake-claude/record.mjs --out <dir>                 # version + help (no sign-in needed)
//   node tools/fake-claude/record.mjs --out <dir> --session       # also a scripted stream-json session
//   options: --claude <path>   CLI to run (default: `claude` on PATH)
//            --model <alias>   model for --session (default: haiku, the cheapest)
//            --timeout <sec>   per turn (default: 120)
//
// Rules (CLAUDE.md hard rules 2-4): this script never opens files under the CLI's config folder,
// never reads token env vars, and never calls Anthropic's API. It runs the user's own CLI with an
// allow-listed env (same list as packages/agent-core ENV_ALLOW_LIST, checked by a test), so a
// session uses whatever sign-in the CLI itself already has. Everything written is sanitized:
// home folder, user name, host name, cwd and temp folders (in every spelling: native, forward-slash,
// JSON-escaped, lowercase drive, /c/Users/…, the CLI's slugified project-folder name), any other
// user or temp folder, session ids, uuids, tool/message ids, account/org/user ids, emails and
// anything that looks like a token are replaced with stable placeholders.
//
// Output (one folder): meta.json, version.txt, help.txt and, with --session, session-basic.jsonl
// (replayable with fake-claude `--fake-scenario replay:<file>`) and session-stderr.txt.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir, userInfo } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Exact env names the CLI may see. Mirrors ENV_ALLOW_LIST in packages/agent-core/src/args.ts. */
export const ENV_ALLOW_LIST = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA',
  'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'ProgramData', 'ProgramFiles',
  'ProgramFiles(x86)', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TERM', 'COLORTERM',
  'TZ', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
];
const ALLOW_UPPER = new Set(ENV_ALLOW_LIST.map((k) => k.toUpperCase()));

/** Allow-listed copy of `base` (case-insensitive names, LC_* locale vars kept). */
export function allowListEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    const up = k.toUpperCase();
    if (v !== undefined && (ALLOW_UPPER.has(up) || up.startsWith('LC_'))) env[k] = v;
  }
  return env;
}

/* ------------------------------------------------------------------ sanitizer */

export const PLACEHOLDER = {
  home: '/home/user',
  user: 'user',
  host: 'host',
  cwd: '/work/repo',
  sessionId: '11111111-2222-4333-8444-555555555555',
  email: 'user@example.com',
  secret: 'REDACTED',
  tmp: '/tmp/scratch',
};

/**
 * Keys whose values are always secret-like or identify an account, whatever they contain: tokens,
 * keys, cookies, and the account / organization / user ids, names and e-mails the CLI can print.
 */
const SECRET_KEYS = /^(signature|token|access_?token|refresh_?token|id_?token|api_?key|apikey|authorization|password|secret|cookie|session_?token|oauth.*|(account|organi[sz]ation|org|user|billing|workspace)_?(uuid|id|name|email|role|type)|account|organi[sz]ation|email(_?address)?|display_?name|full_?name|username|login)$/i;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The CLI's project-folder form of a path (`C:\Users\ada\repo` → `C--Users-ada-repo`). */
export const slugPath = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

/**
 * Every spelling of an absolute path that can show up in CLI output: native, forward-slash, JSON-
 * escaped (`\\`), `\/`-escaped, lowercase or uppercase drive (the regex is case-insensitive), MSYS
 * (`/c/Users/…`), WSL (`/mnt/c/…`), macOS `/private` temp, and the CLI's slugified folder name.
 * Returns [form, replacement] pairs; `replacement` is the matching form of `placeholder`.
 */
function pathForms(p, placeholder) {
  const out = new Map();
  const base = p.replace(/[\\/]+$/, '');
  if (base.length < 3) return [];
  const fwd = base.replace(/\\/g, '/');
  const back = base.replace(/\//g, '\\');
  const add = (form, repl) => {
    if (form && form.length >= 3 && !out.has(form)) out.set(form, repl);
  };
  add(base, placeholder);
  add(fwd, placeholder);
  add(back, placeholder);
  add(back.replace(/\\/g, '\\\\'), placeholder);
  add(fwd.replace(/\//g, '\\/'), placeholder.replace(/\//g, '\\/'));
  const drive = /^([A-Za-z]):\/(.*)$/.exec(fwd);
  if (drive) {
    add(`/${drive[1]}/${drive[2]}`, placeholder);
    add(`/mnt/${drive[1]}/${drive[2]}`, placeholder);
  }
  if (fwd.startsWith('/var/') || fwd.startsWith('/tmp/')) add(`/private${fwd}`, placeholder);
  add(slugPath(base), slugPath(placeholder));
  return [...out];
}

/** Path separators as they appear raw, JSON-escaped or `\/`-escaped. */
const SEP = String.raw`(?:\\\\|\\\/|\\|\/)+`;
/** One path segment (no separator, quote, space or markup). */
const SEG = String.raw`[^\\/\s"'<>|:*?\`]+`;

/**
 * Generic rules for paths no ctx value names (other accounts, CI runners, the CLI's own temp and
 * scratchpad folders): user folders become the home placeholder, temp folders the tmp one.
 */
const GENERIC_PATHS = [
  // C:\Users\<name>, c:/Users/<name>, C:\\Users\\<name>, /c/Users/<name>, /mnt/c/Users/<name>
  { re: new RegExp(String.raw`(?:\b[A-Za-z]:|(?<![A-Za-z0-9])(?:\/mnt)?\/[A-Za-z](?=${SEP}Users))${SEP}Users${SEP}(?!Public\b)${SEG}`, 'gi'), to: PLACEHOLDER.home },
  // /Users/<name> (macOS), /home/<name> (Linux)
  { re: new RegExp(String.raw`(?<![A-Za-z0-9_.-])${SEP}(?:Users|home)${SEP}(?!user\b)${SEG}`, 'g'), to: PLACEHOLDER.home },
  // Temp folders and everything under them: …\AppData\Local\Temp\…, C:\Windows\Temp\…, /tmp/…, /var/folders/…/T/…
  { re: new RegExp(String.raw`(?:${SEP}home${SEP}user|\b[A-Za-z]:)?${SEP}(?:AppData${SEP}Local${SEP}Temp|Windows${SEP}Temp)(?:${SEP}${SEG})*`, 'gi'), to: PLACEHOLDER.tmp },
  { re: new RegExp(String.raw`(?<![A-Za-z0-9_.-])(?:${SEP}private)?${SEP}(?:var${SEP}folders${SEP}${SEG}${SEP}${SEG}${SEP}T|tmp)(?!${SEP}scratch\b)(?:${SEP}${SEG})+`, 'g'), to: PLACEHOLDER.tmp },
  // Slug forms (the CLI's ~/.claude/projects/<slug> names): C--Users-<name>-…, -Users-<name>-…, -home-<name>-…
  { re: /\b[A-Za-z]--Users-(?!Public\b)[A-Za-z0-9_]+(?:-AppData-Local-Temp(?:-[A-Za-z0-9_]+)*)?/gi, to: slugPath(PLACEHOLDER.home) },
  { re: /(?<![A-Za-z0-9-])-(?:Users|home)-(?!user\b)[A-Za-z0-9_]+/g, to: slugPath(PLACEHOLDER.home) },
  { re: /-home-user-AppData-Local-Temp(?:-[A-Za-z0-9_]+)*/g, to: slugPath(PLACEHOLDER.tmp) },
];

/**
 * Build a sanitizer for one recording. `ctx`: { home, user, host, cwd, tmp, sessionId } (all
 * optional). The returned object has `text(s)` for plain text and `line(l)` for one stdout line
 * (JSON lines are sanitized structurally, other lines as text). Ids map to stable placeholders, so
 * the same uuid or tool id gets the same replacement everywhere in the recording.
 */
export function createSanitizer(ctx = {}) {
  const maps = { uuid: new Map(), toolu: new Map(), msg: new Map(), req: new Map(), acct: new Map() };
  const literals = [];
  const addLiteral = (value, replacement, { word = false } = {}) => {
    if (!value || value.length < 3) return;
    const forms = new Set([value, value.replace(/\\/g, '\\\\'), value.replace(/\\/g, '/')]);
    for (const f of forms) {
      const body = escapeRe(f);
      literals.push({ re: new RegExp(word ? `(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])` : body, 'gi'), replacement });
    }
  };
  // Longest first: cwd usually sits inside tmp, and tmp inside home.
  // Temp folders take everything under them too (random ids of other tools' scratch folders).
  const paths = [
    [ctx.cwd, PLACEHOLDER.cwd, false],
    [ctx.tmp, PLACEHOLDER.tmp, true],
    [ctx.home, PLACEHOLDER.home, false],
  ]
    .filter(([v]) => v)
    .flatMap(([v, r, eat]) => pathForms(v, r).map(([form, repl]) => [form, repl, eat]))
    .sort((a, b) => b[0].length - a[0].length);
  for (const [form, r, eat] of paths) {
    const tail = !eat ? '' : /^[A-Za-z0-9-]+$/.test(form) ? '(?:-[A-Za-z0-9_]+)*' : `(?:${SEP}${SEG})*`;
    literals.push({ re: new RegExp(escapeRe(form) + tail, 'gi'), replacement: r });
  }
  if (ctx.sessionId) addLiteral(ctx.sessionId, PLACEHOLDER.sessionId);
  addLiteral(ctx.host, PLACEHOLDER.host, { word: true });
  addLiteral(ctx.user, PLACEHOLDER.user, { word: true });

  const stable = (kind, value, make) => {
    const m = maps[kind];
    if (!m.has(value)) m.set(value, make(m.size + 1));
    return m.get(value);
  };
  const pad = (n, w) => String(n).padStart(w, '0');

  function text(input) {
    let s = String(input);
    for (const { re, replacement } of literals) s = s.replace(re, replacement);
    for (const { re, to } of GENERIC_PATHS) s = s.replace(re, to);
    s = s.replace(/[A-Za-z0-9._%+-]+(?:@|%40)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, PLACEHOLDER.email);
    // Account, organization and user ids in prefixed form (org_…, acct_…, user_…, org-…).
    s = s.replace(/\b(?:org|organization|acct|account|user)[-_](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{12,}\b/gi, (t) => stable('acct', t, (n) => `acct_${pad(n, 4)}`));
    // Token shapes: Anthropic keys, bearer headers, JWTs, long opaque strings with digits and letters.
    s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, PLACEHOLDER.secret);
    s = s.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${PLACEHOLDER.secret}`);
    s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, PLACEHOLDER.secret);
    s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) =>
      u.toLowerCase() === PLACEHOLDER.sessionId ? u : stable('uuid', u.toLowerCase(), (n) => `00000000-0000-4000-8000-${pad(n, 12)}`),
    );
    s = s.replace(/\btoolu_[A-Za-z0-9_]+/g, (t) => stable('toolu', t, (n) => `toolu_${pad(n, 4)}`));
    s = s.replace(/\bmsg_[A-Za-z0-9_]+/g, (t) => stable('msg', t, (n) => `msg_${pad(n, 4)}`));
    s = s.replace(/\breq_[A-Za-z0-9_]+/g, (t) => stable('req', t, (n) => `req_${pad(n, 4)}`));
    s = s.replace(/(?<![A-Za-z0-9+/_-])(?=[A-Za-z0-9+_-]*\d)(?=[A-Za-z0-9+_-]*[A-Za-z])[A-Za-z0-9+_-]{40,}={0,2}/g, PLACEHOLDER.secret);
    return s;
  }

  function value(v, key) {
    if (typeof v === 'string') {
      if (!key || !v || !SECRET_KEYS.test(key)) return text(v);
      return /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/.test(v) ? PLACEHOLDER.email : PLACEHOLDER.secret;
    }
    if (Array.isArray(v)) return v.map((x) => value(x));
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[text(k)] = key === undefined && k === 'session_id' && typeof x === 'string' ? PLACEHOLDER.sessionId : value(x, k);
      return out;
    }
    return v;
  }

  function line(l) {
    const trimmed = l.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(value(JSON.parse(trimmed)));
      } catch {
        // not JSON after all
      }
    }
    return text(l);
  }

  return { text, line, value };
}

/* ------------------------------------------------------------------ running the CLI */

/** `claude` on PATH (with PATHEXT on Windows), or undefined. */
export function findOnPath(name, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean) : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    for (const ext of ['', ...exts]) {
      const p = join(dir, name + ext);
      if (ext === '' && process.platform === 'win32') continue;
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

function spawnCli(cli, args, opts) {
  const env = allowListEnv(process.env);
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cli)) {
    // npm shims need cmd.exe; every argument here is a fixed, metacharacter-free string.
    return spawn(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"${[cli, ...args].map((a) => `"${a}"`).join(' ')}"`], { ...opts, env, windowsVerbatimArguments: true, windowsHide: true });
  }
  return spawn(cli, args, { ...opts, env, windowsHide: true });
}

function runOnce(cli, args, timeoutMs = 30_000) {
  return new Promise((done) => {
    const child = spawnCli(cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout, stderr });
    });
  });
}

/** The scripted session: one plain turn, one turn that reads a file (Read is never prompted). */
export const SESSION_TURNS = [
  'Reply with exactly the word: ready',
  'Use the Read tool to read notes.txt in the current folder, then reply with its first word only.',
];

function runSession(cli, { model, timeoutMs, cwd, sessionId }) {
  const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--forward-subagent-text', '--model', model, '--permission-mode', 'default', '--session-id', sessionId];
  return new Promise((done) => {
    const child = spawnCli(cli, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    let buf = '';
    let stderr = '';
    let turn = 0;
    let timer;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stderr += `\n[record] turn ${turn} timed out after ${timeoutMs} ms\n`;
        child.kill();
      }, timeoutMs);
    };
    const send = () => {
      if (turn >= SESSION_TURNS.length) {
        clearTimeout(timer);
        child.stdin.end();
        return;
      }
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: SESSION_TURNS[turn] } })}\n`);
      turn++;
      arm();
    };
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!l.trim()) continue;
        lines.push(l);
        try {
          if (JSON.parse(l).type === 'result') send();
        } catch {
          // non-JSON stdout is kept as-is
        }
      }
    });
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: -1, lines, stderr: stderr + String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim()) lines.push(buf.trim());
      done({ code, lines, stderr });
    });
    send();
  });
}

/* ------------------------------------------------------------------ main */

function parseArgs(argv) {
  const o = { out: undefined, session: false, claude: undefined, model: 'haiku', timeout: 120 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') o.session = true;
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--claude') o.claude = argv[++i];
    else if (a === '--model') o.model = argv[++i];
    else if (a === '--timeout') o.timeout = Number(argv[++i]) || 120;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || !o.out) {
    process.stdout.write('usage: node tools/fake-claude/record.mjs --out <dir> [--session] [--claude <path>] [--model haiku] [--timeout 120]\n');
    process.exit(o.help ? 0 : 2);
  }
  const out = resolve(o.out);
  mkdirSync(out, { recursive: true });
  const cli = o.claude ? (isAbsolute(o.claude) ? o.claude : (findOnPath(o.claude) ?? o.claude)) : findOnPath('claude');
  if (!cli) {
    process.stderr.write('record: `claude` not found on PATH\n');
    process.exit(3);
  }

  const cwd = mkdtempSync(join(tmpdir(), 'oide-record-'));
  const sessionId = randomUUID();
  let user = '';
  try {
    user = userInfo().username;
  } catch {
    // no user name available
  }
  const s = createSanitizer({ home: homedir(), user, host: hostname(), cwd, tmp: tmpdir(), sessionId });
  const meta = { recordedAt: new Date().toISOString(), platform: process.platform, arch: process.arch, session: o.session };

  try {
    const ver = await runOnce(cli, ['--version']);
    const version = /(\d+\.\d+\.\d+)/.exec(ver.stdout)?.[1];
    writeFileSync(join(out, 'version.txt'), s.text(ver.stdout.trim()) + '\n');
    if (ver.code !== 0 || !version) {
      process.stderr.write(`record: \`claude --version\` failed (${ver.code}): ${s.text(ver.stderr).slice(0, 500)}\n`);
      process.exit(4);
    }
    meta.version = version;
    const help = await runOnce(cli, ['--help']);
    writeFileSync(join(out, 'help.txt'), s.text(help.stdout));
    meta.helpExitCode = help.code;

    if (o.session) {
      writeFileSync(join(cwd, 'notes.txt'), 'fixture notes for the oIDE compatibility recording\n');
      const r = await runSession(cli, { model: o.model, timeoutMs: o.timeout * 1000, cwd, sessionId });
      writeFileSync(join(out, 'session-basic.jsonl'), r.lines.map((l) => s.line(l)).join('\n') + (r.lines.length ? '\n' : ''));
      writeFileSync(join(out, 'session-stderr.txt'), s.text(r.stderr));
      meta.sessionExitCode = r.code;
      meta.sessionLines = r.lines.length;
      meta.model = o.model;
      meta.turns = SESSION_TURNS.length;
    }
    writeFileSync(join(out, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
    process.stdout.write(`record: CLI ${version} → ${out}${o.session ? ` (${meta.sessionLines} session lines)` : ''}\n`);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`record: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
