/** @param {import('@oide/extension-api').ExtensionContext} ctx */
export async function activate(ctx) {
  ctx.log.info('activated by', ctx.activationEvent);
  ctx.subscriptions.push(
    ctx.commands.register('sample.echo', async (...args) => {
      const token = await ctx.settings.get('sample.token');
      const agents = await ctx.agents.list();
      return { args, token, agents: agents.map((a) => a.id), ext: ctx.extension.name };
    }),
    ctx.commands.register('sample.crash', () => {
      setTimeout(() => process.exit(7), 10);
      return 'bye';
    }),
    ctx.commands.register('sample.lazy', async () => {
      await ctx.panels.open('sample.panel', { agentId: 'a1' });
      return 'opened';
    }),
  );
  const seen = [];
  ctx.agents.onEvent((e) => {
    seen.push(e.type);
    if (e.type === 'ping') ctx.agents.postMessage(e.agentId, 'pong ' + seen.length);
  });
}
