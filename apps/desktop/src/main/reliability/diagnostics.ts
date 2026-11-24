import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { arch, platform, release } from 'node:os';
import { findExecutable } from '@oide/git';
import { TESTED_CLI_RANGE, type CliInfo, type DiagnosticCheck, type Diagnostics } from '@oide/protocol';
import { Redactor } from './redact.js';

/**
 * Startup diagnostics (Settings › Diagnostics). Every value is redacted (home → `~`, userData →
 * `<userData>`, no tokens), so the copyable report can go into a bug report as is. Tools are
 * resolved to absolute paths from PATH (never the cwd, SEC-01) and only asked for `--version`.
 */

/** `git merge-tree --write-tree` (overlap detection, local merge preview) needs git 2.38. */
export const MIN_GIT = [2, 38, 0] as const;

export function parseVersion(s: string | undefined): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(s ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function versionAtLeast(v: readonly number[], min: readonly number[]): boolean {
  for (let i = 0; i < Math.max(v.length, min.length); i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

export type RunVersion = (tool: string) => Promise<{ path: string; output: string } | null>;

/** `<tool> --version` from an absolute PATH entry, 5 s timeout; null when not installed. */
export const runVersion: RunVersion = async (tool) => {
  const path = findExecutable(tool);
  if (!path) return null;
  const output = await new Promise<string>((resolve) => {
    execFile(path, ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve(err && !stdout ? '' : `${stdout}${stderr}`.trim());
    });
  });
  return { path, output };
};

export interface DiagnosticsDeps {
  appVersion: string;
  userDataDir: string;
  logsDir: string;
  dbFile: string;
  cli(): Promise<CliInfo>;
  mcpPort(): number | undefined;
  keychainAvailable(): boolean | undefined;
  crashReportsEnabled(): boolean;
  fileLoggingOk(): boolean;
  redactor: Redactor;
  /** Redacts only the home folder (default `new Redactor()`). */
  homeRedactor?: Redactor;
  runVersion?: RunVersion;
  now?: () => number;
}

function fileSize(p: string): number {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export async function collectDiagnostics(d: DiagnosticsDeps): Promise<Diagnostics> {
  const r = (s: string) => d.redactor.string(s);
  const run = d.runVersion ?? runVersion;
  const checks: DiagnosticCheck[] = [];
  const add = (c: DiagnosticCheck) => checks.push(c.detail === undefined ? { ...c, value: r(c.value) } : { ...c, value: r(c.value), detail: r(c.detail) });

  add({
    id: 'app',
    label: 'oIDE',
    status: 'info',
    value: `${d.appVersion} · Electron ${process.versions.electron ?? 'n/a'} · Node ${process.versions.node}`,
    detail: `${platform()} ${release()} ${arch()}`,
  });

  const [cli, git, gh, node] = await Promise.all([d.cli().catch(() => null), run('git').catch(() => null), run('gh').catch(() => null), run('node').catch(() => null)]);

  if (!cli?.found) add({ id: 'cli', label: 'Claude Code CLI', status: 'error', value: 'Not found', detail: 'Install the Claude Code CLI or set its path in Settings › Claude Code.' });
  else
    add({
      id: 'cli',
      label: 'Claude Code CLI',
      status: cli.inTestedRange ? 'ok' : 'warn',
      value: `${cli.version ?? 'unknown version'}${cli.path ? ` · ${cli.path}` : ''}`,
      detail: cli.inTestedRange ? `In the tested range ${TESTED_CLI_RANGE.min} – ${TESTED_CLI_RANGE.max}.` : `Outside the tested range ${TESTED_CLI_RANGE.min} – ${TESTED_CLI_RANGE.max}; some controls may not work.`,
    });

  const gv = parseVersion(git?.output);
  if (!git) add({ id: 'git', label: 'git', status: 'error', value: 'Not found', detail: 'oIDE needs git on PATH for projects and worktrees.' });
  else
    add({
      id: 'git',
      label: 'git',
      status: gv && versionAtLeast(gv, MIN_GIT) ? 'ok' : 'error',
      value: `${gv ? gv.join('.') : git.output || 'unknown version'} · ${git.path}`,
      detail: gv && versionAtLeast(gv, MIN_GIT) ? 'merge-tree --write-tree available (2.38 or newer).' : `git ${MIN_GIT.join('.')} or newer is needed for overlap checks and merge previews (merge-tree --write-tree).`,
    });

  add(
    gh
      ? { id: 'gh', label: 'GitHub CLI (gh)', status: 'ok', value: `${parseVersion(gh.output)?.join('.') ?? 'found'} · ${gh.path}` }
      : { id: 'gh', label: 'GitHub CLI (gh)', status: 'warn', value: 'Not found', detail: 'Optional. Opening pull requests from Review needs gh.' },
  );
  add(
    node
      ? { id: 'node', label: 'Node.js', status: 'ok', value: `${parseVersion(node.output)?.join('.') ?? 'found'} · ${node.path}` }
      : { id: 'node', label: 'Node.js', status: 'warn', value: 'Not found', detail: 'Built-in extension MCP servers that run on Node need it on PATH.' },
  );

  const kc = d.keychainAvailable();
  add(
    kc === false
      ? { id: 'keychain', label: 'Secure storage (OS keychain)', status: 'warn', value: 'Not available', detail: 'API keys and extension secrets cannot be saved until it is.' }
      : { id: 'keychain', label: 'Secure storage (OS keychain)', status: kc ? 'ok' : 'info', value: kc ? 'Available' : 'Unknown' },
  );

  const dbSize = fileSize(d.dbFile) + fileSize(`${d.dbFile}-wal`);
  add({ id: 'db', label: 'Database', status: 'info', value: `${d.dbFile} · ${formatBytes(dbSize)}` });

  const port = d.mcpPort();
  add(port ? { id: 'mcp', label: 'oIDE MCP server', status: 'ok', value: `127.0.0.1:${port}` } : { id: 'mcp', label: 'oIDE MCP server', status: 'error', value: 'Not listening', detail: 'Permission prompts and oIDE tools are unavailable to agents.' });

  add({ id: 'logs', label: 'Logs', status: d.fileLoggingOk() ? 'ok' : 'warn', value: d.logsDir, ...(d.fileLoggingOk() ? {} : { detail: 'Writing log files failed (disk full?); retrying.' }) });
  add({ id: 'crash', label: 'Crash reports', status: 'info', value: d.crashReportsEnabled() ? 'On (saved on this computer only, never uploaded)' : 'Off' });
  // Home-only redaction here, so the row shows where app data lives (`~/…`), not `<userData>`.
  checks.push({ id: 'userData', label: 'App data', status: 'info', value: (d.homeRedactor ?? new Redactor()).string(d.userDataDir) });

  const generatedAt = new Date((d.now ?? Date.now)()).toISOString();
  return { generatedAt, checks, report: formatReport(generatedAt, checks) };
}

const MARK: Record<DiagnosticCheck['status'], string> = { ok: 'ok  ', warn: 'warn', error: 'FAIL', info: '    ' };

export function formatReport(generatedAt: string, checks: DiagnosticCheck[]): string {
  const lines = [`oIDE diagnostics · ${generatedAt}`, ''];
  for (const c of checks) {
    lines.push(`[${MARK[c.status]}] ${c.label}: ${c.value}`);
    if (c.detail) lines.push(`       ${c.detail}`);
  }
  return lines.join('\n');
}
