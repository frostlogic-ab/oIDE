# Host API

Host code is an ES module named by `oide.main`. It exports `activate(ctx)` and, optionally,
`deactivate()`. oIDE runs it in a **separate process per extension** and builds `ctx` there; every
call crosses a message channel to oIDE's main process, which checks it against your manifest and the
projects your extension is enabled for.

The types are in [`@oide/extension-api`](https://github.com/oide-dev/oide/tree/main/packages/extension-api)
(no runtime dependencies):

```sh
npm install --save-dev @oide/extension-api
```

```ts
import { defineExtension } from '@oide/extension-api';

export default defineExtension({
  async activate(ctx) {
    ctx.log.info('activated by', ctx.activationEvent);
  },
});
```

In plain JavaScript, use a JSDoc type instead:

```js
/** @param {import('@oide/extension-api').ExtensionContext} ctx */
export function activate(ctx) {}
export function deactivate() {}
```

Both shapes work: named `activate` / `deactivate` exports, or a default export with those methods.

## Exports

| Export | What it is |
| --- | --- |
| `API_VERSION` | `'1.0.0'`. Declare a range for it in `oide.engine`. |
| `defineExtension(module)` | Identity helper that types your module. |
| `ExtensionContext`, `ExtensionModule` | The types below. |
| `CommandsApi`, `SettingsApi`, `AgentsApi`, `PanelsApi`, `ArtifactsApi`, `Logger` | The parts of `ctx`. |
| `AgentInfo`, `AgentStatus`, `AgentEventInfo`, `ArtifactContent`, `ExtensionInfo` | Data types. |
| `Disposable`, `CommandHandler`, `SettingValue`, `ActivationEvent` | Helper types. |

## `ExtensionContext`

| Member | Type | Meaning |
| --- | --- | --- |
| `extension` | `{ name, version, path }` | Your package; `path` is its absolute folder. |
| `activationEvent` | string | The event that started you (`onStartup`, `onAgentSpawn`, `onCommand:<id>`). |
| `commands` | `CommandsApi` | Command handlers. |
| `settings` | `SettingsApi` | Your settings and secrets. |
| `agents` | `AgentsApi` | Agents in projects where you are enabled. |
| `panels` | `PanelsApi` | Your panels. |
| `artifacts` | `ArtifactsApi` | Read local artifacts. |
| `log` | `Logger` | `debug`, `info`, `warn`, `error` into oIDE's log. |
| `subscriptions` | `Disposable[]` | Push disposables here; oIDE disposes them on deactivate. |

### `ctx.commands`

```ts
register(id: string, handler: (...args: unknown[]) => unknown | Promise<unknown>): Disposable
```

The handler's return value goes back to the caller. Commands listed in `contributes.commands` show
in Ctrl/Cmd+K (run with no arguments). A command call times out after 15 seconds.

### `ctx.settings`

```ts
get<T extends string | number | boolean | null>(key: string): Promise<T | undefined>
set(key: string, value: string | number | boolean | null): Promise<void>
```

- Values are namespaced to your extension; you cannot read another extension's settings.
- `get` returns the stored value, else the manifest `default`, else `undefined`.
- `set` checks the value against the declared `type`. `null` removes the value.
- Keys declared with `secret: true` are stored in the OS keychain. When the keychain is unavailable
  oIDE refuses to store them.

### `ctx.agents`

```ts
list(filter?: { projectId?: string }): Promise<AgentInfo[]>
onEvent(listener: (event: AgentEventInfo) => void): Disposable
postMessage(agentId: string, text: string): Promise<void>
```

Only agents in projects where your extension is enabled are visible. `AgentInfo` is
`{ id, projectId, title, status, model, branch?, worktreePath? }`; `status` is one of `queued`,
`starting`, `running`, `needs-permission`, `has-question`, `ready-for-review`, `paused`, `stopped`,
`rate-limited`, `error`, `done`. Events are oIDE's normalized agent events
(`{ agentId, type, seq, ts, ... }` with types such as `init`, `assistant-text`, `tool-use`,
`tool-result`, `status`). `postMessage` sends a user message to the agent, as if typed in its tile;
use it sparingly and only in response to the user.

### `ctx.panels`

```ts
open(panelId: string, options?: { agentId?: string; projectId?: string }): Promise<void>
postMessage(panelId: string, data: unknown): Promise<void>
onMessage(panelId: string, listener: (data: unknown) => void): Disposable
```

Panel ids are checked against your manifest. **The app does not display extension panels yet**, so
`open` and `postMessage` currently do nothing; see [Panels](/extensions/contributions#panels).

### `ctx.artifacts`

```ts
read(id: string): Promise<{ id, title, kind, content, version? }>
```

Artifacts of projects where you are enabled, and personal artifacts that belong to no project.

## Lifecycle

- The host process starts on the first matching activation event and stays up while oIDE runs.
- If it crashes, oIDE restarts it with exponential backoff (500 ms up to 30 s) and gives up after 5
  crashes in 2 minutes; the extension then shows as failed.
- On uninstall, disable or quit, oIDE calls `deactivate()` and disposes `ctx.subscriptions`.
- The process gets an allow-listed environment, not oIDE's full environment, and never Claude
  credentials.

## Limits

Extensions cannot read other extensions' secrets or settings, or agents, events and artifacts of
projects where they are not enabled. They are **not sandboxed** beyond that: see
[Capabilities and consent](/extensions/capabilities).
