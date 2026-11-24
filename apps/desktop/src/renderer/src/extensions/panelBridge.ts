/**
 * The renderer half of the panel bridge. Extension panels run in `<iframe sandbox="allow-scripts">`
 * served from `oide-ext://` (an opaque origin with no `window.oide`). Their only channel is
 * `postMessage`:
 *
 * - frame → app: a `message` event is accepted only when its `source` is the window of a frame this
 *   module registered. App messages (`type: "oide:…"`) go to that frame's own handler (artifact
 *   viewers load and save their artifact this way); anything else is forwarded, rate-limited and
 *   size-checked, as `extensions.panelMessage` for that frame's extension and panel only. Main
 *   checks both again before the host code sees it.
 * - host → frame: `extensions.panelMessage` events are posted into every loaded frame of that
 *   extension and panel. Messages that arrive before a frame loaded wait in a short queue.
 *
 * Artifact viewers (`kind: 'artifactType'`) never talk to host code.
 */
import { oide } from '../lib/bridge';
import { isAppMessage } from './model';

export interface FrameEntry {
  /** The iframe's window; compared with `MessageEvent.source`. */
  win(): Window | null;
  extension: string;
  /** Panel id, or artifact type id for viewers. */
  id: string;
  kind: 'panel' | 'artifactType';
  /** Sent as `{ type: 'oide:context', … }` once the frame loads. */
  context?: Record<string, unknown>;
  /** `oide:*` messages from this frame. */
  onAppMessage?(data: Record<string, unknown> & { type: string }): void;
  loaded?: boolean;
}

const frames = new Set<FrameEntry>();
const queues = new Map<string, unknown[]>();
const MAX_QUEUE = 20;
/** Messages a frame may send per second before the rest are dropped. */
const RATE = 50;
const MAX_BYTES = 256 * 1024;
const sent = new WeakMap<FrameEntry, { at: number; n: number }>();

const key = (extension: string, id: string) => `${extension}\0${id}`;

function post(f: FrameEntry, data: unknown): void {
  try {
    // Opaque origin: '*' is the only target origin that matches; the window itself is the target.
    f.win()?.postMessage(data, '*');
  } catch {
    // The frame went away between the check and the post.
  }
}

export function registerFrame(f: FrameEntry): () => void {
  frames.add(f);
  return () => frames.delete(f);
}

/** The iframe fired `load`: send its context, then anything queued for its panel. */
export function frameLoaded(f: FrameEntry): void {
  f.loaded = true;
  if (f.context) post(f, { type: 'oide:context', ...f.context });
  if (f.kind !== 'panel') return;
  const k = key(f.extension, f.id);
  const q = queues.get(k);
  if (q) {
    queues.delete(k);
    for (const d of q) post(f, d);
  }
}

/** Post data from host code into every loaded frame of one panel (queued if none has loaded). */
export function deliverToPanel(extension: string, panelId: string, data: unknown): number {
  const targets = [...frames].filter(
    (f) => f.kind === 'panel' && f.extension === extension && f.id === panelId && f.loaded,
  );
  if (!targets.length) {
    const k = key(extension, panelId);
    const q = queues.get(k) ?? [];
    q.push(data);
    queues.set(k, q.slice(-MAX_QUEUE));
    return 0;
  }
  for (const f of targets) post(f, data);
  return targets.length;
}

/** Post an app message (`oide:*`) into one frame. */
export function postToFrame(f: FrameEntry, data: { type: `oide:${string}` } & Record<string, unknown>): void {
  post(f, data);
}

function allowed(f: FrameEntry): boolean {
  const now = Date.now();
  const s = sent.get(f);
  if (!s || now - s.at >= 1000) {
    sent.set(f, { at: now, n: 1 });
    return true;
  }
  s.n++;
  return s.n <= RATE;
}

export function onWindowMessage(e: MessageEvent): void {
  if (!e.source) return;
  let from: FrameEntry | undefined;
  for (const f of frames) if (f.win() === e.source) from = f;
  if (!from) return; // not one of our extension frames (artifact previews, the app itself, …)
  const data: unknown = e.data;
  if (isAppMessage(data)) {
    from.onAppMessage?.(data);
    return;
  }
  if (from.kind !== 'panel') return;
  let size: number;
  try {
    size = JSON.stringify(data ?? null).length;
  } catch {
    return;
  }
  if (size > MAX_BYTES || !allowed(from)) return;
  void oide
    .invoke('extensions.panelMessage', { extension: from.extension, panelId: from.id, data })
    .catch(() => undefined);
}

/** Install the window listener and the host → panel event. Returns an unsubscribe. */
export function connectPanelBridge(): () => void {
  window.addEventListener('message', onWindowMessage);
  const off = oide.on(
    'extensions.panelMessage',
    ({ extension, panelId, data }) => void deliverToPanel(extension, panelId, data),
  );
  return () => {
    window.removeEventListener('message', onWindowMessage);
    off();
  };
}

/** Tests only. */
export function resetPanelBridge(): void {
  frames.clear();
  queues.clear();
}
