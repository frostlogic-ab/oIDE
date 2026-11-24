import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AgentEvent, type AgentEventDraft, type AgentSpec, type PermissionMode, type UserMessage } from '@oide/protocol';
import type { LaunchPlan } from './args.js';
import { resolveSpawn } from './cli.js';
import { toStreamJson, type ArtifactResolver, type StreamJsonUserMessage } from './messages.js';
import { parseLine, type RawControlRequest, type RawControlResponse } from './parser.js';

/** The driver interface from the build brief. All CLI knowledge lives behind it. */
export interface AgentDriver {
  start(spec: AgentSpec, options?: DriverStartOptions): Promise<AgentHandle>;
}

export interface AgentHandle {
  id: string;
  sessionId: string;
  events: AsyncIterable<AgentEvent>;
  send(msg: UserMessage): void;
  interrupt(): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>;
  dispose(): Promise<void>;
  /** Extras beyond the brief's interface. */
  readonly pid: number | undefined;
  readonly alive: boolean;
  readonly exited: Promise<ExitInfo>;
  /** Last stderr lines (never contains env values; the CLI's own output only). */
  stderrTail(): string[];
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export interface DriverStartOptions {
  agentId: string;
  sessionId: string;
  cwd: string;
  launch: LaunchPlan;
  /** Shared per-agent sequence so supervisor-made events interleave monotonically. */
  nextSeq?: () => number;
  resolveArtifact?: ArtifactResolver;
  /** Every stdout line as received, for raw storage (including lines that yield no events). */
  onRawLine?: (line: string) => void;
  log?: (message: string, detail?: unknown) => void;
  /** How long to wait for a control_response before falling back. */
  controlTimeoutMs?: number;
  /** Grace period after closing stdin before killing the process tree. */
  disposeGraceMs?: number;
  platform?: NodeJS.Platform;
}

export class ControlError extends Error {
  override name = 'ControlError';
}

const rawByEvent = new WeakMap<AgentEvent, string>();
/** The raw stdout JSON line an event was parsed from (set on the first event of each line). */
export function rawJsonOf(e: AgentEvent): string | undefined {
  return rawByEvent.get(e);
}

/** Single-consumer async queue. */
class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;
  push(item: T): void {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }
  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Kill a process and its children. Windows: `taskkill /T /F`; POSIX: the process group. */
export function killTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  if (platform === 'win32') {
    try {
      const tk = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      tk.on('error', () => child.kill());
    } catch {
      child.kill();
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
  }, 2000).unref();
}

class CliAgentHandle implements AgentHandle {
  readonly id: string;
  sessionId: string;
  readonly events: EventQueue<AgentEvent> = new EventQueue();
  readonly exited: Promise<ExitInfo>;
  private resolveExit!: (e: ExitInfo) => void;
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private stdoutBuf = '';
  private stderrBuf = '';
  private readonly stderrLines: string[] = [];
  private isAlive = true;
  private ownSeq = 0;

  constructor(
    private readonly opts: DriverStartOptions,
    private readonly platform: NodeJS.Platform,
  ) {
    this.id = opts.agentId;
    this.sessionId = opts.sessionId;
    this.exited = new Promise((r) => (this.resolveExit = r));
    const target = resolveSpawn(opts.launch.command, opts.launch.args, platform);
    this.child = spawn(target.file, target.args, {
      cwd: opts.cwd,
      env: opts.launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: platform !== 'win32',
      ...(target.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    this.child.stdout!.setEncoding('utf8');
    this.child.stderr!.setEncoding('utf8');
    this.child.stdout!.on('data', (d: string) => this.onStdout(d));
    this.child.stderr!.on('data', (d: string) => this.onStderr(d));
    this.child.stdin!.on('error', (err) => opts.log?.('agent stdin error', err.message));
    this.child.on('error', (err) => {
      this.emit({ type: 'error', message: `Could not start the Claude Code CLI: ${err.message}`, code: 'spawn' });
      this.finish({ code: null, signal: null });
    });
    this.child.on('close', (code, signal) => {
      if (this.stdoutBuf.trim()) this.onLine(this.stdoutBuf);
      this.stdoutBuf = '';
      if (this.stderrBuf.trim()) this.pushStderr(this.stderrBuf);
      this.finish({ code, signal: signal ?? null });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }
  get alive(): boolean {
    return this.isAlive;
  }
  stderrTail(): string[] {
    return [...this.stderrLines];
  }

  private nextSeq(): number {
    return this.opts.nextSeq ? this.opts.nextSeq() : this.ownSeq++;
  }

  private emit(draft: AgentEventDraft, raw?: string): void {
    const candidate = { ...draft, agentId: this.id, seq: this.nextSeq(), ts: Date.now() };
    const parsed = AgentEvent.safeParse(candidate);
    if (!parsed.success) {
      this.opts.log?.('dropping invalid normalized event', parsed.error.message);
      return;
    }
    if (raw !== undefined) rawByEvent.set(parsed.data, raw);
    if (parsed.data.type === 'init' && parsed.data.sessionId) this.sessionId = parsed.data.sessionId;
    this.events.push(parsed.data);
  }

  private finish(info: ExitInfo): void {
    if (!this.isAlive) return;
    this.isAlive = false;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new ControlError('Agent process exited'));
      this.pending.delete(id);
    }
    this.emit({ type: 'exit', code: info.code, signal: info.signal });
    this.events.end();
    this.resolveExit(info);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let i: number;
    while ((i = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, i);
      this.stdoutBuf = this.stdoutBuf.slice(i + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.opts.onRawLine?.(trimmed);
    const parsed = parseLine(trimmed, this.opts.log);
    if (parsed.control) this.onControlResponse(parsed.control);
    if (parsed.controlRequest) this.onControlRequest(parsed.controlRequest);
    parsed.events.forEach((d, idx) => this.emit(d, idx === 0 ? trimmed : undefined));
  }

  private onStderr(chunk: string): void {
    this.stderrBuf += chunk;
    let i: number;
    while ((i = this.stderrBuf.indexOf('\n')) >= 0) {
      const line = this.stderrBuf.slice(0, i);
      this.stderrBuf = this.stderrBuf.slice(i + 1);
      this.pushStderr(line);
    }
  }

  private pushStderr(line: string): void {
    const text = line.replace(/\r$/, '').slice(0, 4000);
    if (!text.trim()) return;
    this.stderrLines.push(text);
    if (this.stderrLines.length > 50) this.stderrLines.shift();
    this.emit({ type: 'stderr', text });
  }

  private onControlResponse(c: RawControlResponse): void {
    const p = this.pending.get(c.response.request_id);
    if (!p) return;
    this.pending.delete(c.response.request_id);
    clearTimeout(p.timer);
    if (c.response.subtype === 'success') p.resolve(c.response.response);
    else p.reject(new ControlError(c.response.error ?? `control request failed (${c.response.subtype})`));
  }

  /** The CLI asking us something (e.g. can_use_tool without a prompt tool). oIDE answers through MCP instead. */
  private onControlRequest(r: RawControlRequest): void {
    this.opts.log?.(`unsupported control request from CLI: ${r.request.subtype}`);
    this.write({ type: 'control_response', response: { subtype: 'error', request_id: r.request_id, error: `oIDE does not handle ${r.request.subtype} over stdio` } });
  }

  private write(obj: unknown): boolean {
    const stdin = this.child.stdin;
    if (!this.isAlive || !stdin || stdin.destroyed || stdin.writableEnded) return false;
    stdin.write(`${JSON.stringify(obj)}\n`);
    return true;
  }

  sendRaw(msg: StreamJsonUserMessage): void {
    if (!this.write(msg)) this.emit({ type: 'error', message: 'The agent process is not running; message not delivered', code: 'protocol' });
  }

  send(msg: UserMessage): void {
    this.sendRaw(toStreamJson(msg, this.opts.resolveArtifact));
  }

  /** Send a control request (`interrupt`, `set_permission_mode`) and await its control_response. */
  control(subtype: string, extra: Record<string, unknown> = {}, timeoutMs = this.opts.controlTimeoutMs ?? 5000): Promise<unknown> {
    const request_id = `oide-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(new ControlError(`control request ${subtype} timed out`));
      }, timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      if (!this.write({ type: 'control_request', request_id, request: { subtype, ...extra } })) {
        clearTimeout(timer);
        this.pending.delete(request_id);
        reject(new ControlError('Agent process is not running'));
      }
    });
  }

  async interrupt(): Promise<void> {
    if (!this.isAlive) return;
    try {
      await this.control('interrupt');
    } catch (err) {
      this.opts.log?.('interrupt control request failed; sending SIGINT', (err as Error).message);
      if (this.isAlive) this.child.kill('SIGINT');
    }
  }

  async setMode(mode: PermissionMode): Promise<void> {
    await this.control('set_permission_mode', { mode });
  }

  async dispose(): Promise<void> {
    if (!this.isAlive) return;
    try {
      this.child.stdin?.end();
    } catch {
      /* already closed */
    }
    const grace = this.opts.disposeGraceMs ?? 3000;
    const timedOut = await Promise.race([this.exited.then(() => false), new Promise<boolean>((r) => setTimeout(() => r(true), grace).unref())]);
    if (timedOut && this.isAlive) {
      killTree(this.child, this.platform);
      await Promise.race([this.exited, new Promise((r) => setTimeout(r, 5000).unref())]);
    }
  }
}

/** The v1 driver: the user's own `claude` binary in stream-json mode. */
export class ClaudeCliDriver implements AgentDriver {
  constructor(private readonly defaults: { platform?: NodeJS.Platform; log?: (m: string, d?: unknown) => void } = {}) {}

  async start(_spec: AgentSpec, options?: DriverStartOptions): Promise<AgentHandle> {
    if (!options) throw new Error('ClaudeCliDriver.start needs DriverStartOptions (build them with buildLaunch)');
    const opts = { ...options, ...(options.log || !this.defaults.log ? {} : { log: this.defaults.log }) };
    const handle = new CliAgentHandle(opts, options.platform ?? this.defaults.platform ?? process.platform);
    if (options.launch.firstMessage) handle.sendRaw(options.launch.firstMessage);
    return handle;
  }
}
