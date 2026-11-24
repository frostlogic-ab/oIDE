// Host code for the Git extension: pull requests for an agent's branch through `gh`.
import { checkCwd, ghArgs, runGh } from './gh.js';

/**
 * Commands take `{ agentId }` (its worktree is used) or `{ cwd }`.
 * @param {import('@oide/extension-api').ExtensionContext} ctx
 * @param {unknown} arg
 */
async function resolveCwd(ctx, arg) {
  const a = /** @type {{ agentId?: unknown, cwd?: unknown } | undefined} */ (arg && typeof arg === 'object' ? arg : undefined);
  if (typeof a?.agentId === 'string') {
    const agent = (await ctx.agents.list()).find((x) => x.id === a.agentId);
    if (!agent?.worktreePath) throw new Error('That agent has no worktree');
    return checkCwd(agent.worktreePath);
  }
  return checkCwd(a?.cwd);
}

/** @param {import('@oide/extension-api').ExtensionContext} ctx */
async function ghPath(ctx) {
  const v = await ctx.settings.get('git.ghPath');
  return typeof v === 'string' && v.trim() ? v.trim() : 'gh';
}

/** @param {import('@oide/extension-api').ExtensionContext} ctx */
export function activate(ctx) {
  ctx.subscriptions.push(
    ctx.commands.register('git.openPullRequest', async (arg) => {
      const cwd = await resolveCwd(ctx, arg);
      const a = /** @type {{ base?: unknown, draft?: unknown }} */ (arg && typeof arg === 'object' ? arg : {});
      /** @type {{ base?: string, draft?: boolean }} */
      const opts = {};
      if (typeof a.base === 'string') opts.base = a.base;
      if (a.draft === true) opts.draft = true;
      await runGh(await ghPath(ctx), ghArgs('open', opts), cwd);
      return { opened: true };
    }),
    ctx.commands.register('git.viewPullRequest', async (arg) => {
      const cwd = await resolveCwd(ctx, arg);
      const gh = await ghPath(ctx);
      const web = !!(arg && typeof arg === 'object' && /** @type {{ web?: unknown }} */ (arg).web === true);
      if (web) {
        await runGh(gh, ghArgs('view-web'), cwd);
        return { opened: true };
      }
      return JSON.parse(await runGh(gh, ghArgs('view'), cwd));
    }),
  );
}

export function deactivate() {}
