import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeHolders, findFolderHolders, friendlyName, groupHolders, parseLsofOutput, parseWindowsOutput, primaryCategory, windowsPowerShell } from './folder-holders.js';
import { removeSync } from './fs-safe.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeSync(d);
});

describe('folder holders: names and messages', () => {
  it('maps executables to friendly names and categories', () => {
    expect(friendlyName('com.docker.backend.exe')).toEqual({ label: 'Docker Desktop', category: 'docker' });
    expect(friendlyName('docker-sandbox.exe')).toEqual({ label: 'Docker Desktop', category: 'docker' });
    expect(friendlyName('wslhost.exe').category).toBe('docker');
    expect(friendlyName('Code.exe')).toEqual({ label: 'VS Code', category: 'editor' });
    expect(friendlyName('Code Helper (Renderer)').label).toBe('VS Code');
    expect(friendlyName('explorer.exe').label).toBe('File Explorer');
    expect(friendlyName('node.exe')).toEqual({ label: 'Node.js', category: 'node' });
    expect(friendlyName('esbuild.exe').category).toBe('node');
    expect(friendlyName('pwsh.exe')).toEqual({ label: 'PowerShell', category: 'terminal' });
    expect(friendlyName('mystery-tool.exe')).toEqual({ label: 'mystery-tool.exe', category: 'unknown' });
  });

  it('groups holders and builds the sentence (docker first, no paths)', () => {
    const holders = groupHolders([
      { pid: 10, exe: 'com.docker.backend.exe' },
      { pid: 11, exe: 'com.docker.build.exe' },
      { pid: 12, exe: 'docker-sandbox.exe' },
      { pid: 13, exe: 'wsl.exe' },
      { pid: 14, exe: 'Code.exe' },
      { pid: 15, exe: 'C:\\Tools\\weird.exe' },
    ]);
    expect(holders.map((h) => h.label)).toEqual(['Docker Desktop', 'WSL', 'VS Code', 'weird.exe']);
    expect(primaryCategory(holders)).toBe('docker');
    expect(describeHolders(holders)).toBe('Docker Desktop (com.docker.backend.exe, com.docker.build.exe, docker-sandbox.exe), WSL (wsl.exe), VS Code (Code.exe) and weird.exe');
    expect(describeHolders(groupHolders([{ pid: 1, exe: 'com.docker.backend.exe' }]))).toBe('Docker Desktop (com.docker.backend.exe)');
    expect(primaryCategory([])).toBe('unknown');
  });

  it('parses the Windows script and lsof output, ignoring anything else', () => {
    expect(parseWindowsOutput('123\tnode.exe\r\nnoise\r\n45\tC:\\x\\y.exe\r\n9\tCode.exe\n')).toEqual([
      { pid: 123, exe: 'node.exe' },
      { pid: 9, exe: 'Code.exe' },
    ]);
    expect(parseLsofOutput('p100\ncnode\nfcwd\np200\ncCode Helper\n')).toEqual([
      { pid: 100, exe: 'node' },
      { pid: 200, exe: 'Code Helper' },
    ]);
  });

  it('passes the folder in the environment, never in the script, and runs PowerShell by absolute path', async () => {
    const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
    const r = await findFolderHolders("C:\\wt\\it's $(evil)", {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\evil', OIDE_SECRET: 'x' },
      excludePids: [7],
      run: async (file, args, o) => {
        calls.push({ file, args, env: o.env });
        return { stdout: '7\tnode.exe\n8\tcom.docker.backend.exe\n', code: 0 };
      },
    });
    expect(r.holders.map((h) => h.label)).toEqual(['Docker Desktop']);
    expect(calls[0]!.file).toBe(windowsPowerShell({ SystemRoot: 'C:\\Windows' }));
    expect(calls[0]!.env.OIDE_HOLDER_DIR).toBe("C:\\wt\\it's $(evil)");
    expect(calls[0]!.env.OIDE_SECRET).toBeUndefined();
    expect(calls[0]!.env.PATH).not.toContain('evil');
    const script = Buffer.from(calls[0]!.args[calls[0]!.args.length - 1]!, 'base64').toString('utf16le');
    expect(script).not.toContain('evil');
    expect(script).toContain('$env:OIDE_HOLDER_DIR');
    // No cmdlet, no module autoloading, only Windows' own modules: an installed module (AWS,
    // Graph, SqlServer on CI runners) must never be analysed or loaded on the way to the scan.
    expect(script).not.toMatch(/Add-Type|New-Object/i);
    expect(script).toContain("$PSModuleAutoLoadingPreference = 'None'");
    expect(calls[0]!.env.PSModulePath).toBe(join('C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'));
  });

  it('falls back to no holders when the scan fails or times out', async () => {
    const r = await findFolderHolders('C:\\wt', { platform: 'win32', run: async () => Promise.reject(new Error('timed out')) });
    expect(r).toEqual({ supported: true, holders: [], error: 'timed out' });
    expect((await findFolderHolders('/x', { platform: 'aix' as NodeJS.Platform })).supported).toBe(false);
  });
});

describe.skipIf(process.platform !== 'win32')('folder holders on Windows (integration)', () => {
  it('names a process whose current directory is inside the folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oide holders ü-'));
    dirs.push(root);
    const inner = join(root, 'node_modules', 'pkg');
    mkdirSync(inner, { recursive: true });
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: inner, stdio: 'ignore', windowsHide: true });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const r = await findFolderHolders(root, { excludePids: [process.pid] });
      expect(r.error).toBeUndefined();
      const node = r.holders.find((h) => h.category === 'node');
      expect(node?.label).toBe('Node.js');
      expect(node?.pids).toContain(child.pid);
    } finally {
      child.kill();
      await new Promise((r) => child.once('exit', r));
    }
    const after = await findFolderHolders(root, { excludePids: [process.pid] });
    expect(after.holders.some((h) => h.pids.includes(child.pid!))).toBe(false);
  }, 60_000);
});
