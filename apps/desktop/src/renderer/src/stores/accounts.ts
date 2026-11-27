import { create } from 'zustand';
import type { AccountKey, AccountUsage, ClaudeAccount } from '@oide/protocol';
import { invokeOr, oide } from '../lib/bridge';

/**
 * Claude Code accounts (ADR 0021): per-account plan usage, sign-in state and tokens today, pushed by
 * main (`accounts.usage`) whenever an agent event changes them. The account list itself lives in
 * settings (`settings.accounts`); this store only carries what main measured.
 */
interface AccountsState {
  usage: AccountUsage[];
  refresh(): Promise<void>;
  apply(usage: AccountUsage[]): void;
  add(label: string): Promise<ClaudeAccount>;
  rename(id: AccountKey, label: string): Promise<void>;
  remove(id: ClaudeAccount['id']): Promise<void>;
  /** A terminal running `claude` with this account's config folder, for Anthropic's own sign-in. */
  openSignIn(id: AccountKey): Promise<string>;
}

export const useAccounts = create<AccountsState>()((set) => ({
  usage: [],
  refresh: async () => set({ usage: await invokeOr('accounts.usage', undefined, []) }),
  apply: (usage) => set({ usage }),
  add: (label) => oide.invoke('accounts.add', { label }),
  rename: async (id, label) => void (await oide.invoke('accounts.rename', { id, label })),
  remove: async (id) => void (await oide.invoke('accounts.remove', { id })),
  openSignIn: async (id) => (await oide.invoke('accounts.openSignIn', { id })).terminalId,
}));

export function connectAccounts(): () => void {
  return oide.on('accounts.usage', (usage) => useAccounts.getState().apply(usage));
}
