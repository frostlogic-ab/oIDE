import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

const OK = { ok: true as const };

/** agents.* */
export function registerAgentHandlers(router: IpcRouter, s: Services, _ctx: MainContext): void {
  const a = s.agents;
  router.register('agents.list', () => a.list());
  router.register('agents.spawn', (spec) => a.spawn(spec));
  router.register('agents.send', ({ agentId, message }) => {
    a.send(agentId, message);
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
    a.require(agentId);
    await a.supervisor.resume(agentId);
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
