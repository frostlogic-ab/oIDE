import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { CustomServer } from '@oide/protocol';

/**
 * Add custom › Found on this computer. Reads other apps' MCP settings read-only. Security rule:
 * only the MCP servers key of each file is kept; everything else is dropped as soon as the file
 * is parsed and is never logged or returned (Claude Code's user config holds account details
 * next to its MCP servers). Parse errors are reported without any file content.
 */

export type ImportedConfig =
  | { kind: 'stdio'; command: string; args: string[]; env: Record<string, string> }
  | { kind: 'http'; url: string; transport: 'http' | 'sse'; headers: Record<string, string> };

/** What the scan returns to the renderer: no env or header values, only their names. */
export type PublicImportedConfig =
  | { kind: 'stdio'; command: string; args: string[]; envKeys: string[] }
  | { kind: 'http'; url: string; transport: 'http' | 'sse'; headerKeys: string[] };

export interface ImportCandidate {
  /** "Claude Desktop", "Claude Code · your settings", "billing-api/.mcp.json", "Cursor", … */
  source: string;
  file: string;
  name: string;
  alreadyAdded: boolean;
  kind: 'stdio' | 'http';
  /** One line for the list: the command line or URL. */
  display: string;
  config: PublicImportedConfig;
}

export interface ScanFile {
  source: string;
  file: string;
  /** Which key holds the servers. `claude-code` also reads `projects.<path>.mcpServers`. */
  format: 'mcpServers' | 'servers' | 'claude-code';
}

export interface ScanOptions {
  home?: string;
  platform?: NodeJS.Platform;
  /** `%APPDATA%` on Windows. */
  appData?: string;
  /** Open projects; each one's `.mcp.json` (and `.vscode/mcp.json`, `.cursor/mcp.json`) is read. */
  projects?: Array<{ name: string; root: string }>;
  /** Servers already added, to mark duplicates. */
  existing?: CustomServer[];
  /** Replace the default file list (tests). */
  files?: ScanFile[];
}

/** The known config files for this OS. */
export function knownConfigFiles(o: ScanOptions = {}): ScanFile[] {
  const home = o.home ?? os.homedir();
  const platform = o.platform ?? process.platform;
  const appData = o.appData ?? process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
  const desktopDir =
    platform === 'win32' ? path.join(appData, 'Claude') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Claude') : path.join(home, '.config', 'Claude');
  const codeUser =
    platform === 'win32' ? path.join(appData, 'Code', 'User') : platform === 'darwin' ? path.join(home, 'Library', 'Application Support', 'Code', 'User') : path.join(home, '.config', 'Code', 'User');
  const files: ScanFile[] = [
    { source: 'Claude Desktop', file: path.join(desktopDir, 'claude_desktop_config.json'), format: 'mcpServers' },
    { source: 'Claude Code · your settings', file: path.join(home, '.claude.json'), format: 'claude-code' },
    { source: 'VS Code', file: path.join(codeUser, 'mcp.json'), format: 'servers' },
    { source: 'Cursor', file: path.join(home, '.cursor', 'mcp.json'), format: 'mcpServers' },
    { source: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), format: 'mcpServers' },
  ];
  for (const p of o.projects ?? []) {
    files.push({ source: `${p.name}/.mcp.json`, file: path.join(p.root, '.mcp.json'), format: 'mcpServers' });
    files.push({ source: `${p.name}/.vscode/mcp.json`, file: path.join(p.root, '.vscode', 'mcp.json'), format: 'servers' });
    files.push({ source: `${p.name}/.cursor/mcp.json`, file: path.join(p.root, '.cursor', 'mcp.json'), format: 'mcpServers' });
  }
  return files;
}

/** Remove // and /* comments and trailing commas (VS Code's JSONC), leaving strings intact. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i] as string;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
    } else if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const strRecord = (v: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x;
  return out;
};

/** Normalize one server entry from any of the known formats. Unknown shapes return null. */
export function normalizeEntry(v: unknown): ImportedConfig | null {
  if (!isObj(v)) return null;
  const type = typeof v['type'] === 'string' ? (v['type'] as string) : undefined;
  const url = typeof v['url'] === 'string' ? (v['url'] as string) : typeof v['serverUrl'] === 'string' ? (v['serverUrl'] as string) : undefined;
  if (url && type !== 'stdio') {
    try {
      const u = new URL(url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    } catch {
      return null;
    }
    return { kind: 'http', url, transport: type === 'sse' ? 'sse' : 'http', headers: strRecord(v['headers']) };
  }
  if (typeof v['command'] === 'string' && v['command']) {
    const args = Array.isArray(v['args']) ? (v['args'] as unknown[]).filter((a): a is string => typeof a === 'string') : [];
    return { kind: 'stdio', command: v['command'] as string, args, env: strRecord(v['env']) };
  }
  return null;
}

/**
 * Pull only the MCP servers out of a config file's text. The parsed document is not kept;
 * errors carry no file content (V8's JSON errors quote the input).
 */
export function extractServers(text: string, format: ScanFile['format']): Array<{ name: string; scope?: string; config: ImportedConfig }> {
  let doc: unknown;
  try {
    doc = JSON.parse(format === 'servers' ? stripJsonc(text) : text);
  } catch {
    throw new Error('not valid JSON');
  }
  const pick = (v: unknown): Array<[string, unknown]> => (isObj(v) ? Object.entries(v) : []);
  const found: Array<{ name: string; scope?: string; raw: unknown }> = [];
  if (isObj(doc)) {
    if (format === 'servers') {
      for (const [name, raw] of pick(doc['servers'])) found.push({ name, raw });
      // Older VS Code settings nest them under "mcp".
      if (isObj(doc['mcp'])) for (const [name, raw] of pick((doc['mcp'] as Record<string, unknown>)['servers'])) found.push({ name, raw });
    } else {
      for (const [name, raw] of pick(doc['mcpServers'])) found.push({ name, raw });
      if (format === 'claude-code' && isObj(doc['projects'])) {
        for (const [projectPath, p] of Object.entries(doc['projects'] as Record<string, unknown>)) {
          if (!isObj(p)) continue;
          for (const [name, raw] of pick(p['mcpServers'])) found.push({ name, scope: projectPath, raw });
        }
      }
    }
  }
  doc = undefined; // drop everything else in the file
  const out: Array<{ name: string; scope?: string; config: ImportedConfig }> = [];
  for (const f of found) {
    const config = normalizeEntry(f.raw);
    if (!config) continue;
    const item: { name: string; scope?: string; config: ImportedConfig } = { name: f.name, config };
    if (f.scope) item.scope = f.scope;
    out.push(item);
  }
  return out;
}

export function displayOf(c: ImportedConfig | PublicImportedConfig): string {
  return c.kind === 'http' ? c.url : [c.command, ...c.args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

export function toPublic(c: ImportedConfig): PublicImportedConfig {
  return c.kind === 'http'
    ? { kind: 'http', url: c.url, transport: c.transport, headerKeys: Object.keys(c.headers) }
    : { kind: 'stdio', command: c.command, args: c.args, envKeys: Object.keys(c.env) };
}

function isAlreadyAdded(name: string, c: ImportedConfig, existing: CustomServer[]): boolean {
  return existing.some((s) => {
    const t = s.transport;
    if (t.kind === 'http' && c.kind === 'http') return t.url === c.url;
    if (t.kind === 'stdio' && c.kind === 'stdio') return s.name === name || (t.command === c.command && t.args.join(' ') === c.args.join(' '));
    return false;
  });
}

/** Scan for importable servers, keeping full configs (with secret values) in main only. */
export async function scanImportsFull(o: ScanOptions = {}): Promise<Array<ImportCandidate & { full: ImportedConfig }>> {
  const files = o.files ?? knownConfigFiles(o);
  const existing = o.existing ?? [];
  const out: Array<ImportCandidate & { full: ImportedConfig }> = [];
  const seen = new Set<string>();
  for (const f of files) {
    let text: string;
    try {
      text = await readFile(f.file, { encoding: 'utf8', flag: 'r' });
    } catch {
      continue; // not installed
    }
    let servers;
    try {
      servers = extractServers(text, f.format);
    } catch {
      continue; // unreadable file: skipped without logging its content
    } finally {
      text = '';
    }
    for (const s of servers) {
      const source = s.scope ? `Claude Code · ${path.basename(s.scope)}` : f.source;
      const key = `${f.file}\0${s.scope ?? ''}\0${s.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ source, file: f.file, name: s.name, alreadyAdded: isAlreadyAdded(s.name, s.config, existing), kind: s.config.kind, display: displayOf(s.config), config: toPublic(s.config), full: s.config });
    }
  }
  return out;
}

/** The renderer-safe scan result (no env or header values). */
export async function scanImports(o: ScanOptions = {}): Promise<ImportCandidate[]> {
  return (await scanImportsFull(o)).map(({ full: _full, ...rest }) => rest);
}
