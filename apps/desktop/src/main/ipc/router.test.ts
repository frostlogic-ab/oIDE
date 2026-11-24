import { describe, expect, it, vi } from 'vitest';
import { IPC_INVOKE_CHANNEL } from '@oide/protocol';
import { attachRouter, IpcError, IpcRouter, type IpcMainLike } from './router';
import { createAgentEventBatcher, createEmitter, FrameBatcher } from './emit';

const meta = { senderId: 1, frameUrl: 'file:///app/index.html' };

describe('IpcRouter', () => {
  it('returns not_implemented for unknown and unregistered commands', async () => {
    const r = new IpcRouter();
    expect(await r.dispatch({ command: 'nope.nothing', input: {} }, meta)).toEqual({
      ok: false,
      error: { message: expect.stringContaining('Unknown command'), code: 'not_implemented' },
    });
    expect(await r.dispatch({ command: 'git.worktrees', input: { projectId: 'p' } }, meta)).toMatchObject({
      ok: false,
      error: { code: 'not_implemented' },
    });
  });

  it('rejects malformed envelopes', async () => {
    const r = new IpcRouter();
    expect(await r.dispatch(null, meta)).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await r.dispatch('app.info', meta)).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('Zod-validates input before calling the handler', async () => {
    const r = new IpcRouter();
    const handler = vi.fn(() => ({ ok: true as const }));
    r.register('terminal.write', handler);
    const res = await r.dispatch({ command: 'terminal.write', input: { terminalId: '', data: 1 } }, meta);
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('passes parsed input (with defaults) and returns the value', async () => {
    const r = new IpcRouter();
    const handler = vi.fn((input: { cwd: string; cols: number; rows: number }) => ({ terminalId: `${input.cols}x${input.rows}` }));
    r.register('terminal.create', handler);
    const res = await r.dispatch({ command: 'terminal.create', input: { cwd: '/tmp' } }, meta);
    expect(res).toEqual({ ok: true, value: { terminalId: '100x30' } });
    expect(handler).toHaveBeenCalledWith({ cwd: '/tmp', cols: 100, rows: 30 }, meta);
  });

  it('accepts void input as undefined or null', async () => {
    const r = new IpcRouter();
    r.register('app.info', () => ({ version: '1.0.0', platform: 'linux', userData: '/u' }));
    expect(await r.dispatch({ command: 'app.info', input: undefined }, meta)).toMatchObject({ ok: true });
    expect(await r.dispatch({ command: 'app.info' }, meta)).toMatchObject({ ok: true });
    expect(await r.dispatch({ command: 'app.info', input: null }, meta)).toMatchObject({ ok: true });
  });

  it('maps thrown errors to codes and never throws', async () => {
    const r = new IpcRouter();
    r.register('terminal.kill', () => {
      throw new IpcError('gone', 'not_found');
    });
    r.register('terminal.resize', () => {
      throw new Error('boom');
    });
    r.register('shell.revealPath', () => {
      throw Object.assign(new Error('outside'), { code: 'forbidden_path' });
    });
    expect(await r.dispatch({ command: 'terminal.kill', input: { terminalId: 't' } }, meta)).toEqual({ ok: false, error: { message: 'gone', code: 'not_found' } });
    expect(await r.dispatch({ command: 'terminal.resize', input: { terminalId: 't', cols: 1, rows: 1 } }, meta)).toEqual({
      ok: false,
      error: { message: 'boom', code: 'internal' },
    });
    expect(await r.dispatch({ command: 'shell.revealPath', input: { path: '/x' } }, meta)).toMatchObject({ ok: false, error: { code: 'forbidden_path' } });
  });

  it('validates handler output against the contract', async () => {
    const r = new IpcRouter();
    r.register('app.info', () => ({ version: 1 }) as never);
    expect(await r.dispatch({ command: 'app.info', input: undefined }, meta)).toMatchObject({ ok: false, error: { code: 'invalid_output' } });
    const lax = new IpcRouter({ validateOutput: false });
    lax.register('app.info', () => ({ version: 1 }) as never);
    expect(await lax.dispatch({ command: 'app.info', input: undefined }, meta)).toEqual({ ok: true, value: { version: 1 } });
  });

  it('refuses double registration and commands outside the contract', () => {
    const r = new IpcRouter();
    r.register('app.info', () => ({ version: '1', platform: 'x', userData: 'y' }));
    expect(() => r.register('app.info', () => ({ version: '1', platform: 'x', userData: 'y' }))).toThrow(/already/);
    expect(() => r.register('made.up' as never, (() => null) as never)).toThrow(/Unknown command/);
    expect(r.registered()).toEqual(['app.info']);
  });

  it('attachRouter refuses untrusted senders', async () => {
    const r = new IpcRouter();
    r.register('app.info', () => ({ version: '1', platform: 'x', userData: 'y' }));
    let listener: ((e: { sender: { id: number }; senderFrame?: { url: string } }, ...a: unknown[]) => unknown) | undefined;
    const ipc: IpcMainLike = {
      handle: (channel, fn) => {
        expect(channel).toBe(IPC_INVOKE_CHANNEL);
        listener = fn;
      },
      removeHandler: vi.fn(),
    };
    attachRouter(r, ipc, (url) => url.startsWith('file:///app/'));
    expect(await listener!({ sender: { id: 1 }, senderFrame: { url: 'https://evil.example' } }, { command: 'app.info' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await listener!({ sender: { id: 1 }, senderFrame: { url: 'file:///app/index.html' } }, { command: 'app.info' })).toMatchObject({ ok: true });
  });
});

describe('emit', () => {
  const target = () => ({ sent: [] as unknown[], isDestroyed: () => false, send(_c: string, m: unknown) { this.sent.push(m); } });

  it('validates payloads and drops invalid ones', () => {
    const t = target();
    const log = { debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const emit = createEmitter(() => [t], log);
    expect(emit('notify', { level: 'info', message: 'hi' })).toBe(true);
    expect(emit('notify', { level: 'loud', message: 'hi' } as never)).toBe(false);
    expect(emit('nope' as never, {} as never)).toBe(false);
    expect(t.sent).toEqual([{ event: 'notify', payload: { level: 'info', message: 'hi' } }]);
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it('batches agent events per frame into one agents.batch', () => {
    vi.useFakeTimers();
    try {
      const t = target();
      const batcher = createAgentEventBatcher(createEmitter(() => [t]), 16);
      for (let i = 0; i < 5; i++) batcher.push({ type: 'stderr', agentId: 'a', seq: i, ts: 0, text: `l${i}` });
      expect(t.sent).toHaveLength(0);
      vi.advanceTimersByTime(16);
      expect(t.sent).toHaveLength(1);
      expect((t.sent[0] as { event: string; payload: { events: unknown[] } }).payload.events).toHaveLength(5);
      vi.advanceTimersByTime(100);
      expect(t.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FrameBatcher flushes early at maxItems', () => {
    const flushed: number[][] = [];
    const b = new FrameBatcher<number>((items) => flushed.push(items), 16, 3);
    [1, 2, 3, 4].forEach((n) => b.push(n));
    expect(flushed).toEqual([[1, 2, 3]]);
    b.dispose();
    expect(flushed).toEqual([[1, 2, 3], [4]]);
  });
});
