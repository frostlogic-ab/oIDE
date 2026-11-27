import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcConnection, JsonRpcError, RPC, type JsonRpcOptions } from './jsonrpc.js';

/** An in-memory pipe: `push` plays the server's stdout, `sent` collects what the client wrote. */
function pipe(o: JsonRpcOptions = {}) {
  let listener: ((chunk: Buffer) => void) | undefined;
  const written: Buffer[] = [];
  const conn = new JsonRpcConnection({ onData: (l) => void (listener = l), write: (d) => void written.push(d) }, o);
  const push = (b: Buffer | string) => listener!(typeof b === 'string' ? Buffer.from(b, 'utf8') : b);
  /** Every message the client wrote, parsed (checks the framing too). */
  const sent = () => {
    const out: Array<Record<string, unknown>> = [];
    let buf = Buffer.concat(written);
    while (buf.length) {
      const end = buf.indexOf('\r\n\r\n');
      const len = Number(/Content-Length: (\d+)/.exec(buf.subarray(0, end).toString('ascii'))![1]);
      out.push(JSON.parse(buf.subarray(end + 4, end + 4 + len).toString('utf8')) as Record<string, unknown>);
      buf = buf.subarray(end + 4 + len);
    }
    return out;
  };
  return { conn, push, sent };
}

const frame = (msg: object) => {
  const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('JsonRpcConnection', () => {
  it('frames requests with a byte Content-Length and resolves the matching answer', async () => {
    const { conn, push, sent } = pipe();
    const p = conn.request('textDocument/hover', { text: 'héllo' });
    const [req] = sent();
    expect(req).toEqual({ jsonrpc: '2.0', id: 1, method: 'textDocument/hover', params: { text: 'héllo' } });
    push(frame({ id: 1, result: { contents: 'ok' } }));
    await expect(p).resolves.toEqual({ contents: 'ok' });
    // A null / missing result resolves to null; ids increase.
    const q = conn.request('shutdown', null);
    expect(sent()[1]!.id).toBe(2);
    push(frame({ id: 2 }));
    await expect(q).resolves.toBeNull();
  });

  it('reassembles a message split across chunks, even inside the header and a multi-byte character', async () => {
    const { conn, push } = pipe();
    const p = conn.request('x', null);
    const bytes = frame({ id: 1, result: 'ünïcödé ✓' });
    for (let i = 0; i < bytes.length; i += 3) push(bytes.subarray(i, i + 3));
    await expect(p).resolves.toBe('ünïcödé ✓');
  });

  it('handles several messages in one chunk, and a lowercase header with extra fields', async () => {
    const notes: Array<[string, unknown]> = [];
    const { conn, push } = pipe({ onNotification: (m, p) => void notes.push([m, p]) });
    const a = conn.request('a', null);
    const b = conn.request('b', null);
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, result: 'B' }));
    const odd = Buffer.concat([Buffer.from(`content-type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${body.length}\r\n\r\n`), body]);
    push(Buffer.concat([frame({ method: 'window/logMessage', params: { message: 'hi' } }), frame({ id: 1, result: 'A' }), odd]));
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
    expect(notes).toEqual([['window/logMessage', { message: 'hi' }]]);
  });

  it('rejects with a JsonRpcError on an error answer', async () => {
    const { conn, push } = pipe();
    const p = conn.request('textDocument/definition', {});
    push(frame({ id: 1, error: { code: RPC.ContentModified, message: 'modified', data: { x: 1 } } }));
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonRpcError);
    expect(err).toMatchObject({ code: RPC.ContentModified, message: 'modified', data: { x: 1 } });
  });

  it('skips a body that is not JSON and keeps reading the stream', async () => {
    const { conn, push } = pipe();
    const p = conn.request('x', null);
    push(Buffer.concat([Buffer.from('Content-Length: 5\r\n\r\n{nope'), frame({ id: 1, result: 7 })]));
    await expect(p).resolves.toBe(7);
    expect(conn.isClosed).toBe(false);
  });

  it('on timeout rejects with RequestCancelled, sends $/cancelRequest and ignores the late answer', async () => {
    vi.useFakeTimers();
    const { conn, push, sent } = pipe();
    const p = conn.request('textDocument/completion', {}, 500);
    const caught = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(499);
    expect(sent()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await caught).toMatchObject({ code: RPC.RequestCancelled, message: 'textDocument/completion timed out' });
    expect(sent()[1]).toEqual({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 1 } });
    push(frame({ id: 1, result: 'late' })); // no throw, no effect
    expect(conn.isClosed).toBe(false);
  });

  it('answers server requests through onRequest (sync or async), with MethodNotFound and errors', async () => {
    const { push, sent } = pipe({
      onRequest: async (method, params) => {
        if (method === 'workspace/configuration') return [(params as { items: unknown[] }).items.length];
        if (method === 'boom') throw new Error('kaput');
        if (method === 'typed') throw new JsonRpcError(RPC.InvalidRequest, 'bad');
        throw new JsonRpcError(RPC.MethodNotFound, `no ${method}`);
      },
    });
    push(frame({ id: 'a', method: 'workspace/configuration', params: { items: [{}, {}] } }));
    push(frame({ id: 7, method: 'nope', params: null }));
    push(frame({ id: 8, method: 'boom' }));
    push(frame({ id: 9, method: 'typed' }));
    await vi.waitFor(() => expect(sent()).toHaveLength(4));
    const byId = Object.fromEntries(sent().map((m) => [String(m.id), m]));
    expect(byId.a).toEqual({ jsonrpc: '2.0', id: 'a', result: [2] });
    expect(byId['7']).toMatchObject({ error: { code: RPC.MethodNotFound, message: 'no nope' } });
    expect(byId['8']).toMatchObject({ error: { code: RPC.InternalError, message: 'kaput' } });
    expect(byId['9']).toMatchObject({ error: { code: RPC.InvalidRequest, message: 'bad' } });
  });

  it('answers MethodNotFound when there is no onRequest handler', async () => {
    const { push, sent } = pipe();
    push(frame({ id: 3, method: 'window/showMessageRequest', params: {} }));
    await vi.waitFor(() => expect(sent()).toHaveLength(1));
    expect(sent()[0]).toMatchObject({ id: 3, error: { code: RPC.MethodNotFound } });
  });

  it('a throwing notification handler does not break the stream', async () => {
    const { conn, push } = pipe({
      onNotification: () => {
        throw new Error('bad handler');
      },
    });
    const p = conn.request('x', null);
    push(Buffer.concat([frame({ method: 'n' }), frame({ id: 1, result: 1 })]));
    await expect(p).resolves.toBe(1);
  });

  it('closes on a message over maxMessageBytes and rejects pending requests', async () => {
    const errors: string[] = [];
    const { conn, push } = pipe({ maxMessageBytes: 100, onProtocolError: (e) => void errors.push(e.message) });
    const p = conn.request('x', null);
    push('Content-Length: 101\r\n\r\n');
    await expect(p).rejects.toMatchObject({ code: RPC.InternalError });
    expect(conn.isClosed).toBe(true);
    expect(errors).toHaveLength(1);
    await expect(conn.request('y', null)).rejects.toThrow(/not running/);
  });

  it('closes on a header without Content-Length, and on a header that never ends', () => {
    const a = pipe();
    a.push('Content-Type: x\r\n\r\n{}');
    expect(a.conn.isClosed).toBe(true);
    const b = pipe();
    b.push('X'.repeat(9000));
    expect(b.conn.isClosed).toBe(true);
  });

  it('close() rejects every pending request, stops sending and ignores further input', async () => {
    const { conn, push, sent } = pipe();
    const a = conn.request('a', null, 10_000);
    const b = conn.request('b', null);
    conn.close('bye');
    await expect(a).rejects.toMatchObject({ message: 'bye' });
    await expect(b).rejects.toMatchObject({ message: 'bye' });
    conn.notify('n', null);
    expect(sent()).toHaveLength(2);
    push(frame({ id: 1, result: 1 })); // ignored
    conn.close(); // idempotent
  });
});
