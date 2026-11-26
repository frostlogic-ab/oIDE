import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { HOLDER_CATEGORIES } from '@oide/protocol';

/**
 * Which programs keep a folder from being deleted ("Docker Desktop (com.docker.backend.exe) still
 * has this folder open"). Runs only after a delete failed, or as a best-effort check after an agent
 * stopped; never on a timer.
 *
 * - Windows: a fixed PowerShell script (absolute `System32\WindowsPowerShell\v1.0\powershell.exe`,
 *   SEC-01) lists the system handle table (NtQuerySystemInformation), duplicates the file handles of
 *   the user's own processes and keeps those whose final path is the folder or inside it. A
 *   process's current directory is such a handle, so daemons started from the folder (Docker
 *   Desktop, WSL) are found too; Restart Manager only sees files, not folders. The folder reaches
 *   the script through an environment variable, never as script text. The script runs no cmdlet
 *   (the C# helper is compiled through CodeDom, not `Add-Type`), autoloading is off and
 *   PSModulePath holds only Windows' own modules, so no installed module is analysed or loaded.
 * - macOS and Linux: `lsof -a -u <uid> +d <dir>` (the folder itself and its direct entries: open
 *   files and current directories), best effort.
 * - Everything has a timeout (HOLDER_TIMEOUT_MS). Only the user's own processes are reported, by executable name
 *   and pid; never their paths or command lines. Any failure yields `{ holders: [] }` plus `error`,
 *   and callers fall back to the generic message.
 */

/** Telemetry's `worktree_delete_failed.holder` values. */
export type HolderCategory = (typeof HOLDER_CATEGORIES)[number];

export interface FolderHolder {
  /** Friendly name: `Docker Desktop`, `VS Code`, or the executable name when unknown. */
  label: string;
  category: HolderCategory;
  /** Executable names (no paths), e.g. `com.docker.backend.exe`. */
  exes: string[];
  pids: number[];
}

export interface HolderResult {
  /** False on platforms (or setups) where oIDE cannot look. */
  supported: boolean;
  holders: FolderHolder[];
  error?: string;
}

export interface RawHolder {
  pid: number;
  exe: string;
}

type Runner = (file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeoutMs: number; cwd: string }) => Promise<{ stdout: string; code: number | null }>;

export interface FindHoldersOptions {
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** Processes never reported (oIDE's own, whose watchers hold the folder until unwatched). */
  excludePids?: number[];
  /** Test seam. */
  run?: Runner;
  env?: NodeJS.ProcessEnv;
}

/**
 * Budget for one scan. On Windows the script's own handle scan stops after 8 s and prints what it
 * found; the rest is PowerShell start-up and compiling the helper (about 1 s). The script calls no
 * cmdlet and turns module autoloading off: `Add-Type` used to make PowerShell analyse every module
 * on PSModulePath before its own; with a cold cache and big modules (GitHub's Windows runners ship
 * AWSPowershell, Microsoft.Graph, SqlServer) that outlasted even 25 s, every time.
 */
export const HOLDER_TIMEOUT_MS = 25_000;

// ----------------------------------------------------------------------------- names

const NAMES: Array<[RegExp, string, HolderCategory]> = [
  [/^(com\.docker\..+|docker desktop|docker|dockerd|docker-sandbox|docker-compose|vpnkit.*|containerd.*)$/, 'Docker Desktop', 'docker'],
  [/^(wsl|wslhost|wslservice|wslrelay|vmmem.*)$/, 'WSL', 'docker'],
  [/^(code|code - insiders|code helper.*|electron helper.*)$/, 'VS Code', 'editor'],
  [/^(cursor|cursor helper.*)$/, 'Cursor', 'editor'],
  [/^(windsurf|windsurf helper.*)$/, 'Windsurf', 'editor'],
  [/^zed$/, 'Zed', 'editor'],
  [/^(idea|idea64|webstorm|webstorm64|rider|rider64|pycharm|pycharm64|goland|goland64|clion|clion64|phpstorm|phpstorm64|rubymine|rubymine64|fleet)$/, 'a JetBrains IDE', 'editor'],
  [/^devenv$/, 'Visual Studio', 'editor'],
  [/^(sublime_text|sublime text)$/, 'Sublime Text', 'editor'],
  [/^notepad\+\+$/, 'Notepad++', 'editor'],
  [/^(vim|nvim|emacs)$/, 'your editor', 'editor'],
  [/^explorer$/, 'File Explorer', 'unknown'],
  [/^finder$/, 'Finder', 'unknown'],
  [/^(windowsterminal|openconsole|conhost)$/, 'Windows Terminal', 'terminal'],
  [/^(powershell|pwsh)$/, 'PowerShell', 'terminal'],
  [/^cmd$/, 'Command Prompt', 'terminal'],
  [/^(bash|zsh|sh|fish|mintty|git-bash)$/, 'a shell', 'terminal'],
  [/^(terminal|iterm2|wezterm-gui|wezterm|alacritty|kitty|ghostty|warp|tmux)$/, 'a terminal', 'terminal'],
  [/^(ssh|git|git-remote-https)$/, 'git or ssh', 'terminal'],
  [/^node$/, 'Node.js', 'node'],
  [/^esbuild$/, 'esbuild', 'node'],
  [/^(bun|deno)$/, 'Bun or Deno', 'node'],
  [/^(npm|pnpm|yarn|npx)$/, 'a package manager', 'node'],
  [/^claude$/, 'the Claude Code CLI', 'node'],
  [/^(oide|electron)$/, 'oIDE', 'unknown'],
];

/** `com.docker.backend.exe` → Docker Desktop / docker. Unknown names keep the executable name. */
export function friendlyName(exe: string): { label: string; category: HolderCategory } {
  const key = exe
    .toLowerCase()
    .replace(/\.exe$/, '')
    .trim();
  for (const [re, label, category] of NAMES) if (re.test(key)) return { label, category };
  return { label: exe, category: 'unknown' };
}

/** Group raw (pid, exe) pairs by friendly name, in a stable order (docker first, unknown last). */
export function groupHolders(raw: readonly RawHolder[]): FolderHolder[] {
  const by = new Map<string, FolderHolder>();
  for (const r of raw) {
    const exe = basename(r.exe.replace(/\\/g, '/'));
    if (!exe) continue;
    const { label, category } = friendlyName(exe);
    let h = by.get(label);
    if (!h) by.set(label, (h = { label, category, exes: [], pids: [] }));
    if (!h.exes.some((e) => e.toLowerCase() === exe.toLowerCase())) h.exes.push(exe);
    if (!h.pids.includes(r.pid)) h.pids.push(r.pid);
  }
  const rank: Record<HolderCategory, number> = { docker: 0, editor: 1, node: 2, terminal: 3, unknown: 4 };
  return [...by.values()].sort((a, b) => rank[a.category] - rank[b.category] || a.label.localeCompare(b.label));
}

/** The category reported in telemetry: the most likely culprit among the holders. */
export function primaryCategory(holders: readonly FolderHolder[]): HolderCategory {
  return holders[0]?.category ?? 'unknown';
}

/** `Docker Desktop (com.docker.backend.exe, wsl.exe) and VS Code (Code.exe)`. */
export function describeHolders(holders: readonly FolderHolder[]): string {
  const parts = holders.slice(0, 4).map((h) => {
    const exes = h.exes.slice(0, 3).join(', ') + (h.exes.length > 3 ? ', …' : '');
    return h.label === h.exes[0] && h.exes.length === 1 ? h.label : `${h.label} (${exes})`;
  });
  if (holders.length > 4) parts.push(`${holders.length - 4} more`);
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// --------------------------------------------------------------------------- parsing

/** The Windows script's output: one `pid<TAB>exe` per line. */
export function parseWindowsOutput(text: string): RawHolder[] {
  const out: RawHolder[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{1,10})\t([^\t\\/]{1,260})$/.exec(line.trim());
    if (m) out.push({ pid: Number(m[1]), exe: m[2]! });
  }
  return out;
}

/** `lsof -F pc` output: `p<pid>` then `c<command>` lines. */
export function parseLsofOutput(text: string): RawHolder[] {
  const out: RawHolder[] = [];
  let pid: number | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1)) || undefined;
    else if (line.startsWith('c') && pid !== undefined) {
      const exe = line.slice(1).trim();
      if (exe && !out.some((o) => o.pid === pid)) out.push({ pid, exe });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------- windows

/**
 * The fixed script. It reads the folder from `$env:OIDE_HOLDER_DIR` and prints `pid<TAB>exe` for
 * every process of the current user with a file handle (including its current directory) on the
 * folder or inside it. Handle queries run on a worker thread that is abandoned after 8 s, so a
 * handle that blocks (some pipes do) cannot hang it.
 */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$src = @'
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text; using System.Threading; using System.IO;
public static class OideHolders {
  [StructLayout(LayoutKind.Sequential)] struct ENTRY { public IntPtr Object; public IntPtr Pid; public IntPtr Handle; public uint Access; public ushort Trace; public ushort Type; public uint Attrs; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential)] struct TOKEN_USER { public IntPtr Sid; public uint Attributes; }
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sp, IntPtr s, IntPtr dp, out IntPtr d, uint access, bool inherit, uint opts);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint GetFinalPathNameByHandle(IntPtr h, StringBuilder sb, uint n, uint flags);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr p, uint flags, StringBuilder sb, ref uint n);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr t);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr t, int cls, IntPtr buf, int len, out int ret);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

  static string Norm(string p) {
    if (p.StartsWith(@"\\?\UNC\")) p = @"\\" + p.Substring(8); else if (p.StartsWith(@"\\?\")) p = p.Substring(4);
    return p.TrimEnd('\\').ToLowerInvariant();
  }
  static string Owner(IntPtr proc) {
    IntPtr tok; if (!OpenProcessToken(proc, 8, out tok)) return null;
    try {
      int len; GetTokenInformation(tok, 1, IntPtr.Zero, 0, out len); if (len <= 0) return null;
      IntPtr buf = Marshal.AllocHGlobal(len);
      try {
        if (!GetTokenInformation(tok, 1, buf, len, out len)) return null;
        var tu = (TOKEN_USER)Marshal.PtrToStructure(buf, typeof(TOKEN_USER)); IntPtr s;
        if (!ConvertSidToStringSid(tu.Sid, out s)) return null;
        try { return Marshal.PtrToStringUni(s); } finally { LocalFree(s); }
      } finally { Marshal.FreeHGlobal(buf); }
    } finally { CloseHandle(tok); }
  }
  static string Exe(IntPtr proc) {
    var sb = new StringBuilder(1024); uint n = 1024;
    if (!QueryFullProcessImageName(proc, 0, sb, ref n)) return null;
    return Path.GetFileName(sb.ToString());
  }

  public static List<string> Find(string dir, string mySid, int myPid) {
    var hits = new List<string>(); string needle = Norm(dir);
    var t = new Thread(() => Scan(needle, mySid, myPid, hits)); t.IsBackground = true; t.Start(); t.Join(8000);
    lock (hits) return new List<string>(hits);
  }

  static void Scan(string needle, string mySid, int myPid, List<string> hits) {
    int len = 1 << 22; IntPtr buf; int ret;
    while (true) { buf = Marshal.AllocHGlobal(len); int st = NtQuerySystemInformation(64, buf, len, out ret); if (st == unchecked((int)0xC0000004)) { Marshal.FreeHGlobal(buf); len *= 2; if (len > (1 << 30)) return; continue; } if (st != 0) { Marshal.FreeHGlobal(buf); return; } break; }
    try {
      long count = Marshal.ReadIntPtr(buf).ToInt64(); int size = Marshal.SizeOf(typeof(ENTRY)); IntPtr first = buf + IntPtr.Size * 2;
      IntPtr me = GetCurrentProcess();
      // The object type index of a file handle: look up our own handle to a file we just opened.
      int fileType = -1;
      using (var fs = File.Open(Path.Combine(Environment.SystemDirectory, "kernel32.dll"), FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
        long h = fs.SafeFileHandle.DangerousGetHandle().ToInt64();
        int st2 = NtQuerySystemInformation(64, buf, len, out ret);
        if (st2 == 0) {
          count = Marshal.ReadIntPtr(buf).ToInt64();
          for (long i = 0; i < count; i++) { var e = (ENTRY)Marshal.PtrToStructure(first + (int)(i * size), typeof(ENTRY)); if ((int)e.Pid.ToInt64() == myPid && e.Handle.ToInt64() == h) { fileType = e.Type; break; } }
        }
      }
      var procs = new Dictionary<int, IntPtr>(); var exes = new Dictionary<int, string>(); var seen = new HashSet<int>();
      for (long i = 0; i < count; i++) {
        var e = (ENTRY)Marshal.PtrToStructure(first + (int)(i * size), typeof(ENTRY)); int pid = (int)e.Pid.ToInt64();
        if (pid == myPid || pid <= 4 || seen.Contains(pid)) continue;
        if (fileType >= 0 && e.Type != fileType) continue;
        if (e.Access == 0x0012019f || e.Access == 0x001a019f || e.Access == 0x00120189 || e.Access == 0x00100000) continue;
        IntPtr hp;
        if (!procs.TryGetValue(pid, out hp)) {
          hp = OpenProcess(0x1000 | 0x40, false, pid);
          if (hp != IntPtr.Zero && Owner(hp) != mySid) { CloseHandle(hp); hp = IntPtr.Zero; }
          procs[pid] = hp;
          if (hp != IntPtr.Zero) exes[pid] = Exe(hp);
        }
        if (hp == IntPtr.Zero) continue;
        IntPtr d; if (!DuplicateHandle(hp, e.Handle, me, out d, 0, false, 2)) continue;
        try {
          if (GetFileType(d) != 1) continue;
          var sb = new StringBuilder(1024); uint n = GetFinalPathNameByHandle(d, sb, 1024, 0);
          if (n == 0 || n >= 1024) continue;
          string p = Norm(sb.ToString());
          if (p == needle || p.StartsWith(needle + "\\")) { seen.Add(pid); lock (hits) hits.Add(pid + "\t" + (exes[pid] ?? "unknown")); }
        } finally { CloseHandle(d); }
      }
      foreach (var h in procs.Values) if (h != IntPtr.Zero) CloseHandle(h);
    } finally { Marshal.FreeHGlobal(buf); }
  }
}
'@
$dir = $env:OIDE_HOLDER_DIR
if (-not $dir) { exit 2 }
$cp = [System.CodeDom.Compiler.CompilerParameters]::new()
$cp.GenerateInMemory = $true
[void]$cp.ReferencedAssemblies.Add('System.dll')
[void]$cp.ReferencedAssemblies.Add('System.Core.dll')
$built = [Microsoft.CSharp.CSharpCodeProvider]::new().CompileAssemblyFromSource($cp, $src)
if ($built.Errors.HasErrors) { exit 3 }
$holders = $built.CompiledAssembly.GetType('OideHolders')
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($line in $holders::Find($dir, $sid, $PID)) { [Console]::Out.WriteLine($line) }
`;

/** `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, never a bare name (SEC-01). */
export function windowsPowerShell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** The few variables PowerShell needs; nothing else of oIDE's environment reaches it. */
function windowsEnv(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? 'C:\\Windows';
  const keep = ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'ProgramData', 'ProgramFiles', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS'];
  const out: NodeJS.ProcessEnv = {};
  for (const k of keep) if (env[k] !== undefined) out[k] = env[k];
  out.SystemRoot ??= root;
  out.PATH = `${join(root, 'System32')};${root};${join(root, 'System32', 'WindowsPowerShell', 'v1.0')}`;
  // Only Windows' own modules: no user or machine-wide module can load into the scan, or make it slow.
  out.PSModulePath = join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  out.OIDE_HOLDER_DIR = dir;
  return out;
}

const defaultRun: Runner = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: opts.env, cwd: opts.cwd, timeout: opts.timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      const e = err as { code?: unknown; killed?: boolean } | null;
      if (e && (typeof e.code !== 'number' || e.killed)) return reject(e.killed ? new Error('timed out') : (err as Error));
      resolve({ stdout: String(stdout ?? ''), code: e && typeof e.code === 'number' ? e.code : 0 });
    });
  });

function lsofBinary(): string | undefined {
  return ['/usr/sbin/lsof', '/usr/bin/lsof', '/bin/lsof', '/sbin/lsof'].find((p) => existsSync(p));
}

/** Programs (of this user) that hold `dir` or something inside it open. Never throws. */
export async function findFolderHolders(dir: string, opts: FindHoldersOptions = {}): Promise<HolderResult> {
  const platform = opts.platform ?? process.platform;
  const timeoutMs = opts.timeoutMs ?? HOLDER_TIMEOUT_MS;
  const run = opts.run ?? defaultRun;
  const env = opts.env ?? process.env;
  const exclude = new Set([...(opts.excludePids ?? [])]);
  let real = dir;
  try {
    real = realpathSync.native(dir);
  } catch {}
  try {
    if (platform === 'win32') {
      const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
      const r = await run(windowsPowerShell(env), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { env: windowsEnv(env, real), timeoutMs, cwd: env.SystemRoot ?? tmpdir() });
      if (r.code !== 0) return { supported: true, holders: [], error: `holder scan exited with ${r.code}` };
      return { supported: true, holders: groupHolders(parseWindowsOutput(r.stdout).filter((h) => !exclude.has(h.pid))) };
    }
    if (platform === 'darwin' || platform === 'linux') {
      const lsof = lsofBinary();
      if (!lsof) return { supported: false, holders: [], error: 'lsof not found' };
      const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
      const args = ['-w', '-n', '-P', ...(uid !== undefined ? ['-a', '-u', String(uid)] : []), '+d', real, '-F', 'pc'];
      const r = await run(lsof, args, { env: { PATH: '/usr/sbin:/usr/bin:/bin:/sbin', LANG: 'C' }, timeoutMs, cwd: tmpdir() });
      // lsof exits 1 when nothing has the folder open.
      if (r.code !== 0 && r.code !== 1) return { supported: true, holders: [], error: `lsof exited with ${r.code}` };
      return { supported: true, holders: groupHolders(parseLsofOutput(r.stdout).filter((h) => !exclude.has(h.pid))) };
    }
    return { supported: false, holders: [] };
  } catch (err) {
    return { supported: true, holders: [], error: (err as Error).message };
  }
}
