import type { AgentPrInfo } from '@oide/protocol';
import { Badge, Button, Icon, StatusDot, cn, type BadgeTone } from '@oide/ui';
import { ipcErrorMessage, oide } from '../lib/bridge';
import { toast } from '../stores/ui';

/**
 * "View PR #12" plus the PR's state and CI checks, for an agent whose branch has a pull request (tile, Focus,
 * Review). Opens the URL in the system browser through main's external-link allow-list.
 */
export const PR_STATE_LABEL: Record<AgentPrInfo['state'], string> = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const PR_STATE_TONE: Record<AgentPrInfo['state'], BadgeTone> = { open: 'ok', draft: 'neutral', merged: 'violet', closed: 'bad' };

export function openPrPage(url: string): void {
  oide.invoke('shell.openExternal', { url }).catch((err: unknown) => toast(`Could not open the pull request page: ${ipcErrorMessage(err)}`, 'error'));
}

export function PrStateBadge({ pr }: { pr: AgentPrInfo }) {
  return (
    <Badge tone={PR_STATE_TONE[pr.state]} title={`Pull request #${pr.number} is ${pr.state}`}>
      {pr.state === 'closed' ? 'PR closed' : PR_STATE_LABEL[pr.state]}
    </Badge>
  );
}

type Checks = NonNullable<AgentPrInfo['checks']>;

/** "7 of 9 checks finished, 1 failed" (tooltip and accessible name of the CI indicator). */
export function checksDescription(c: Checks): string {
  const failed = c.failed ? `, ${c.failed} failed` : '';
  if (c.state === 'pending') return `CI running: ${c.completed} of ${c.total} checks finished${failed}`;
  if (c.state === 'failure') return `CI failed: ${c.failed} of ${c.total} checks failed`;
  return `CI passed: all ${c.total} checks passed`;
}

/**
 * CI on the PR's head commit: amber pulsing dot and "7/9" while checks run, a green check when
 * they all passed, red when one failed (already while others still run). Opens the PR's Checks tab.
 */
export function PrChecks({ pr }: { pr: AgentPrInfo }) {
  const c = pr.checks;
  if (!c || (pr.state !== 'open' && pr.state !== 'draft')) return null;
  const failing = c.failed > 0;
  const tone = failing ? 'text-bad' : c.state === 'pending' ? 'text-warn' : 'text-ok';
  const label = checksDescription(c);
  return (
    <button
      type="button"
      onClick={() => openPrPage(`${pr.url.replace(/\/+$/, '')}/checks`)}
      title={`${label}. Open the checks on GitHub.`}
      aria-label={`${label}. Open the checks of pull request #${pr.number}.`}
      className={cn('inline-flex items-center gap-1 h-5 px-1 rounded-[6px] text-[11px] font-mono whitespace-nowrap border-0 bg-transparent cursor-pointer hover:underline hover:bg-raised', tone)}
    >
      {c.state === 'pending' ? (
        <StatusDot color={failing ? 'var(--color-bad)' : 'var(--color-warn)'} size={7} className="motion-safe:animate-pulse" />
      ) : (
        <Icon name={failing ? 'alert-circle' : 'check'} size={12} />
      )}
      {c.state === 'failure' ? `${c.failed} failed` : `${c.completed}/${c.total}`}
    </button>
  );
}

/** Just the "View PR #12" button; tiles lay it out apart from the state badge and CI so their footer wraps cleanly. */
export function PrButton({ pr, size = 28 }: { pr: AgentPrInfo; size?: 28 | 32 }) {
  return (
    <Button variant="review-outline" size={size} icon="external-link" onClick={() => openPrPage(pr.url)} aria-label={`View pull request #${pr.number} (${pr.state})`}>
      View PR #{pr.number}
    </Button>
  );
}

/** The PR's state badge and CI checks, kept together (they never wrap apart). */
export function PrStatus({ pr }: { pr: AgentPrInfo }) {
  return (
    <span className="inline-flex items-center gap-1.5 shrink-0">
      <PrStateBadge pr={pr} />
      <PrChecks pr={pr} />
    </span>
  );
}

export function PrLink({ pr, size = 28, className }: { pr: AgentPrInfo; size?: 28 | 32; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className ?? ''}`}>
      <PrButton pr={pr} size={size} />
      <PrStatus pr={pr} />
    </span>
  );
}
