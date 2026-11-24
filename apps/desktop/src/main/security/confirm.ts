import type { MainContext } from '../context.js';

/**
 * Native confirmations in main for renderer requests that run code or move secrets
 * (review-security SEC-04, SEC-06, SEC-07). A renderer-side confirm proves nothing: a compromised
 * renderer skips it. Cancel is the default button, Escape cancels, and with no Electron (plain Node
 * integration tests) the answer is "no" unless a test installed an override.
 */
export interface ConfirmOptions {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
  /** Warning icon instead of a question mark. */
  danger?: boolean;
}

export type ConfirmFn = (opts: ConfirmOptions) => boolean | Promise<boolean>;

/**
 * Characters that could fake or hide lines in a native dialog: C0/C1 controls (newlines, CR, tab,
 * escape, …), DEL, Unicode line/paragraph separators, bidi embeddings, overrides and isolates,
 * zero-width characters and the BOM.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_DIALOG_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;
const NAMED_ESCAPES: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/**
 * One value for a native confirmation (review-security SEC-31): every unsafe character is shown
 * as a visible escape (`\n`, `\u{202e}`), so a value can never add lines or reorder text, and
 * non-strings are shown as JSON. `max` truncates from the middle (start and end stay visible);
 * pass it only for fields with no security meaning, such as display names, never for paths,
 * URLs, command lines, flags or env values.
 */
export function safeDialogText(value: unknown, opts: { max?: number } = {}): string {
  const raw = typeof value === 'string' ? value : value === undefined || value === null ? '' : (JSON.stringify(value) ?? String(value));
  const t = raw.replace(UNSAFE_DIALOG_CHARS, (c) => NAMED_ESCAPES[c] ?? `\\u{${c.codePointAt(0)!.toString(16)}}`);
  const max = opts.max;
  if (max === undefined || t.length <= max) return t;
  const keep = Math.max(2, max - 1);
  const head = Math.ceil(keep / 2);
  return `${t.slice(0, head)}…${t.slice(t.length - (keep - head))}`;
}

/** The origin of a URL for a confirmation, in full; undefined when the URL does not parse. */
export function dialogOrigin(url: string): string | undefined {
  try {
    const o = new URL(url).origin;
    return o === 'null' ? undefined : safeDialogText(o);
  } catch {
    return undefined;
  }
}

/** Defence in depth: whatever a caller passes, no field can carry hidden or reordering characters. */
function sanitize(opts: ConfirmOptions): ConfirmOptions {
  return {
    ...opts,
    title: safeDialogText(opts.title),
    message: safeDialogText(opts.message),
    confirmLabel: safeDialogText(opts.confirmLabel),
    ...(opts.detail !== undefined ? { detail: opts.detail.split('\n').map((l) => safeDialogText(l)).join('\n') } : {}),
  };
}

let override: ConfirmFn | null = null;

/** Tests only: answer every confirmation with `fn` (null restores the native dialog). */
export function setConfirmOverride(fn: ConfirmFn | null): void {
  override = fn;
}

export async function confirmNative(ctx: MainContext, unsafeOpts: ConfirmOptions): Promise<boolean> {
  const opts = sanitize(unsafeOpts);
  if (override) return override(opts);
  let electron: typeof import('electron');
  try {
    electron = await import('electron');
  } catch {
    return false;
  }
  const { app, dialog } = electron;
  if (!dialog || !app) return false; // plain Node: the `electron` package is only a path string
  // E2E only (unpackaged builds): answer without showing the dialog, like OIDE_E2E_TRUST.
  const e2e = !app.isPackaged ? process.env.OIDE_E2E_CONFIRM : undefined;
  if (e2e) return e2e === 'accept';
  const options: Electron.MessageBoxOptions = {
    type: opts.danger ? 'warning' : 'question',
    title: opts.title,
    message: opts.message,
    ...(opts.detail ? { detail: opts.detail } : {}),
    buttons: [opts.confirmLabel, 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const w = ctx.getWindow();
  const r = w && !w.isDestroyed() ? await dialog.showMessageBox(w, options) : await dialog.showMessageBox(options);
  return r.response === 0;
}
