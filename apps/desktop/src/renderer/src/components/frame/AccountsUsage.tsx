import { useEffect, useRef, useState } from 'react';
import { liveWindows, tightestWindow, type AccountUsage, type PlanWindowUsage } from '@oide/protocol';
import { StatusDot, Tooltip, cn } from '@oide/ui';
import { formatResetTime, formatTokens } from '../../lib/format';
import { windowLabel } from '../../lib/planWindows';
import { navigate } from '../../stores/router';

/** Up to this many accounts get a chip each; more collapse into one "Accounts" button with a popover. */
export const MAX_ACCOUNT_CHIPS = 2;

const btn = 'h-[22px] flex items-center gap-1.5 px-2 border-0 rounded-[5px] bg-transparent text-ink-3 text-[11.5px] hover:bg-selected hover:text-ink focus-visible:bg-selected';

const pctOf = (w: PlanWindowUsage) => Math.round(Math.min(1, Math.max(0, w.utilization ?? 0)) * 100);

function Bar({ pct, warn, width = 'w-10' }: { pct: number; warn: boolean; width?: string }) {
  return (
    <span aria-hidden="true" className={cn(width, 'h-[5px] rounded-[3px] bg-line-2 inline-block overflow-hidden')}>
      <span className="block h-[5px]" style={{ width: `${pct}%`, background: warn ? 'var(--color-warn)' : 'var(--color-accent)' }} />
    </span>
  );
}

function ago(ts: number, now: number): string {
  const m = Math.max(0, Math.round((now - ts) / 60_000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

/** One line per window, for tooltips and the popover. Values are the CLI's own, with their age. */
export function describeAccount(a: AccountUsage, now = Date.now()): string[] {
  const lines: string[] = [];
  if (a.signedIn === 'no') lines.push('Not signed in. Sign in from Settings › Claude Code.');
  if (a.rateLimitedUntil && a.rateLimitedUntil > now) lines.push(`Rate limited · resets ${formatResetTime(a.rateLimitedUntil, now)}. Agents wait, they do not retry in a loop.`);
  const live = liveWindows(a.windows, now);
  for (const w of live) {
    const name = windowLabel(w.window).long;
    const value = typeof w.utilization === 'number' ? `${pctOf(w)}%` : 'no percentage reported';
    const reset = w.resetsAt ? `, resets ${formatResetTime(w.resetsAt, now)}` : '';
    lines.push(`${name}: ${value}${reset} (seen ${ago(w.seenAt, now)})`);
  }
  if (!live.length && a.signedIn !== 'no') lines.push('No plan usage yet: it is reported while an agent runs on this account.');
  lines.push(`Tokens today: ${formatTokens(a.tokensToday)}`);
  return lines;
}

/** A compact chip: label, meter of the window closest to its limit, percentage. */
function AccountChip({ account, now }: { account: AccountUsage; now: number }) {
  const limited = account.rateLimitedUntil !== undefined && account.rateLimitedUntil > now;
  const w = tightestWindow(account.windows, now);
  const pct = w ? pctOf(w) : undefined;
  const aria = limited
    ? `${account.label}: rate limited, resets ${formatResetTime(account.rateLimitedUntil!, now)}`
    : pct !== undefined
      ? `${account.label}: ${windowLabel(w!.window).short} plan usage ${pct}%`
      : `${account.label}: no plan usage reported yet`;
  return (
    <Tooltip content={describeAccount(account, now).join('\n')} placement="top-end">
      <button type="button" className={cn(btn, limited && 'text-warn')} aria-label={aria} onClick={() => navigate('settings', { section: 'cli' })}>
        {(limited || account.signedIn === 'no') && <StatusDot color="var(--color-warn)" size={6} />}
        <span className="max-w-[96px] truncate">{account.label}</span>
        {limited ? (
          <span aria-hidden="true">resets {formatResetTime(account.rateLimitedUntil!, now)}</span>
        ) : pct !== undefined ? (
          <>
            <Bar pct={pct} warn={(w!.utilization ?? 0) >= 0.6} />
            <span aria-hidden="true" className="text-ink">
              {pct}%
            </span>
          </>
        ) : (
          <span aria-hidden="true" className="text-ink-4">
            —
          </span>
        )}
      </button>
    </Tooltip>
  );
}

/**
 * Status-bar plan usage per Claude Code account (ADR 0021), shown once there are two or more
 * accounts. Two accounts: a chip each. More: one button, the tightest account on it, and a popover
 * listing every account. Numbers are only ever the CLI's own (ADR 0007), with their age.
 */
export function AccountsUsage({ accounts, now = Date.now() }: { accounts: AccountUsage[]; now?: number }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (accounts.length <= MAX_ACCOUNT_CHIPS) {
    return (
      <>
        {accounts.map((a) => (
          <AccountChip key={a.accountId} account={a} now={now} />
        ))}
      </>
    );
  }

  // The account closest to a limit (a rate-limited one first) goes on the button.
  let top: { a: AccountUsage; pct: number } | undefined;
  for (const a of accounts) {
    const pct = a.rateLimitedUntil && a.rateLimitedUntil > now ? 101 : (() => {
      const w = tightestWindow(a.windows, now);
      return w ? pctOf(w) : -1;
    })();
    if (pct >= 0 && (!top || pct > top.pct)) top = { a, pct };
  }
  const anyLimited = top?.pct === 101;
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={cn(btn, anyLimited && 'text-warn')}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`Plan usage of ${accounts.length} accounts`}
        onClick={() => setOpen((o) => !o)}
      >
        {anyLimited && <StatusDot color="var(--color-warn)" size={6} />}
        Accounts
        {top && (
          <span aria-hidden="true" className="text-ink">
            {top.a.label} {anyLimited ? 'limited' : `${top.pct}%`}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Plan usage per account" className="absolute bottom-[28px] right-0 z-50 w-[320px] p-2 rounded-[10px] border border-line-3 bg-panel shadow-lg text-[12px] text-ink-2 whitespace-normal">
          <ul className="list-none m-0 p-0 flex flex-col gap-1">
            {accounts.map((a) => {
              const live = liveWindows(a.windows, now);
              const limited = a.rateLimitedUntil !== undefined && a.rateLimitedUntil > now;
              return (
                <li key={a.accountId} className="flex flex-col gap-1 px-2.5 py-2 rounded-md bg-card">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-ink truncate flex-1">{a.label}</span>
                    {a.signedIn === 'no' && <span className="text-warn">Not signed in</span>}
                    {limited && <span className="text-warn">Rate limited · resets {formatResetTime(a.rateLimitedUntil!, now)}</span>}
                    <span className="text-ink-3 font-mono text-[11px]">{formatTokens(a.tokensToday)}</span>
                  </div>
                  {live.length ? (
                    live.map((w) => (
                      <div key={w.window} className="flex items-center gap-2 text-ink-3">
                        <span className="w-[86px]">{windowLabel(w.window).short}</span>
                        {typeof w.utilization === 'number' ? (
                          <>
                            <Bar pct={pctOf(w)} warn={w.utilization >= 0.6} width="w-20" />
                            <span className="text-ink w-9 text-right">{pctOf(w)}%</span>
                          </>
                        ) : (
                          <span className="flex-1">no percentage reported</span>
                        )}
                        <span className="flex-1 text-right" title={`Seen ${ago(w.seenAt, now)}`}>
                          {w.resetsAt ? `resets ${formatResetTime(w.resetsAt, now)}` : ''}
                        </span>
                      </div>
                    ))
                  ) : (
                    <span className="text-ink-3">{a.signedIn === 'no' ? 'Sign in from Settings › Claude Code.' : 'Reported while an agent runs on this account.'}</span>
                  )}
                </li>
              );
            })}
          </ul>
          <button type="button" className="mt-1.5 w-full h-7 rounded-md border-0 bg-transparent text-link text-[12px] hover:bg-selected" onClick={() => navigate('settings', { section: 'cli' })}>
            Manage accounts
          </button>
        </div>
      )}
    </div>
  );
}
