import { describe, expect, it, vi } from 'vitest';
import { defaultShell, TerminalService, type PtyLike, type PtySpawn } from './terminals';

function fakePty() {
  let onData: ((d: string) => void) | undefined;
  let onExit: ((e: { exitCode: number }) => void) | undefined;
  const pty: PtyLike & { emitData(d: string): void; emitExit(code: number): void; written: string[] } = {
    pid: 42,
    written: [],
    onData: (fn) => ((onData = fn), { dispose: () => (onData = undefined) }),
    onExit: (fn) => ((onExit = fn), { dispose: () => (onExit = undefined) }),
    write(d) {
      this.written.push(d);
    },
    resize: vi.fn(),
    kill: vi.fn(),
    emitData: (d) => onData?.(d),
    emitExit: (code) => onExit?.({ exitCode: code }),
  };
  return pty;
}

describe('TerminalService', () => {
  it('spawns the shell, coalesces output and reports exit', async () => {
    vi.useFakeTimers();
    try {
      const pty = fakePty();
      const spawn = vi.fn<PtySpawn>(() => pty);
      const emit = vi.fn(() => true);
      const svc = new TerminalService({ emit, spawn, platform: 'linux', baseEnv: () => ({ PATH: '/bin' }) });
      const { terminalId } = await svc.create({ cwd: '/work', command: 'claude', cols: 80, rows: 24 });

      const [file, args, opts] = spawn.mock.calls[0]!;
      expect(args).toEqual(['-l', '-c', 'claude']);
      expect(file).toBeTruthy();
      expect(opts).toMatchObject({ cwd: '/work', cols: 80, rows: 24, env: { PATH: '/bin' } });

      pty.emitData('a');
      pty.emitData('b');
      expect(emit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(10);
      expect(emit).toHaveBeenCalledWith('terminal.data', { terminalId, data: 'ab' });

      svc.write(terminalId, 'ls\r');
      expect(pty.written).toEqual(['ls\r']);
      svc.resize(terminalId, 1, 0);
      expect(pty.resize).toHaveBeenCalledWith(2, 1);

      pty.emitData('bye');
      pty.emitExit(0);
      expect(emit).toHaveBeenCalledWith('terminal.data', { terminalId, data: 'bye' });
      expect(emit).toHaveBeenLastCalledWith('terminal.exit', { terminalId, code: 0 });
      expect(svc.has(terminalId)).toBe(false);
      expect(() => svc.write(terminalId, 'x')).toThrow(/No terminal/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill and disposeAll kill every pty', async () => {
    const ptys = [fakePty(), fakePty()];
    let i = 0;
    const svc = new TerminalService({ emit: () => true, spawn: () => ptys[i++]!, platform: 'linux', baseEnv: () => ({}) });
    const a = await svc.create({ cwd: '/w' });
    await svc.create({ cwd: '/w' });
    svc.kill(a.terminalId);
    expect(ptys[0]!.kill).toHaveBeenCalled();
    svc.disposeAll();
    expect(ptys[1]!.kill).toHaveBeenCalled();
    expect(svc.list()).toEqual([]);
  });

  it('picks a platform shell', () => {
    // Absolute, never a bare name a repo folder could shadow (SEC-01).
    expect(defaultShell('win32').file).toMatch(/^[A-Za-z]:\\.*\\powershell\.exe$/i);
    expect(defaultShell('win32', 'claude').args).toContain('-Command');
    expect(defaultShell('linux', 'claude').args).toEqual(['-l', '-c', 'claude']);
  });
});
