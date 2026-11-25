import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import { confirmNative, safeDialogText } from '../security/confirm.js';
import type { Services } from '../services/index.js';

const OK = { ok: true as const };

/** agents.* */
export function registerAgentHandlers(router: IpcRouter, s: Services, ctx: MainContext): void {
  const a = s.agents;
  router.register('agents.list', () => a.list());
  router.register('agents.spawn', (spec) => a.spawn(spec));
  // Attachments are checked (picked/dropped paths only, sizes, image bytes) and files copied into the agent's folder.
  router.register('agents.send', async ({ agentId, message }) => {
    await a.send(agentId, message);
    return OK;
  });
  // Accepted only for the exact pending request id of this agent (else not_found).
  router.register('agents.answerPermission', async ({ agentId, answer }) => {
    await a.answerPermission(agentId, answer);
    return OK;
  });
  router.register('agents.setMode', async ({ agentId, mode }) => {
    await a.setMode(agentId, mode);
    return OK;
  });
  router.register('agents.stop', async ({ agentId }) => {
    a.require(agentId);
    await a.supervisor.stop(agentId);
    return OK;
  });
  router.register('agents.pause', async ({ agentId }) => {
    a.require(agentId);
    await a.supervisor.pause(agentId);
    return OK;
  });
  router.register('agents.resume', async ({ agentId }) => {
    await a.resume(agentId);
    return OK;
  });
  router.register('agents.compact', ({ agentId }) => {
    a.require(agentId);
    a.supervisor.compact(agentId);
    return OK;
  });
  router.register('agents.remove', async ({ agentId, deleteWorktree }) => {
    await a.remove(agentId, deleteWorktree);
    return OK;
  });
  // Archived agents (Wall › Archived, Focus read-only).
  router.register('agents.archive', ({ agentId }) => a.archive(agentId));
  router.register('agents.unarchive', ({ agentId }) => a.unarchive(agentId));
  router.register('agents.listArchived', (input) => a.listArchived(input));
  router.register('agents.getArchived', ({ agentId }) => a.getArchived(agentId));
  // A renderer-side confirm proves nothing: main asks natively, Cancel is the default.
  router.register('agents.deletePermanently', async ({ agentId }) => {
    const live = a.supervisor.get(agentId);
    const rec = live ? undefined : s.store.agents.get(agentId);
    const title = live?.title ?? rec?.summary?.title ?? rec?.title;
    if (!title) throw new IpcError(`Unknown agent ${agentId}`, 'not_found');
    const ok = await confirmNative(ctx, {
      title: 'Delete agent permanently',
      message: `Delete "${safeDialogText(title, { max: 80 })}" permanently?`,
      detail: 'Its transcript and history are deleted from oIDE, and its worktree folder too if it still exists. This cannot be undone. Commits already merged stay in your project.',
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (!ok) return { deleted: false };
    await a.deletePermanently(agentId);
    return { deleted: true };
  });
  router.register('agents.events', ({ agentId, beforeSeq, limit }) => {
    if (!a.supervisor.get(agentId) && !s.store.agents.get(agentId)) throw new IpcError(`Unknown agent ${agentId}`, 'not_found');
    return a.events(agentId, beforeSeq, limit);
  });
  router.register('agents.stopSubagent', ({ agentId, subagentId }) => {
    a.require(agentId);
    if (!a.supervisor.stopSubagent(agentId, subagentId)) throw new IpcError(`Unknown or finished subagent ${subagentId}`, 'not_found');
    return OK;
  });
}
