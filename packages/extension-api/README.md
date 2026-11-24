# @oide/extension-api

Types and helpers for writing [oIDE](https://github.com/oide-dev/oide) extensions.

An oIDE extension is an npm package with an `oide` manifest in its `package.json`. Its main job is
to give agents new tools through MCP servers; it can also add commands (Ctrl K), panels, settings,
themes, techniques, artifact types, languages (parsed, not started in v1) and deploy targets.

> **Not on npm yet.** This package is not published, and the npm scope `@oide` belongs to an
> unrelated maintainer: do not `npm install @oide/extension-api`, because that name does not resolve
> to this project. The package will be published under a scope the project controls (the name is
> an open question, see [open questions](../../docs/wiki/pages/open-questions.md) #15). Until then,
> copy [`src/index.ts`](src/index.ts) into your extension, or depend on it as a workspace package
> (`"@oide/extension-api": "workspace:*"`) inside a clone of the oIDE repo, as the built-in
> extensions do. oIDE does not provide this package to extensions at runtime: use type-only imports
> or JSDoc, or bundle `defineExtension` into `dist/`.

## Manifest

```json
{
  "name": "@you/postgres-inspector",
  "version": "1.2.0",
  "type": "module",
  "files": ["dist"],
  "oide": {
    "engine": "^1.0.0",
    "displayName": "Postgres inspector",
    "categories": ["agent-tools"],
    "activation": ["onAgentSpawn", "onCommand:postgres.connect"],
    "main": "dist/host.js",
    "mcpServers": {
      "postgres": {
        "command": "node",
        "args": ["dist/mcp.js"],
        "tools": {
          "db.schema": { "risk": "read" },
          "db.query": { "risk": "ask" }
        }
      }
    },
    "contributes": {
      "panels": [{ "id": "pg.schema", "title": "Schema", "entry": "dist/panel.html" }],
      "commands": [{ "id": "postgres.connect", "title": "Connect database" }],
      "settings": { "postgres.url": { "type": "string", "secret": true } }
    },
    "capabilities": { "network": ["localhost"], "spawn": true }
  }
}
```

Rules oIDE enforces when it loads a manifest:

- Every path (`main`, panel entries, MCP server scripts) is relative to the package and must stay
  inside it. Absolute paths and `..` escapes are rejected.
- oIDE never runs install scripts and never installs your dependencies. Ship bundled code in `dist/`.
- `engine` is a semver range for this API (`API_VERSION`, currently `1.0.0`).
- Tool risk labels: `read` tools are pre-allowed for agents in projects where the extension is
  enabled; `ask` tools always show a permission prompt. Labels are believed only for marketplace
  installs (checked against the index): tools of folder and git extensions always ask first. The
  install dialog shows every tool and every declared capability, and updates that add either ask
  for consent again.
- `capabilities` are declared for consent and **not enforced**. Host code runs in its own process
  with full Node access (files, network, child processes) as the user. Declare honestly anyway:
  the marketplace review and the consent dialogs depend on it.
- A name that is installed from one source (marketplace, folder, git) cannot be replaced by one
  from another source; uninstall it first. Unreviewed (folder or git) extensions need a native
  confirmation the first time they are turned on, and `.oide/extensions.json` never turns them on.
- Agents see your tools as `mcp__<server>__<tool>`.

## Host code

```js
// dist/host.js
/** @param {import('@oide/extension-api').ExtensionContext} ctx */
export function activate(ctx) {
  ctx.subscriptions.push(
    ctx.commands.register('postgres.connect', async () => {
      const url = await ctx.settings.get('postgres.url'); // secret: read from the OS keychain
      ctx.log.info('connecting', Boolean(url));
      await ctx.panels.open('pg.schema');
    }),
  );
}

export function deactivate() {}
```

Or in TypeScript with the `defineExtension` helper:

```ts
import { defineExtension } from '@oide/extension-api';

export default defineExtension({
  activate(ctx) {
    ctx.agents.onEvent((e) => {
      if (e.type === 'tool-use') ctx.log.debug(e.agentId, e['name']);
    });
  },
});
```

### Activation events

| Event | When |
| --- | --- |
| `onStartup` | When oIDE starts |
| `onAgentSpawn` | Before the first agent starts in a project where the extension is enabled |
| `onCommand:<id>` | The first time the command runs (implied for every contributed command) |

### The context

| API | What it does |
| --- | --- |
| `ctx.commands.register(id, fn)` | Handle a command; the return value goes back to the caller |
| `ctx.settings.get(key)` / `set(key, value)` | Your own settings; `secret` ones live in the OS keychain |
| `ctx.agents.list()` / `onEvent(fn)` / `postMessage(agentId, text)` | Agents in projects where you are enabled |
| `ctx.panels.open(id)` / `postMessage(id, data)` / `onMessage(id, fn)` | Your panels (sandboxed iframes) |
| `ctx.artifacts.read(id)` | Read a local artifact |
| `ctx.log` | Logs to oIDE's extension log |

Extensions cannot read other extensions' secrets, or agents and events of projects where they are
not enabled. Host code runs in its own process; a crash restarts it with backoff.

## Panels

A panel is an HTML file loaded in a sandboxed iframe. It talks to your host code with
`window.parent.postMessage(data, '*')` and receives `message` events from `ctx.panels.postMessage`.

## Publishing

Publish to npm, then open a PR against the
[oide-marketplace](https://github.com/oide-dev/oide-marketplace) index with your package's npm
`integrity` hash. See the index repo's README.
