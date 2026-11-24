# Manifest reference

The manifest is your package's `package.json`. oIDE validates it with the `ExtensionManifest`
schema in [`packages/protocol/src/extensions.ts`](https://github.com/oide-dev/oide/blob/main/packages/protocol/src/extensions.ts)
plus a few extra rules, when it installs or loads the extension. A manifest that fails is refused
with a message naming the field.

## Package fields

| Field | Required | Rules |
| --- | --- | --- |
| `name` | yes | A valid npm name, scoped or not (`@you/postgres-inspector`). It is your extension's identity: settings, secrets and team enablement are keyed by it. |
| `version` | yes | A semver version (`1.2.0`, `1.3.0-beta.1`). |
| `description` | no | Shown in the Marketplace. |
| `repository` | no | A URL string or `{ "url": "..." }`. |
| `type` | recommended | `"module"`: host code is loaded as an ES module. |
| `files` | recommended | `["dist"]`, so npm publishes only bundled code. |
| `oide` | yes | The oIDE manifest, below. |

`scripts` (install, postinstall, ...) and `dependencies` are **ignored**: oIDE never runs install
scripts and never installs dependencies. Bundle what you need into `dist/`.

## `oide`

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `engine` | string | required | Semver range of the extension API you support, e.g. `^1.0.0`. Checked against oIDE's `API_VERSION` (`1.0.0`); a mismatch refuses the install. |
| `displayName` | string | required | Name shown in oIDE. |
| `publisher` | string | | Shown next to the name. |
| `categories` | string[] | `[]` | Any of `agent-tools`, `review-testing`, `deploy-targets`, `artifact-types`, `views-panels`, `themes`, `languages`. |
| `activation` | string[] | `[]` | When to start host code: `onStartup`, `onAgentSpawn`, `onCommand:<id>`, or `*` (any event). Other values are refused. Every contributed command adds `onCommand:<id>` for you. |
| `main` | string | | Host code entry (an ES module exporting `activate`), relative to the package. Omit it if you have no host code. |
| `mcpServers` | object | `{}` | Agent tools; see below. |
| `contributes` | object | all empty | UI and other contributions; see below. |
| `capabilities` | object | `{ network: [], spawn: false, fs: [] }` | What your code does, shown for consent; see [Capabilities](/extensions/capabilities). |

### Activation events

| Event | When it fires |
| --- | --- |
| `onStartup` | When oIDE starts |
| `onAgentSpawn` | Before an agent starts in a project where the extension is enabled |
| `onCommand:<id>` | The first time the command runs |
| `*` | On any of the above |

Host code only starts for extensions that are enabled somewhere, and only on one of its events.

### `mcpServers`

A map from server name to a stdio server. The name must use only letters, digits, `_` and `-`, and
`oide` is reserved for oIDE's own server.

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `command` | string | required | `node`, another program on the user's `PATH`, or a path inside the package (`./bin/server`). |
| `args` | string[] | `[]` | Arguments. Path-like arguments are resolved inside the package; script files (`.js`, `.mjs`, `.cjs`, `.py`, `.sh`) must exist. |
| `env` | object | `{}` | Extra environment variables (plain values; not for secrets). |
| `tools` | object | `{}` | Map from tool name to `{ "risk": "read" \| "ask", "description"?: string }`. List every tool the server offers. |

See [MCP tools and risk labels](/extensions/tools-and-risk).

### `contributes`

| Point | Shape | Status |
| --- | --- | --- |
| `commands` | `[{ id, title, keybinding? }]` | Listed in Ctrl/Cmd+K; handled by host code. Ids must be unique. `keybinding` becomes the command's default shortcut (users can rebind it). |
| `settings` | `{ "<key>": { type: "string" \| "number" \| "boolean", secret?: boolean, description?, default? } }` | Shown in **Settings › Extensions** and read or written by host code; `secret: true` values live in the OS keychain. |
| `panels` | `[{ id, title, entry, location?: "inspector" \| "screen" }]` | `entry` is an HTML file in the package (must exist). Default location `inspector` (a tab in Focus's inspector); `screen` adds a full screen with a rail button. Shown in a sandboxed iframe. |
| `themes` | `[{ id, label, tokens: { "<token>": "<colour>" } }]` | Offered in **Settings › Appearance**. Only the tokens `accent`, `accent-contrast`, `link` and `link-hover` are applied, and only as `#rrggbb` colours. |
| `techniques` | `[{ id, name, text, placement: "first-message" \| "system-prompt" }]` | Offered (off by default) in Spawn › Advanced techniques; listed read-only in Settings › Techniques. |
| `artifactTypes` | `[{ id, label, entry }]` | `entry` must exist. Shows artifacts tagged `type: "<your name>:<id>"` in Artifacts › Open, in a sandboxed iframe; storage stays one of the built-in kinds. |
| `languages` | `[{ id, extensions: string[], command, args? }]` | A language server command for the Files editor. Parsed and shown in the consent dialog; not started in v1. |
| `deployTargets` | `[{ id, title }]` | A button in Review's summary column; runs the host command registered under the target id. |

### `capabilities`

| Field | Type | Meaning |
| --- | --- | --- |
| `network` | string[] | Hosts your code talks to (`localhost`, `api.example.com`). |
| `spawn` | boolean | Whether your code starts other programs. |
| `fs` | string[] | File system areas your code reads or writes. |

The marketplace index records `network` and `spawn`; its validator checks they match the manifest.

## Path rules

Every path in the manifest (`main`, panel and artifact-type entries, path-like MCP and language
server commands and arguments) is relative to the package and must stay inside it. Absolute paths,
`..` segments and symlinks that resolve outside the package are refused. Referenced files must exist.
For marketplace installs, host code and MCP scripts must be under `dist/`.

## A full example

```json
{
  "name": "@you/postgres-inspector",
  "version": "1.2.0",
  "description": "Lets agents look at your database schema and run read-only queries.",
  "type": "module",
  "files": ["dist"],
  "repository": "https://github.com/you/postgres-inspector",
  "oide": {
    "engine": "^1.0.0",
    "displayName": "Postgres inspector",
    "publisher": "you",
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
