// Host code of the UI sample fixture: a command that opens its screen, a panel round trip and a deploy target.

/** @param {import('@oide/extension-api').ExtensionContext} ctx */
export function activate(ctx) {
  ctx.subscriptions.push(
    ctx.commands.register('uiSample.open', async (arg) => {
      const agentId = arg && typeof arg === 'object' && typeof arg.agentId === 'string' ? arg.agentId : undefined;
      await ctx.panels.open(agentId ? 'uiSample.notes' : 'uiSample.board', agentId ? { agentId } : undefined);
      return 'opened';
    }),
    ctx.commands.register('uiSample.deployPreview', async (arg) => ({
      message: `Preview deploy of ${arg.branch ?? arg.agentId} from ${arg.worktreePath ? 'its worktree' : 'nowhere'}`,
      url: 'https://preview.example.invalid/' + encodeURIComponent(arg.agentId),
      arg,
    })),
    ctx.panels.onMessage('uiSample.board', async (data) => {
      if (data && typeof data === 'object' && data.type === 'ping') {
        const token = await ctx.settings.get('uiSample.token');
        await ctx.panels.postMessage('uiSample.board', { type: 'pong', n: data.n, token: token ? 'set' : 'unset', limit: await ctx.settings.get('uiSample.limit') });
      }
    }),
  );
}

export function deactivate() {}
