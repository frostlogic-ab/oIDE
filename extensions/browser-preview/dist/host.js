// Host code for Browser preview: the "Open browser preview" command and the panel's default URL.

/** @param {import('@oide/extension-api').ExtensionContext} ctx */
async function defaultUrl(ctx) {
  const saved = await ctx.settings.get('browserPreview.defaultUrl');
  return typeof saved === 'string' && saved.trim() ? saved.trim() : 'http://localhost:3000';
}

/** @param {import('@oide/extension-api').ExtensionContext} ctx */
export function activate(ctx) {
  ctx.subscriptions.push(
    ctx.commands.register('browserPreview.open', async (arg) => {
      const a = /** @type {{ url?: unknown, agentId?: unknown } | undefined} */ (arg && typeof arg === 'object' ? arg : undefined);
      const fromArg = typeof a?.url === 'string' ? a.url : undefined;
      const url = fromArg ?? (await defaultUrl(ctx));
      await ctx.panels.open('browserPreview.panel', typeof a?.agentId === 'string' ? { agentId: a.agentId } : undefined);
      await ctx.panels.postMessage('browserPreview.panel', { type: 'navigate', url });
      return { url };
    }),
    ctx.panels.onMessage('browserPreview.panel', (data) => {
      const d = /** @type {{ type?: unknown, url?: unknown } | null} */ (data && typeof data === 'object' ? data : null);
      if (d?.type === 'navigated') ctx.log.debug('preview at', d.url);
      // A panel that just loaded gets the saved default URL in its address bar (it does not navigate).
      if (d?.type === 'ready') {
        void defaultUrl(ctx).then((url) => ctx.panels.postMessage('browserPreview.panel', { type: 'init', url }));
      }
    }),
  );
}

export function deactivate() {}
