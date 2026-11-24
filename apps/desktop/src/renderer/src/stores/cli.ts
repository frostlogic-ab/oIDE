import { create } from 'zustand';
import type { CliInfo, CommandOutput } from '@oide/protocol';
import { invokeOr, oide } from '../lib/bridge';

/** Claude Code CLI health (found, version, signed in) and usage counters for the status bar. */
export type UsageSummary = CommandOutput<'usage.summary'>;

export type CliHealth = 'checking' | 'unknown' | 'connected' | 'sign-in' | 'missing' | 'untested';

interface CliState {
  info: CliInfo | null;
  /** True once detection answered (or main has no CLI service yet). */
  detected: boolean;
  usage: UsageSummary | null;
  detect(): Promise<void>;
  refreshUsage(): Promise<void>;
  apply(info: CliInfo): void;
  /** Opens a terminal running `claude` so the user signs in through Anthropic's own flow. */
  openSignIn(): Promise<string | null>;
}

export const useCli = create<CliState>()((set) => ({
  info: null,
  detected: false,
  usage: null,
  detect: async () => {
    set({ info: await invokeOr('cli.detect', undefined, null), detected: true });
  },
  refreshUsage: async () => {
    set({ usage: await invokeOr('usage.summary', undefined, null) });
  },
  apply: (info) => set({ info, detected: true }),
  openSignIn: async () => {
    const { terminalId } = await oide.invoke('cli.openSignIn', undefined);
    return terminalId;
  },
}));

export function cliHealth(info: CliInfo | null, detected = true): CliHealth {
  if (!info) return detected ? 'unknown' : 'checking';
  if (!info.found) return 'missing';
  if (info.signedIn === 'no') return 'sign-in';
  if (!info.inTestedRange) return 'untested';
  return 'connected';
}

export function connectCli(): () => void {
  return oide.on('cli.changed', (info) => useCli.getState().apply(info));
}
