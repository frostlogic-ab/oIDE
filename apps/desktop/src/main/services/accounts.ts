import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  AccountId,
  AccountUsage,
  DEFAULT_ACCOUNT,
  PlanWindowUsage,
  accountKeys,
  accountLabel,
  type AccountKey,
  type AgentEvent,
  type ClaudeAccount,
  type Settings,
} from '@oide/protocol';
import type { KvRepo, SettingsService, UsageRepo } from '@oide/store';
import type { Emit } from '../ipc/emit.js';
import { IpcError } from '../ipc/router.js';

/** Persisted per-account state (ui_state `accounts:usage`), so the status bar is not blank after a restart. */
const Stored = z.record(
  z.string(),
  z.object({
    signedIn: z.enum(['yes', 'no', 'unknown']).default('unknown'),
    windows: z.array(PlanWindowUsage).max(16).default([]),
    rateLimitedUntil: z.number().optional(),
  }),
);
type Stored = z.infer<typeof Stored>;

const KV_KEY = 'accounts:usage';
/** Folder under userData holding one CLAUDE_CONFIG_DIR per extra account. */
export const ACCOUNTS_DIR = 'claude-accounts';

export interface AccountsServiceOptions {
  settings: SettingsService;
  kv: KvRepo;
  usage: UsageRepo;
  emit: Emit;
  userDataDir: string;
  /** Agents still on the Wall (not archived) per account, so a used account cannot be removed. */
  agentsOn?: (id: AccountId) => number;
  now?: () => number;
}

/**
 * Claude Code accounts (ADR 0021). Each extra account is a CLAUDE_CONFIG_DIR made from its id under
 * `<userData>/claude-accounts/`; the default account is the CLI's own config. oIDE only picks the
 * folder: it never reads, copies or deletes what the CLI writes inside (rule 3). Plan usage and
 * sign-in state per account are learned from agent events, like the single meter was (ADR 0007).
 */
export class AccountsService {
  private state: Stored;
  private usageTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly o: AccountsServiceOptions) {
    this.state = o.kv.get(KV_KEY, Stored) ?? {};
  }

  private get now(): number {
    return (this.o.now ?? Date.now)();
  }

  private get accounts(): Settings['accounts'] {
    return this.o.settings.get().accounts;
  }

  /** CLAUDE_CONFIG_DIR of a configured extra account, created if missing; undefined when it is not configured. */
  configDir(id: string): string | undefined {
    const parsed = AccountId.safeParse(id);
    if (!parsed.success || !this.accounts.list.some((a) => a.id === parsed.data)) return undefined;
    const dir = join(this.o.userDataDir, ACCOUNTS_DIR, parsed.data);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Env for the sign-in terminal of an account: `{}` for the default account (the user's own config). */
  signInEnv(key: AccountKey): Record<string, string> {
    if (key === DEFAULT_ACCOUNT) return {};
    const dir = this.configDir(key);
    if (!dir) throw new IpcError('That account is not configured any more.', 'not_found');
    return { CLAUDE_CONFIG_DIR: dir };
  }

  add(label: string): ClaudeAccount {
    const cur = this.accounts;
    if (cur.list.length >= 16) throw new IpcError('oIDE keeps at most 16 extra accounts.', 'conflict');
    const account: ClaudeAccount = { id: `acc-${randomBytes(6).toString('hex')}`, label: label.trim() };
    this.o.settings.update({ accounts: { list: [...cur.list, account] } });
    this.configDir(account.id);
    this.publish();
    return account;
  }

  rename(key: AccountKey, label: string): void {
    const cur = this.accounts;
    if (key === DEFAULT_ACCOUNT) this.o.settings.update({ accounts: { defaultLabel: label.trim() } });
    else {
      if (!cur.list.some((a) => a.id === key)) throw new IpcError('Unknown account', 'not_found');
      this.o.settings.update({ accounts: { list: cur.list.map((a) => (a.id === key ? { ...a, label: label.trim() } : a)) } });
    }
    this.publish();
  }

  /** Forget an account in oIDE. Its folder (and the CLI's sign-in in it) stays on disk: oIDE never deletes credentials. */
  remove(id: AccountId): void {
    const cur = this.accounts;
    if (!cur.list.some((a) => a.id === id)) throw new IpcError('Unknown account', 'not_found');
    const n = this.o.agentsOn?.(id) ?? 0;
    if (n > 0) throw new IpcError(`${n === 1 ? 'An agent still uses' : `${n} agents still use`} this account. Archive ${n === 1 ? 'it' : 'them'} first.`, 'conflict');
    this.o.settings.update({ accounts: { list: cur.list.filter((a) => a.id !== id), ...(cur.spawnDefault === id ? { spawnDefault: null } : {}) } });
    delete this.state[id];
    this.save();
    this.publish();
  }

  /** Feed an agent event of an agent on `key` (agents.ts eventSink). */
  observe(key: AccountKey, e: AgentEvent): void {
    const st = (this.state[key] ??= { signedIn: 'unknown', windows: [] });
    let changed: boolean;
    switch (e.type) {
      case 'init':
        changed = st.signedIn !== 'yes';
        st.signedIn = 'yes';
        break;
      case 'error':
        if (e.code !== 'auth') return;
        changed = st.signedIn !== 'no';
        st.signedIn = 'no';
        break;
      case 'plan-usage': {
        const window = e.window ?? 'plan';
        const next: PlanWindowUsage = {
          window,
          status: e.status,
          ...(typeof e.utilization === 'number' ? { utilization: Math.min(10, Math.max(0, e.utilization)) } : {}),
          ...(e.resetsAt !== undefined ? { resetsAt: e.resetsAt } : {}),
          seenAt: this.now,
        };
        st.windows = [...st.windows.filter((w) => w.window !== window), next].slice(-16);
        // An allowed event means requests go through again.
        if (st.rateLimitedUntil !== undefined && /^allowed/.test(e.status)) delete st.rateLimitedUntil;
        changed = true;
        break;
      }
      case 'rate-limit':
        st.rateLimitedUntil = e.resetAt ?? this.now + 60_000;
        changed = true;
        break;
      case 'usage':
        // Tokens today come from the store; tell the renderer at most every 2 s.
        this.usageTimer ??= setTimeout(() => {
          this.usageTimer = undefined;
          this.publish();
        }, 2000);
        this.usageTimer.unref?.();
        return;
      default:
        return;
    }
    if (!changed) return;
    this.save();
    this.publish();
  }

  /** One entry per configured account, default first. */
  snapshot(): AccountUsage[] {
    const s = this.accounts;
    const start = new Date(this.now);
    start.setHours(0, 0, 0, 0);
    const tokens = this.o.usage.totalsByAccount(start.getTime());
    const now = this.now;
    return accountKeys(s).map((key) => {
      const st = this.state[key];
      const limited = st?.rateLimitedUntil !== undefined && st.rateLimitedUntil > now ? st.rateLimitedUntil : undefined;
      return AccountUsage.parse({
        accountId: key,
        label: accountLabel(s, key) ?? key,
        signedIn: st?.signedIn ?? 'unknown',
        windows: st?.windows ?? [],
        ...(limited !== undefined ? { rateLimitedUntil: limited } : {}),
        tokensToday: tokens.get(key) ?? 0,
      });
    });
  }

  private save(): void {
    this.o.kv.set(KV_KEY, this.state, this.now);
  }

  private publish(): void {
    this.o.emit('accounts.usage', this.snapshot());
  }
}
