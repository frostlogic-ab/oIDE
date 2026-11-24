import type { CommandInput, CommandName, CommandOutput, EventName, EventPayload, OideBridge } from '@oide/protocol';

declare global {
  interface Window {
    /** Exposed by src/preload/index.ts. Absent in a plain browser (dev:web), where the mock is used. */
    oide?: OideBridge;
  }
}

/**
 * The only way React code talks to main:
 *
 *   import { oide } from '../lib/bridge';
 *   const agents = await oide.invoke('agents.list', undefined);
 *   const off = oide.on('agents.summary', (s) => …);
 *
 * `oide` forwards to `window.oide` (preload). Only in dev builds, and only when `window.oide` is
 * missing (renderer opened in a plain browser), it forwards to the in-memory mock bridge from
 * ./mock, installed by main.tsx before first render. Production builds never contain the mock.
 */

let fallback: OideBridge | null = null;

/** Called by main.tsx in dev when there is no preload bridge. */
export function installFallbackBridge(bridge: OideBridge): void {
  fallback = bridge;
}

export function isMockBridge(): boolean {
  return typeof window !== 'undefined' && !window.oide && fallback !== null;
}

const unavailable: OideBridge = {
  invoke: async (command) => {
    throw new Error(`[unavailable] No bridge to main for ${String(command)}`);
  },
  on: () => () => {},
  platform: typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? 'darwin' : 'unknown',
};

function current(): OideBridge {
  if (typeof window !== 'undefined' && window.oide) return window.oide;
  return fallback ?? unavailable;
}

export const oide: OideBridge = {
  invoke<K extends CommandName>(command: K, input: CommandInput<K>): Promise<CommandOutput<K>> {
    return current().invoke(command, input);
  },
  on<K extends EventName>(event: K, listener: (payload: EventPayload<K>) => void): () => void {
    return current().on(event, listener);
  },
  get platform() {
    return current().platform;
  },
};

/** Error code from a rejected `oide.invoke` ("not_implemented", "invalid_input", …). */
export function ipcErrorCode(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return /^\[([a-z_]+)\]/.exec(message)?.[1];
}

/** Message without the "[code] " prefix. */
export function ipcErrorMessage(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.replace(/^\[[a-z_]+\]\s*/, '');
}

export function isNotImplemented(err: unknown): boolean {
  const code = ipcErrorCode(err);
  return code === 'not_implemented' || code === 'unavailable';
}

/**
 * Invoke and return `fallback` when main has no handler yet (wave-1 shell). Other errors throw.
 */
export async function invokeOr<K extends CommandName, F = CommandOutput<K>>(
  command: K,
  input: CommandInput<K>,
  fallbackValue: F,
): Promise<CommandOutput<K> | F> {
  try {
    return await oide.invoke(command, input);
  } catch (err) {
    if (isNotImplemented(err)) return fallbackValue;
    throw err;
  }
}

export const isMac = (): boolean => oide.platform === 'darwin';
