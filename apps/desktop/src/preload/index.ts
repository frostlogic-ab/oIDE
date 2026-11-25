import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
import {
  Commands,
  Events,
  IPC_DROP_CHANNEL,
  IPC_EVENT_CHANNEL,
  IPC_INVOKE_CHANNEL,
  PickedAttachments,
  type IpcResult,
  type OideBridge,
} from '@oide/protocol';

/**
 * Exposes exactly `window.oide` (OideBridge from packages/protocol/src/ipc.ts) and nothing else.
 * Only the contract channels are used; `ipcRenderer` itself never reaches the page. The third,
 * `IPC_DROP_CHANNEL`, carries only paths read here from real dropped `File` objects (`attachDropped`).
 *
 * Errors from main reject with `Error("[code] message")` because contextBridge only carries an
 * Error's message across the isolation boundary. Use `ipcErrorCode(err)` from
 * src/renderer/src/lib/bridge.ts to read the code.
 */

type Listener = (payload: unknown) => void;
const listeners = new Map<string, Set<Listener>>();

ipcRenderer.on(IPC_EVENT_CHANNEL, (_event: IpcRendererEvent, message: unknown) => {
  if (!message || typeof message !== 'object') return;
  const { event, payload } = message as { event?: unknown; payload?: unknown };
  if (typeof event !== 'string') return;
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(`[oide] listener for ${event} threw`, err);
    }
  }
});

const bridge: OideBridge = {
  async invoke(command, input) {
    if (!Object.prototype.hasOwnProperty.call(Commands, command)) {
      throw new Error(`[not_implemented] Unknown command: ${String(command)}`);
    }
    const result = (await ipcRenderer.invoke(IPC_INVOKE_CHANNEL, { command, input })) as IpcResult<never>;
    if (result && result.ok) return result.value;
    const error = result && !result.ok ? result.error : { message: 'No response from main', code: 'internal' };
    throw new Error(`[${error.code ?? 'internal'}] ${error.message}`);
  },
  on(event, listener) {
    if (!Object.prototype.hasOwnProperty.call(Events, event)) {
      throw new Error(`Unknown event: ${String(event)}`);
    }
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    const fn = listener as Listener;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  },
  platform: process.platform,
  /**
   * Paths only for real `File` objects from a drop or paste: `webUtils.getPathForFile` returns '' for a
   * File the page built itself, and anything that is not a File is skipped. Main registers the paths as
   * picked and reads them (images inline, other files by path).
   */
  async attachDropped(files) {
    const paths: string[] = [];
    for (const f of Array.from(files ?? []).slice(0, 50)) {
      if (!(f instanceof File)) continue;
      try {
        const path = webUtils.getPathForFile(f);
        if (path) paths.push(path);
      } catch {
        /* not a file on disk */
      }
    }
    if (!paths.length) return { attachments: [], rejected: [] };
    return PickedAttachments.parse(await ipcRenderer.invoke(IPC_DROP_CHANNEL, paths));
  },
};

contextBridge.exposeInMainWorld('oide', bridge);
