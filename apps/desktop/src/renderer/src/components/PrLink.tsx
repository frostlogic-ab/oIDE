import type { AgentPrInfo } from '@oide/protocol';
import { Badge, Button, type BadgeTone } from '@oide/ui';
import { ipcErrorMessage, oide } from '../lib/bridge';
import { toast } from '../stores/ui';

/**
 * "View PR #12" plus the PR's state, for an agent whose branch has a pull request (tile, Focus,
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

export function PrLink({ pr, size = 28, className }: { pr: AgentPrInfo; size?: 28 | 32; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className ?? ''}`}>
      <Button variant="review-outline" size={size} icon="external-link" onClick={() => openPrPage(pr.url)} aria-label={`View pull request #${pr.number} (${pr.state})`}>
        View PR #{pr.number}
      </Button>
      <PrStateBadge pr={pr} />
    </span>
  );
}
