import type { MainContext } from '../context.js';
import { IpcError, type IpcRouter } from '../ipc/router.js';
import type { Services } from '../services/index.js';

const OK = { ok: true as const };

/** git.* */
export function registerGitHandlers(router: IpcRouter, s: Services, _ctx: MainContext): void {
  const g = s.git;
  router.register('git.sync', ({ projectId }) => g.sync(projectId));
  router.register('git.fetch', ({ projectId }) => g.fetch(projectId));
  router.register('git.pull', ({ projectId }) => g.pull(projectId));
  router.register('git.push', ({ projectId }) => g.push(projectId));
  router.register('git.commit', ({ projectId, message, files }) => g.commit(projectId, message, files));
  router.register('git.log', ({ projectId, ref, limit }) => g.log(projectId, ref, limit));
  router.register('git.worktrees', ({ projectId }) => g.worktrees(projectId));
  router.register('git.overlaps', ({ projectId }) => g.overlaps(projectId));
  router.register('git.diff', ({ agentId }) => g.diff(agentId));
  router.register('git.mergeLocal', ({ agentId }) => g.mergeLocal(agentId));
  router.register('git.openPr', ({ agentId, title, body }) => g.openPr(agentId, title, body));
  router.register('git.prAvailable', ({ projectId }) => {
    s.projects.require(projectId);
    return g.prAvailable();
  });
  router.register('git.pruneOrphans', ({ projectId }) => g.pruneOrphans(projectId));

  // "Ask an agent to reconcile": a new worktree from the first branch, both branches and the overlap in the goal.
  router.register('git.reconcile', async ({ projectId, agentIds }) => {
    s.projects.require(projectId);
    const [a, b] = agentIds.map((id) => s.agents.require(id));
    if (!a!.branch || !b!.branch) throw new IpcError('Both agents need their own branch to reconcile.', 'conflict');
    const overlap = (await g.overlaps(projectId)).find((o) => o.agentIds.includes(a!.id) && o.agentIds.includes(b!.id));
    const files = overlap?.files.length ? overlap.files.map((f) => `- ${f}`).join('\n') : '- (no overlapping files detected right now)';
    const settings = s.store.settings.get();
    const goal = [
      `Two agents changed the same files in parallel. Reconcile their work into one branch.`,
      `Branch 1: ${a!.branch} ("${a!.title}"). Your worktree starts from this branch.`,
      `Branch 2: ${b!.branch} ("${b!.title}"). Merge it in with \`git merge ${b!.branch}\`.`,
      `Overlapping files:\n${files}`,
      overlap?.conflicts ? 'git merge-tree predicts real conflicts: resolve each one, keeping the intent of both changes.' : 'Check that both changes still work together.',
      'Run the project checks, commit, and call submit_for_review when done.',
    ].join('\n\n');
    return s.agents.spawn({
      projectId,
      title: `Reconcile ${a!.title} + ${b!.title}`.slice(0, 200),
      goal,
      workIn: 'worktree-from-main',
      baseRef: a!.branch,
      mode: settings.claude.defaultMode === 'bypassPermissions' && !settings.claude.allowBypass ? 'auto' : settings.claude.defaultMode,
      strategy: s.store.settings.strategyFor(),
    });
  });
}

/** review.* (comments in the store; Send feedback = one review-feedback message with file:line refs) */
export function registerReviewHandlers(router: IpcRouter, s: Services, _ctx: MainContext): void {
  const r = s.store.review;
  router.register('review.comments', ({ agentId }) => r.comments(agentId));
  router.register('review.addComment', ({ agentId, path, line, body }) => {
    s.agents.require(agentId);
    return r.addComment({ agentId, path, ...(line !== undefined ? { line } : {}), body });
  });
  router.register('review.deleteComment', ({ commentId }) => {
    if (!r.deleteComment(commentId)) throw new IpcError(`Unknown comment ${commentId}`, 'not_found');
    return OK;
  });
  router.register('review.sendFeedback', ({ agentId, note }) => {
    s.agents.require(agentId);
    const pending = r.comments(agentId).filter((c) => !c.sent);
    if (!pending.length && !note?.trim()) throw new IpcError('No unsent comments and no note to send.', 'invalid_input');
    // Deliver first, then mark sent, so a failed delivery leaves the comments unsent.
    s.agents.send(agentId, {
      kind: 'review-feedback',
      comments: pending.map((c) => ({ path: c.path, ...(c.line !== undefined ? { line: c.line } : {}), body: c.body })),
      ...(note?.trim() ? { note: note.trim() } : {}),
    });
    r.takeUnsent(agentId);
    return OK;
  });
  router.register('review.setViewed', ({ agentId, path, viewed }) => {
    r.setViewed(agentId, path, viewed);
    return OK;
  });
  router.register('review.viewed', ({ agentId }) => r.viewed(agentId));
}
