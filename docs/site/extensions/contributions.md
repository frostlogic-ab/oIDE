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
- From Ctrl/Cmd+K, commands run with no arguments, except in Focus, where the argument is
  `{ agentId }` for the agent on screen. Your own host code may call them with other arguments.
- A `keybinding` in the declaration becomes the command's default shortcut; users can rebind it in
  Settings > Keyboard shortcuts.
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

Settings are scoped to your extension. Uninstalling it deletes its secrets. Contributed settings
appear in **Settings › Extensions**, typed by their `type`; secret fields are password inputs whose
value is written to the keychain and never shown again (the UI only knows whether one is set). Host
code reads them with `ctx.settings.get`.

## Panels

A panel is an HTML file in your package, meant to be shown in Focus's inspector (`location:
"inspector"`, the default) or as a full screen (`"screen"`), inside a **sandboxed iframe**.

Where it shows:

- `inspector`: a tab in Focus's inspector, for agents in projects where your extension is on.
- `screen`: a full screen, with a button in the left rail.
- Both get an "Open &lt;title&gt;" entry in Ctrl/Cmd+K, and `ctx.panels.open` opens them.

The iframe is `sandbox="allow-scripts"` (no forms, no popups, an opaque origin) and is served from
your package folder over an internal `oide-ext://` URL with a Content Security Policy that blocks
network requests (`connect-src 'none'`). The only exception: if your `capabilities.network` lists
`localhost` or `127.0.0.1`, the panel may embed loopback pages in a child frame (this is how Browser
preview shows a dev server). When the frame loads, the app sends it
`{ type: 'oide:context', agentId, projectId, worktreePath, branch }`; messages whose `type` starts
with `oide:` are the app's own and never reach your host code. A message from a panel starts your
host code if it is not running. Panel messages must be JSON and at most 256 KB.

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

| Point | Where it shows |
| --- | --- |
| `themes` | **Settings › Appearance** lists the themes of extensions that are on, and Ctrl/Cmd+K has "Next accent colour". Only the tokens `accent`, `accent-contrast`, `link` and `link-hover` are applied, as `#rrggbb` colours. |
| `techniques` | **Spawn › Advanced techniques** (off by default) and a read-only "From extensions" list in **Settings › Techniques**. |
| `deployTargets` | A button in **Review**'s summary column. It runs the host command registered under the target id with `{ agentId, projectId, title, branch, baseRef, worktreePath }`; a returned `{ message, url }` shows as a toast with an Open link (https only). Deploy targets cannot be run from Ctrl/Cmd+K. |
| `artifactTypes` | **Artifacts › Open**, for artifacts whose `artifact.json` has `type: "<your package name>:<type id>"`. Your `entry` runs in the same sandboxed iframe as panels, receives `{ type: 'oide:artifact', artifact }` on load (or after it posts `{ type: 'oide:ready' }`) and saves with `{ type: 'oide:artifact.save', content }`, which adds a new version of that artifact. Storage stays one of the built-in kinds (design, doc, whiteboard), and without your extension the artifact opens in its kind's normal viewer. |
| `languages` | Parsed, and its command line is shown in the first-run consent dialog, but **not started** in v1. |

The built-in [Accent themes](https://github.com/oide-dev/oide/tree/main/extensions/themes) extension
is manifest-only: it declares the four accent themes (Blue, Green, Violet, Amber).
