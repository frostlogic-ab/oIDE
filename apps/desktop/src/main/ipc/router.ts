import type { z } from 'zod';
import { Commands, IPC_INVOKE_CHANNEL, type CommandName, type CommandOutput, type IpcResult } from '@oide/protocol';

/**
 * Generic IPC router over the single `IPC_INVOKE_CHANNEL`.
 *
 * Every request is `{ command, input }`. The router looks the command up in `Commands`
 * (packages/protocol/src/ipc.ts), Zod-parses the input, calls the registered handler and returns
 * an `IpcResult`. It never throws across IPC. Unknown or unregistered commands answer
 * `{ ok: false, error: { code: 'not_implemented' } }`, so the renderer can be built ahead of
 * the services that back it.
 */

export type ParsedInput<K extends CommandName> = z.output<(typeof Commands)[K]['input']>;

export interface InvokeMeta {
  /** webContents id of the sender. */
  senderId: number;
  /** URL of the frame that sent the request. */
  frameUrl: string;
}

export type Handler<K extends CommandName> = (
  input: ParsedInput<K>,
  meta: InvokeMeta,
) => CommandOutput<K> | Promise<CommandOutput<K>>;

export type IpcErrorCode =
  | 'bad_request'
  | 'not_implemented'
  | 'invalid_input'
  | 'invalid_output'
  | 'forbidden'
  | 'forbidden_path'
  | 'not_found'
  | 'conflict'
  | 'unavailable'
  | 'internal'
  | (string & {});

/** Throw from a handler to return a specific error code to the renderer. */
export class IpcError extends Error {
  constructor(
    message: string,
    readonly code: IpcErrorCode = 'internal',
    /** Machine-readable reason for observers (telemetry); never sent to the renderer. */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'IpcError';
  }
}

export interface Logger {
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

export interface RouterOptions {
  /** Validate handler output against the contract (default true). Catches drift early. */
  validateOutput?: boolean;
  log?: Logger;
  /**
   * Called after each successful command with the parsed input and the output (telemetry observes
   * commands here, main/telemetry/observers.ts). Must not throw; errors are swallowed.
   */
  observe?: (command: CommandName, input: unknown, output: unknown) => void;
  /**
   * Called after each failed command (invalid input or a handler error) with the error code and,
   * when the handler gave one, its `reason`, or the Zod issues for invalid input. Never the input.
   * Must not throw; errors are swallowed.
   */
  observeFailure?: (command: CommandName, failure: CommandFailure) => void;
}

/** What `observeFailure` sees: codes and issue paths only, never input values or messages. */
export interface CommandFailure {
  code: string;
  reason?: string;
  /** For invalid input: each issue's path and Zod code (`too_big`, `custom`, …). */
  issues?: Array<{ path: string; code: string }>;
}

const silentLog: Logger = { debug: () => {}, warn: () => {}, error: () => {} };

function fail(message: string, code: IpcErrorCode): IpcResult<never> {
  return { ok: false, error: { message, code } };
}

function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : '(input)'}: ${i.message}`)
    .join('; ');
}

function isCommandName(name: unknown): name is CommandName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(Commands, name);
}

export class IpcRouter {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly handlers = new Map<CommandName, Handler<any>>();
  private readonly validateOutput: boolean;
  private readonly log: Logger;
  private readonly observe: RouterOptions['observe'];
  private readonly observeFailure: RouterOptions['observeFailure'];

  constructor(opts: RouterOptions = {}) {
    this.validateOutput = opts.validateOutput ?? true;
    this.log = opts.log ?? silentLog;
    this.observe = opts.observe;
    this.observeFailure = opts.observeFailure;
  }

  private failed(command: CommandName, failure: CommandFailure): void {
    if (!this.observeFailure) return;
    try {
      this.observeFailure(command, failure);
    } catch (err) {
      this.log.debug(`[ipc] failure observer failed for ${command}`, (err as Error)?.message);
    }
  }

  private observed(command: CommandName, input: unknown, output: unknown): void {
    if (!this.observe) return;
    try {
      this.observe(command, input, output);
    } catch (err) {
      this.log.debug(`[ipc] observer failed for ${command}`, (err as Error)?.message);
    }
  }

  register<K extends CommandName>(name: K, handler: Handler<K>): void {
    if (!isCommandName(name)) throw new Error(`Unknown command "${String(name)}" (not in packages/protocol Commands)`);
    if (this.handlers.has(name)) throw new Error(`Command "${name}" already has a handler`);
    this.handlers.set(name, handler);
  }

  /** Replace an existing handler (tests, hot swapping a service). */
  override<K extends CommandName>(name: K, handler: Handler<K>): void {
    this.handlers.delete(name);
    this.register(name, handler);
  }

  has(name: CommandName): boolean {
    return this.handlers.has(name);
  }

  registered(): CommandName[] {
    return [...this.handlers.keys()];
  }

  async dispatch(request: unknown, meta: InvokeMeta): Promise<IpcResult<unknown>> {
    if (!request || typeof request !== 'object' || !('command' in request)) {
      return fail('Malformed IPC request', 'bad_request');
    }
    const { command, input } = request as { command: unknown; input?: unknown };
    if (!isCommandName(command)) {
      return fail(`Unknown command: ${String(command).slice(0, 80)}`, 'not_implemented');
    }
    const handler = this.handlers.get(command);
    if (!handler) return fail(`Command not implemented yet: ${command}`, 'not_implemented');

    const schema = Commands[command];
    const parsed = schema.input.safeParse(input);
    if (!parsed.success) {
      this.log.warn(`[ipc] invalid input for ${command}: ${summarizeIssues(parsed.error)}`);
      this.failed(command, { code: 'invalid_input', issues: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.map(String).join('.'), code: String(i.code) })) });
      return fail(`Invalid input for ${command}: ${summarizeIssues(parsed.error)}`, 'invalid_input');
    }

    let value: unknown;
    try {
      value = await handler(parsed.data, meta);
    } catch (err) {
      const code = typeof (err as { code?: unknown })?.code === 'string' ? (err as { code: string }).code : 'internal';
      const message = err instanceof Error ? err.message : String(err);
      if (code === 'internal') this.log.error(`[ipc] ${command} failed:`, err);
      else this.log.debug(`[ipc] ${command} → ${code}: ${message}`);
      const reason = (err as { reason?: unknown })?.reason;
      this.failed(command, { code, ...(typeof reason === 'string' ? { reason } : {}) });
      return fail(message, code);
    }

    if (this.validateOutput) {
      const out = schema.output.safeParse(value);
      if (!out.success) {
        this.log.error(`[ipc] ${command} returned output that does not match the contract: ${summarizeIssues(out.error)}`);
        return fail(`Handler for ${command} returned invalid output`, 'invalid_output');
      }
      this.observed(command, parsed.data, out.data);
      return { ok: true, value: out.data };
    }
    this.observed(command, parsed.data, value);
    return { ok: true, value };
  }
}

/** Minimal slice of `ipcMain` so the router can be attached in tests without Electron. */
export interface IpcMainLike {
  handle(channel: string, listener: (event: IpcInvokeEventLike, ...args: unknown[]) => unknown): void;
  removeHandler(channel: string): void;
}

export interface IpcInvokeEventLike {
  sender: { id: number };
  senderFrame?: { url: string } | null;
}

/**
 * Wires the router to `ipcMain.handle(IPC_INVOKE_CHANNEL)`. Requests from frames that fail
 * `isTrustedSender` (anything other than our own renderer) are refused.
 */
export function attachRouter(
  router: IpcRouter,
  ipcMain: IpcMainLike,
  isTrustedSender: (frameUrl: string) => boolean,
): () => void {
  ipcMain.handle(IPC_INVOKE_CHANNEL, async (event, request) => {
    const frameUrl = event.senderFrame?.url ?? '';
    if (!isTrustedSender(frameUrl)) return fail('Untrusted sender', 'forbidden');
    return router.dispatch(request, { senderId: event.sender.id, frameUrl });
  });
  return () => ipcMain.removeHandler(IPC_INVOKE_CHANNEL);
}
