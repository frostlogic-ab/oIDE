import type { OverlapWarning } from '@oide/protocol';
import { ipcErrorMessage, oide } from '../../lib/bridge';
import { useAgents } from '../../stores/agents';
import { toast } from '../../stores/ui';
import type { SyncAction } from './model';
import { useGit } from './gitStore';

/**
 * Pull / Push / Fetch for a project's main checkout. These are the only remote git commands.
 * `from` tells main where Pull was clicked (Projects sidebar or Source control, telemetry only).
 */
export async function runSync(projectId: string, action: SyncAction, from: 'sidebar' | 'source-control' = 'source-control'): Promise<void> {
  try {
    const before = useGit.getState().byProject[projectId]?.sync?.behind ?? 0;
    const sync =
      action === 'Pull'
        ? await oide.invoke('git.pull', { projectId, from })
        : await oide.invoke(action === 'Push' ? 'git.push' : 'git.fetch', { projectId });
    useGit.getState().patch(projectId, { sync });
    if (action === 'Fetch') toast(sync.behind ? `Fetched: ${sync.behind} new on ${sync.upstream ?? 'origin'}` : 'Fetched: up to date', 'info');
    if (action === 'Pull') {
      // Same toast from the sidebar and Source control: one confirmation per successful pull.
      toast(before > 0 ? `Pulled ${before} ${before === 1 ? 'commit' : 'commits'} on ${sync.branch}` : `Up to date on ${sync.branch}`, 'success');
    }
    if (action === 'Push') toast(`Pushed ${sync.branch}`, 'success');
    void useGit.getState().load(projectId);
  } catch (err) {
    toast(`${action} failed: ${ipcErrorMessage(err)}`, 'error');
  }
}

/** "Ask an agent to reconcile": spawns an agent on a new worktree from the first branch. */
export async function reconcile(o: Pick<OverlapWarning, 'projectId' | 'agentIds'>): Promise<boolean> {
  try {
    const spawned = await oide.invoke('git.reconcile', { projectId: o.projectId, agentIds: o.agentIds });
    for (const a of spawned) useAgents.getState().applySummary(a);
    toast(spawned[0] ? `Started "${spawned[0].title}"` : 'Reconcile agent started', 'success');
    return true;
  } catch (err) {
    toast(`Couldn't start a reconcile agent: ${ipcErrorMessage(err)}`, 'error');
    return false;
  }
}

export async function revealFolder(path: string): Promise<void> {
  try {
    await oide.invoke('shell.revealPath', { path });
  } catch (err) {
    toast(`Couldn't open the folder: ${ipcErrorMessage(err)}`, 'error');
  }
}

/** Remove an agent's worktree (and the agent record), or prune an orphaned one. */
export async function removeWorktree(projectId: string, agentId: string | undefined): Promise<void> {
  try {
    if (agentId) await oide.invoke('agents.remove', { agentId, deleteWorktree: true });
    else await oide.invoke('git.pruneOrphans', { projectId });
    if (agentId) useAgents.getState().remove(agentId);
    toast('Worktree removed', 'success');
  } catch (err) {
    toast(`Couldn't remove the worktree: ${ipcErrorMessage(err)}`, 'error');
  } finally {
    void useGit.getState().load(projectId);
  }
}
