// Host code for Accent themes: "Next accent colour" cycles the themes.accent setting.

export const ORDER = ['blue', 'green', 'violet', 'amber'];

/** @param {unknown} current */
export function nextAccent(current) {
  const i = ORDER.indexOf(typeof current === 'string' ? current : '');
  return ORDER[(i + 1) % ORDER.length];
}

/** @param {import('@oide/extension-api').ExtensionContext} ctx */
export function activate(ctx) {
  ctx.subscriptions.push(
    ctx.commands.register('themes.nextAccent', async () => {
      const next = nextAccent(await ctx.settings.get('themes.accent'));
      await ctx.settings.set('themes.accent', next ?? 'blue');
      return { accent: next };
    }),
  );
}

export function deactivate() {}
