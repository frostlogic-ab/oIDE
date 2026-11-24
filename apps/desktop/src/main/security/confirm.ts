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

let override: ConfirmFn | null = null;

/** Tests only: answer every confirmation with `fn` (null restores the native dialog). */
export function setConfirmOverride(fn: ConfirmFn | null): void {
  override = fn;
}

export async function confirmNative(ctx: MainContext, opts: ConfirmOptions): Promise<boolean> {
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
