/**
 * Language servers that are not installed (ADR 0019): instead of leaving the user to copy an
 * install command, the Files screen asks once, in a toast, whether to install the server. Install
 * opens a terminal in the Files panel that runs the command (main picks the command from the
 * extension's manifest, `lsp.install`) and main starts the server once it shows up on PATH. No
 * means "don't ask again" for that language; the tab bar's server menu still offers Install.
 */
import type { LspStatus } from '@oide/protocol';
import { trackLanguageServerInstall } from '../../lib/telemetry';
import { useTerminals } from '../../stores/terminals';
import { toast } from '../../stores/ui';
import { useLsp } from './lspStore';

const DECLINED_KEY = 'oide.lsp.installDeclined';
/** Languages already asked about in this run (declined ones are remembered across runs). */
const asked = new Set<string>();

const promptKey = (s: LspStatus): string => s.language ?? s.server ?? '';

function declined(): string[] {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(DECLINED_KEY) : null;
    const v: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function decline(key: string): void {
  try {
    const list = declined();
    if (!list.includes(key)) localStorage.setItem(DECLINED_KEY, JSON.stringify([...list, key]));
  } catch {
    /* storage unavailable: it is still not asked again in this run */
  }
}

/** Open a terminal in the Files panel that installs the document's language server. */
export function installLanguageServer(root: string, path: string, status: LspStatus, via: 'prompt' | 'menu'): void {
  const name = status.server ?? status.language ?? 'language server';
  useTerminals.getState().installServer('files', { root, path }, `Install ${name}`);
  trackLanguageServerInstall('install', via);
}

/** The toast for one document whose server is missing, unless asked already or declined for good. */
export function promptInstall(root: string, path: string, status: LspStatus): void {
  if (status.state !== 'not-installed' || !status.install) return;
  const key = promptKey(status);
  if (!key || asked.has(key) || declined().includes(key)) return;
  asked.add(key);
  const name = status.server ?? status.language ?? 'The language server';
  toast(`${name} is not installed. Install it now? It runs: ${status.install}`, 'info', {
    key: `lsp-install:${key}`,
    duration: 0,
    action: { label: 'Install', run: () => installLanguageServer(root, path, status, 'prompt') },
    secondary: {
      label: 'No',
      run: () => {
        decline(key);
        trackLanguageServerInstall('declined', 'prompt');
      },
    },
  });
}

let watching = false;

/** Watch the open documents' server states and ask about missing servers (once per window). */
export function ensureInstallPrompts(): void {
  if (watching) return;
  watching = true;
  const check = (status: Record<string, LspStatus>) => {
    for (const [docKey, s] of Object.entries(status)) {
      if (s.state !== 'not-installed') continue;
      const i = docKey.indexOf('\0');
      promptInstall(docKey.slice(0, i), docKey.slice(i + 1), s);
    }
  };
  check(useLsp.getState().status);
  useLsp.subscribe((st, prev) => {
    if (st.status !== prev.status) check(st.status);
  });
}

/** Tests: forget what was asked in this run. */
export function resetInstallPrompts(): void {
  asked.clear();
}
