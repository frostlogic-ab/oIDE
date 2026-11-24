# Commands, panels and settings

## Commands

Declare commands so they appear in the command bar (Ctrl/Cmd+K), then handle them in host code:

```json
"contributes": {
  "commands": [{ "id": "git.openPullRequest", "title": "Open pull request" }]
}
```

```js
export function activate(ctx) {
  ctx.subscriptions.push(
    ctx.commands.register('git.openPullRequest', async (arg) => {
      // ...
      return { ok: true };
    }),
  );
}
```

- Contributing a command implies the activation event `onCommand:<id>`.
- From Ctrl/Cmd+K, commands run with no arguments. Your own panels may call them with arguments.
- Handlers time out after 15 seconds; start long work in the background and report through
  `ctx.log` or by messaging an agent.
- Use an id prefix unique to your extension (`postgres.connect`), since all commands share one
  command bar.

The built-in [Git extension](https://github.com/oide-dev/oide/tree/main/extensions/git) contributes
`git.openPullRequest` and `git.viewPullRequest`, which run `gh` in an agent's worktree.

## Settings

```json
"contributes": {
  "settings": {
    "browserPreview.defaultUrl": { "type": "string", "default": "http://localhost:3000", "description": "URL the preview panel opens first" },
    "postgres.url": { "type": "string", "secret": true }
  }
}
```

| Field | Meaning |
| --- | --- |
| `type` | `string`, `number` or `boolean`; `ctx.settings.set` refuses other types |
| `secret` | Stored in the OS keychain under your extension's name; never shown back in the UI |
| `description` | Help text |
| `default` | Returned by `ctx.settings.get` until a value is set |

Settings are scoped to your extension. Uninstalling it deletes its secrets. oIDE does not show
contributed settings in the Settings screen yet, so for now read defaults and set values from your
host code (for example from a command that asks for them in a panel, once panels are displayed).

## Panels

A panel is an HTML file in your package, meant to be shown in Focus's inspector (`location:
"inspector"`, the default) or as a full screen (`"screen"`), inside a **sandboxed iframe**.

::: warning Not displayed yet
The manifest, the panel entry checks and the host API (`ctx.panels.open`, `postMessage`,
`onMessage`) exist, but the app does not render extension panels yet: `open` does nothing. Ship
panels only as an extra; do not make your extension depend on them until a release notes that they
are wired.
:::

The contract a panel is written against:

- The page has no access to oIDE's bridge, Node or the network beyond what its own Content Security
  Policy and the sandbox allow. Put a strict CSP `<meta>` in the page.
- It sends data to your host code with `window.parent.postMessage(data, '*')`, received by
  `ctx.panels.onMessage(panelId, fn)`.
- Your host code sends data with `ctx.panels.postMessage(panelId, data)`; it arrives in the page as
  a `message` event from `parent`. Check `event.source === parent`.

Example (from the built-in Browser preview panel):

```html
<script>
  window.addEventListener('message', (e) => {
    if (e.source === parent && e.data && e.data.type === 'navigate') go(e.data.url);
  });
  function go(url) {
    // ...
    parent.postMessage({ type: 'navigated', url }, '*');
  }
</script>
```

```js
ctx.panels.onMessage('browserPreview.panel', (data) => {
  if (data?.type === 'navigated') ctx.log.debug('preview at', data.url);
});
await ctx.panels.open('browserPreview.panel');
await ctx.panels.postMessage('browserPreview.panel', { type: 'navigate', url });
```

## Other contribution points

`themes`, `techniques`, `artifactTypes`, `languages` and `deployTargets` are validated (see the
[manifest reference](/extensions/manifest#contributes)) but not used by the app yet. The built-in
[Accent themes](https://github.com/oide-dev/oide/tree/main/extensions/themes) extension declares four
themes and a `themes.nextAccent` command that cycles a setting.
