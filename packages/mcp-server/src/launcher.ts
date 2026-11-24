/**
 * The stdio launcher for custom MCP servers whose env or args carry secrets (review-security
 * SEC-11). The agent's mcp.json lists `node <launcher> <launch-url> <nonce>` instead of the real
 * command; the launcher fetches the real command, args and env (secrets resolved) once from the oIDE
 * MCP server over loopback (agent secret + one-time nonce), then runs it with stdio inherited. So
 * the secret values exist only in that server's own process, never in the `claude` process env that
 * the Bash tool and every other MCP server inherit, and never on disk.
 *
 * Plain CommonJS with no dependencies, written to `<app-data>/bin/` at server start.
 */

/** Env var holding the agent's own oIDE MCP secret (also expanded into its mcp.json header). */
export const AGENT_SECRET_ENV = 'OIDE_MCP_HANDSHAKE';

export const LAUNCHER_FILE = 'oide-mcp-launch.cjs';

export const LAUNCHER_SOURCE = `'use strict';
// oIDE stdio MCP launcher (generated; see packages/mcp-server/src/launcher.ts).
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [launchUrl, nonce] = process.argv.slice(2);
const SECRET_ENV = ${JSON.stringify(AGENT_SECRET_ENV)};
const fail = (m) => { process.stderr.write('oide-mcp-launch: ' + m + '\\n'); process.exit(1); };
if (!launchUrl || !nonce) fail('usage: oide-mcp-launch <url> <nonce>');

const META = /([()\\][%!^"\`<>&|;, *?])/g;
function escArg(a) {
  a = String(a).replace(/(?=(\\\\+?)?)\\1"/g, '$1$1\\\\"').replace(/(?=(\\\\+?)?)\\1$/, '$1$1');
  return ('"' + a + '"').replace(META, '^$1').replace(META, '^$1');
}
function isAbsWin(p) { return /^[A-Za-z]:[\\\\/]/.test(p) || /^[\\\\/]{2}[^\\\\/]/.test(p); }
function resolveCommand(cmd, env) {
  if (process.platform !== 'win32') return cmd;
  if (/[\\\\/]/.test(cmd)) return cmd;
  const dirs = (env.PATH || env.Path || '').split(';').map((d) => d.trim().replace(/^"|"$/g, '')).filter(isAbsWin);
  const exts = path.extname(cmd) ? [''] : ['.exe', '.com', '.cmd', '.bat'];
  for (const d of dirs) for (const e of exts) {
    const c = path.join(d, cmd + e);
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return cmd;
}

const u = new URL(launchUrl);
const req = http.request(
  { host: u.hostname, port: u.port, path: u.pathname, method: 'POST', headers: { 'x-oide-secret': process.env[SECRET_ENV] || '', 'x-oide-launch': nonce, 'content-length': '0' } },
  (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (d) => (body += d));
    res.on('end', () => {
      if (res.statusCode !== 200) fail('oIDE refused to launch this server (HTTP ' + res.statusCode + ')');
      let spec;
      try { spec = JSON.parse(body); } catch { fail('bad launch spec'); }
      const env = Object.assign({}, process.env, spec.env || {});
      delete env[SECRET_ENV];
      const file = resolveCommand(spec.command, env);
      const args = spec.args || [];
      let child;
      if (process.platform === 'win32' && /\\.(cmd|bat)$/i.test(file)) {
        const line = [file.replace(META, '^$1')].concat(args.map(escArg)).join(' ');
        child = spawn(env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', '"' + line + '"'], { stdio: 'inherit', env, windowsHide: true, windowsVerbatimArguments: true });
      } else {
        child = spawn(file, args, { stdio: 'inherit', env, windowsHide: true });
      }
      child.on('error', (e) => fail(e.message));
      child.on('exit', (code) => process.exit(code === null ? 1 : code));
      for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));
    });
  },
);
req.on('error', (e) => fail(e.message));
req.end();
`;

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** Names of `${VAR}` placeholders in a string. */
export function placeholders(s: string): string[] {
  return [...s.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

/** Replace `${VAR}` / `${VAR:-default}` from `vars` (unknown names keep their default or become empty). */
export function expandPlaceholders(s: string, vars: Record<string, string>): string {
  return s.replace(PLACEHOLDER, (_m, name: string, def: string | undefined) => vars[name] ?? def ?? '');
}
