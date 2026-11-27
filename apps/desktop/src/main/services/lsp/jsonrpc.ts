/**
 * JSON-RPC 2.0 over a byte stream with LSP's `Content-Length` framing (the base protocol of the
 * Language Server Protocol). Small on purpose: requests with ids and timeouts, notifications, and
 * requests from the server answered by one handler. Messages over `maxMessageBytes` close the
 * connection instead of growing a buffer without bound.
 */

export interface JsonRpcStreams {
  /** Bytes from the server (its stdout). */
  onData(listener: (chunk: Buffer) => void): void;
  /** Bytes to the server (its stdin). */
  write(data: Buffer): void;
}

export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

/** Standard codes. */
export const RPC = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InternalError: -32603,
  RequestCancelled: -32800,
  ContentModified: -32801,
} as const;

type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> | undefined; method: string };

export interface JsonRpcOptions {
  /** Default 32 MB. */
  maxMessageBytes?: number;
  /** Requests from the server (`workspace/configuration`, …). Throw a JsonRpcError to answer with an error. */
  onRequest?(method: string, params: unknown): unknown;
  onNotification?(method: string, params: unknown): void;
  /** The stream broke (bad framing, a message that is too large). */
  onProtocolError?(err: Error): void;
}

const HEADER_END = Buffer.from('\r\n\r\n');

export class JsonRpcConnection {
  private buf: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  private readonly max: number;

  constructor(
    private readonly streams: JsonRpcStreams,
    private readonly o: JsonRpcOptions = {},
  ) {
    this.max = o.maxMessageBytes ?? 32 * 1024 * 1024;
    streams.onData((chunk) => this.feed(chunk));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Send a request; rejects on an error answer, on timeout (`timeoutMs`, 0 = none) or when closed. */
  request<T = unknown>(method: string, params: unknown, timeoutMs = 0): Promise<T> {
    if (this.closed) return Promise.reject(new JsonRpcError(RPC.InternalError, 'The language server is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              // Tell the server too, so it stops working on it.
              this.notify('$/cancelRequest', { id });
              reject(new JsonRpcError(RPC.RequestCancelled, `${method} timed out`));
            }, timeoutMs)
          : undefined;
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: '2.0', method, params });
  }

  /** Reject every pending request and ignore further input. */
  close(reason = 'The language server stopped'): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new JsonRpcError(RPC.InternalError, reason));
    }
    this.pending.clear();
    this.buf = Buffer.alloc(0);
  }

  private send(msg: object): void {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    this.streams.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  private fail(err: Error): void {
    this.o.onProtocolError?.(err);
    this.close(err.message);
  }

  private feed(chunk: Buffer): void {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const end = this.buf.indexOf(HEADER_END);
      if (end < 0) {
        if (this.buf.length > 8192) this.fail(new Error('Language server sent a header without an end'));
        return;
      }
      const header = this.buf.subarray(0, end).toString('ascii');
      const m = /(?:^|\r\n)content-length:\s*(\d+)/i.exec(header);
      if (!m) return this.fail(new Error('Language server sent a message without Content-Length'));
      const len = Number(m[1]);
      if (!Number.isSafeInteger(len) || len > this.max) return this.fail(new Error(`Language server sent a message over ${Math.round(this.max / 1048576)} MB`));
      const start = end + HEADER_END.length;
      if (this.buf.length < start + len) return;
      const body = this.buf.subarray(start, start + len).toString('utf8');
      this.buf = this.buf.subarray(start + len);
      let msg: unknown;
      try {
        msg = JSON.parse(body);
      } catch {
        continue; // one bad message: skip it, keep the stream
      }
      this.dispatch(msg);
      if (this.closed) return;
    }
  }

  private dispatch(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
    if (typeof m.method === 'string') {
      if (m.id === undefined || m.id === null) {
        try {
          this.o.onNotification?.(m.method, m.params);
        } catch {
          /* a bad notification never breaks the stream */
        }
        return;
      }
      void this.answer(m.id, m.method, m.params);
      return;
    }
    if (typeof m.id !== 'number') return;
    const p = this.pending.get(m.id);
    if (!p) return; // late answer to a cancelled or timed-out request
    this.pending.delete(m.id);
    if (p.timer) clearTimeout(p.timer);
    if (m.error) p.reject(new JsonRpcError(typeof m.error.code === 'number' ? m.error.code : RPC.InternalError, String(m.error.message ?? 'Language server error'), m.error.data));
    else p.resolve(m.result ?? null);
  }

  private async answer(id: unknown, method: string, params: unknown): Promise<void> {
    if (typeof id !== 'number' && typeof id !== 'string') return;
    try {
      if (!this.o.onRequest) throw new JsonRpcError(RPC.MethodNotFound, `Unhandled method ${method}`);
      const result = await this.o.onRequest(method, params);
      if (!this.closed) this.send({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (err) {
      const e = err instanceof JsonRpcError ? err : new JsonRpcError(RPC.InternalError, (err as Error).message);
      if (!this.closed) this.send({ jsonrpc: '2.0', id, error: { code: e.code, message: e.message } });
    }
  }
}
