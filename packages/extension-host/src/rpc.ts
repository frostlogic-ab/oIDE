/**
 * Wire messages between the main process (HostClient) and one extension host process.
 * Plain structured-clone-able objects. Each host process runs exactly one extension, so main
 * knows which extension sent a request from the channel itself; a message cannot claim another
 * extension's identity.
 */

export interface HostInit {
  name: string;
  version: string;
  dir: string;
  main: string;
  activationEvent: string;
}

/** Methods the host process may call on main (the extension API, minus what runs locally). */
export type HostRequestMethod =
  | 'settings.get'
  | 'settings.set'
  | 'agents.list'
  | 'agents.postMessage'
  | 'agents.subscribe'
  | 'panels.open'
  | 'panels.postMessage'
  | 'artifacts.read';

export type MainToHost =
  | { t: 'init'; ext: HostInit }
  | { t: 'run'; reqId: number; commandId: string; args: unknown[] }
  | { t: 'event'; event: unknown }
  | { t: 'panel'; panelId: string; data: unknown }
  | { t: 'result'; reqId: number; ok: true; value: unknown }
  | { t: 'result'; reqId: number; ok: false; error: string }
  | { t: 'deactivate' };

export type HostToMain =
  | { t: 'activated'; commands: string[] }
  | { t: 'activationFailed'; error: string }
  | { t: 'commands'; commands: string[] }
  | { t: 'request'; reqId: number; method: HostRequestMethod; params: unknown[] }
  | { t: 'result'; reqId: number; ok: true; value: unknown }
  | { t: 'result'; reqId: number; ok: false; error: string }
  | { t: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string }
  | { t: 'deactivated' };
