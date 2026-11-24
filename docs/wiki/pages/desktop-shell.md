# Desktop shell

The Electron app in `apps/desktop` (electron-vite): a hardened main process, a preload that exposes
exactly `window.oide`, and a React 19 + Tailwind v4 + Zustand renderer that draws the Mission
Control frame. Domain services (agents, git, store, extensions) plug into two seams in main; screens
plug into a registry in the renderer. Contract: [protocol](protocol.md). Look: [design-system](design-system.md).
Packaging: [packaging](packaging.md). Process model: [architecture](architecture.md).

## Layout

```
apps/desktop/
  electron.vite.config.ts      main (ESM, bundles @oide/*), preload (CJS, sandbox), renderer (React, Tailwind, CSP meta)
  vite.web.config.ts           renderer-only dev server with the mock bridge (pnpm dev:web)
  electron-builder.yml         installers, fuses, publish config (see packaging.md)
  playwright.config.ts, e2e/   Playwright for Electron smoke tests
  src/main/
    index.ts                   app start, single-instance lock, BrowserWindow, quit hooks
    warnings.ts                imported first; silences only the node:sqlite ExperimentalWarning
    window-state.ts            remembers bounds (userData/window-state.json), min 1100×700
    context.ts                 MainContext passed to services and handlers
    ipc/router.ts              IpcRouter, IpcError, attachRouter
    ipc/emit.ts                createEmitter (validated events), FrameBatcher, createAgentEventBatcher
    security/                  csp.ts, hardening.ts, external.ts (URL allow-list), paths.ts, roots.ts
    services/index.ts          createServices(ctx)  ← seam
    services/terminals.ts      TerminalService (@lydell/node-pty)
    handlers/index.ts          registerAllHandlers(router, services, ctx)  ← seam
    handlers/{app,shell,dialog,terminal}.ts
  src/preload/index.ts         contextBridge → window.oide
  src/renderer/
    index.html                 CSP meta injected at build (%OIDE_CSP%)
    src/main.tsx, App.tsx      fonts, keymap attach, mock bridge in dev browser, store boot
    src/components/frame/      AppFrame, Header, HeaderSlot, Rail, StatusBar, CommandBar, Toasts
    src/screens/<Name>/        one folder per screen; registry.tsx lists them
    src/stores/                router, agents, projects, scope, settings, cli, ui
    src/lib/                   bridge, keymap, useKeymap, commands, coreCommands, boot, format, mock/
```

## Main process

- **Window**: one `BrowserWindow` with `contextIsolation`, `sandbox`, `nodeIntegration: false`,
  `webSecurity`, no webview tag; `app.enableSandbox()`; dark `#0E1013` background; bounds restored.
  `OIDE_USER_DATA` overrides userData (tests); the single-instance lock is per userData folder.
- **Hardening** (`security/hardening.ts`, applied to every webContents): navigation away from the app
  and `window.open` are refused; allow-listed `https` URLs (`security/external.ts`, extend with
  `allowExternalHost(host)`) open in the system browser; `<webview>` refused; permissions denied
  except `clipboard-sanitized-write`.
- **CSP** (`security/csp.ts`): `script-src 'self'` (no inline, no eval), styles allow inline (Monaco,
  xterm), fonts/images allow `data:`/`blob:`, workers allow `blob:`, `frame-src 'none'` (pass
  `frameSrc` when artifact/extension iframes land). Injected as a `<meta>` at build and as a header
  for the dev server. Dev adds `'unsafe-inline'` scripts and the HMR socket only.
- **Quit**: `ctx.onQuit(fn)` hooks run on `will-quit` (3 s cap), then `app.exit(0)`. Use it to deny
  pending permissions, stop agents, close the database.

### IPC router

`IpcRouter` sits on `IPC_INVOKE_CHANNEL`. A request is `{ command, input }`:

1. Unknown command, or no registered handler → `{ ok: false, error: { code: 'not_implemented' } }`.
2. `Commands[command].input.safeParse(input)` → `invalid_input` on failure. Handlers get parsed
   data (defaults applied).
3. Handler result is checked against `Commands[command].output` → `invalid_output` on drift.
4. Throw `new IpcError(message, code)` (or any error with a string `code`, like
   `PathOutsideRootError` → `forbidden_path`) to choose the code; anything else is `internal`.

Senders other than the app's own page get `forbidden`. Events: `ctx.emit(event, payload)` validates
against `Events` and sends `{ event, payload }` on `IPC_EVENT_CHANNEL`. Agent events go through
`ctx.agentEvents.push(ev)`, which flushes one `agents.batch` per ~16 ms (max 2000 per batch).

### Seams for domain services

```ts
// src/main/services/index.ts
export interface Services { terminals: TerminalService /* add yours */ }
export async function createServices(ctx: MainContext): Promise<Services>

// src/main/handlers/index.ts
export function registerAllHandlers(router: IpcRouter, services: Services, ctx: MainContext): void
```

To add a domain: construct the service in `createServices` (register folders with
`ctx.roots.add(path, 'project' | 'worktree' | 'artifact')`, cleanup with `ctx.onQuit`), write
`handlers/<domain>.ts` exporting `register<Domain>Handlers(router, services, ctx)` that calls
`router.register('<command>', handler)`, and call it from `registerAllHandlers`.

**Paths from the renderer** must go through `ctx.roots.assertAllowed(path, kinds?)` (or
`assertInside(root, candidate)` from `security/paths.ts`), which resolves `..` and symlinks (longest
existing prefix, so new files work) and compares case-insensitively on win32/darwin. Use the
returned real path for the actual file operation.

Implemented handlers: `app.info`, `shell.openExternal` (https + allow-list), `shell.revealPath`
(allowed roots only), `dialog.pickFolder`, `terminal.create/write/resize/kill` (cwd must be an
allowed root). `TerminalService` coalesces pty output per ~8 ms into `terminal.data` and emits
`terminal.exit`; it is also the place for the sign-in terminal (`create({ cwd, command: 'claude' })`).

## Preload

Exposes exactly `{ invoke, on, platform }` as `window.oide` (`OideBridge`). It refuses command and
event names outside the contract. Errors reject as `Error("[code] message")` because contextBridge
only carries the message; read the code with `ipcErrorCode(err)` in the renderer. Built as a single
CommonJS file (`out/preload/index.cjs`), as sandboxed preloads require.

## Renderer

### Talking to main

```ts
import { oide, invokeOr, ipcErrorCode, isNotImplemented } from '../../lib/bridge';
const list = await oide.invoke('agents.list', undefined);
const off = oide.on('agents.summary', (s) => …);
const maybe = await invokeOr('git.worktrees', { projectId }, []); // [] while main has no handler
```

`oide` forwards to `window.oide`. Only in a dev build without a preload (a plain browser on
`pnpm --filter @oide/desktop dev:web`, port 5174) does `main.tsx` install the **mock bridge** from
`src/lib/mock/` (dynamic import, absent from production bundles). Fixtures mirror the canvas:
projects oide / billing-api / docs-site, the six agents with their statuses, subagents, activity,
the "npm install node-pty" permission prompt (`requestId: 'perm-1'`), the Focus transcript events,
a review submission with checks, diffs, artifacts, usage and CLI info. Every fixture is parsed
through the protocol schemas. Extend `fixtures.ts` and the `handlers` map in `mockBridge.ts`; unknown
commands reject with `[not_implemented]` exactly like main.

### Stores (Zustand, `src/stores/`)

| Store | State | Actions / helpers |
| --- | --- | --- |
| `useRouter` | `route: { screen, params }`, `back`, `forward` | `navigate(screen, params)`, `replace`, `goBack`, `goForward` |
| `useAgents` | `byId`, `order`, `events[agentId]` (live tail ≤ 2000), `loaded` | `load`, `applySummary`, `applyBatch`, `remove`, `prependHistory`; hooks `useAgent`, `useAgentEvents`, `useAgentsInScope(scope)`, `useAgentCounts`, `useNeedsYou`, `useAgentHistory(agentId)`; pure `agentsInScope`, `countAgents`, `nextNeedsYou`, `stepAgent`, `isNeedsYou`; `loadOlderEvents` |
| `useProjects` | `list`, `loaded` | `load`, `open(path?)`, `remove`; `projectName(list, id)` |
| `useScope` | `scope` (`'all'` or project id) | `load`, `setScope` (persists via `scope.set`, follows `scope.changed`) |
| `useSettings` | `settings` (null until loaded) | `load`, `update(patch)`; `useSetting(select, fallback)`; applies the accent colour |
| `useCli` | `info`, `detected`, `usage` | `detect`, `refreshUsage` (every 15 s), `openSignIn`; `cliHealth(info)` |
| `useUi` | `toasts`, `commandBar`, `headerSlots` | `pushToast` / `toast(msg, level)`, `openCommandBar(mode?)`, `closeCommandBar` |

`lib/boot.ts` subscribes every store to its events (`agents.*`, `projects.changed`, `scope.changed`,
`settings.changed`, `cli.changed`, `notify` → toasts, `extensions.changed`, `command.invoke`) and
loads initial state; `not_implemented` answers resolve to empty state without console noise.

### Screens and the frame

`AppFrame` = 44px `Header`, 56px `Rail`, the screen, 26px `StatusBar`, plus `CommandBar` and `Toasts`.
`screens/registry.tsx` describes each screen: `title`, which `rail` item is current, the header kind
(`command`: command-bar trigger + live counts, Wall/Focus; `title`: screen title), `scopeSwitcher`
(Files, Source control), `customTitle` (screen fills `<HeaderSlot name="title">`, e.g. the Review
breadcrumb), `overlay` (Spawn renders as a dialog over the Wall). The status bar hides plan
percentage meters (no supported source, see "Context ring and plan usage" in the
[build brief](../raw/build-brief.md)) and shows tokens
today and the rate-limit reset time instead.

**Add a screen**: add its id and params to `ScreenParams` in `stores/router.ts`, create
`screens/<Name>/index.tsx` with a default export, add an entry in `SCREENS`. Wave-1 screens are
placeholders marked `PLACEHOLDER` (the Wall placeholder lists agents with the shared components).

### Keymap

`lib/keymap.ts` holds every shortcut in one rebindable map (`DEFAULT_BINDINGS`): J next agent,
K previous, N next that needs you, Y allow, D deny, Esc back, Mod+K command bar, Mod+Enter send,
Shift+Tab switch mode, Alt+←/→ history. `Mod` is Cmd on macOS, Ctrl elsewhere. It listens on the
renderer window only (never OS-global). Screens activate a scope while mounted:

```ts
useKeymapScope('focus', { 'agent.next': () => …, 'permission.allow': () => … });
useKeymapScope('my-dialog', {}, { modal: true }); // blocks scopes underneath
```

The newest scope wins; a handler returning `false` falls through. Unchorded keys inside inputs,
textareas, selects and contenteditable are ignored; chorded ones (Ctrl/Cmd/Alt) still fire.
`keymap.rebind(action, combos)` persists to localStorage (move to settings when a field exists);
extensions' `contributes.commands[].keybinding` are registered with `keymap.define`.

### Command bar

`lib/commands.ts` is the registry (`commands.register(cmd | cmd[])` returns an unregister) with a
fuzzy filter. Core commands (`lib/coreCommands.ts`): Spawn an agent, Jump to session… (switches the
bar to an agent list), Next agent that needs you, Go to each screen, Show all projects, Open project.
Extension commands from `extensions.installed` run through `extensions.runCommand`; main can run any
command with the `command.invoke` event. Typing in command mode also offers matching sessions.

## Tests

- Unit (Vitest): `ipc/router.test.ts` (routing, validation, error codes, sender check, emitter,
  batching), `security/paths.test.ts` (traversal, junction/symlink escapes, prefix siblings, case
  rules, URL allow-list), `services/terminals.test.ts` (fake pty), `lib/keymap.test.ts`,
  `lib/commands.test.ts`, `stores/agents.test.ts`; `packages/ui/src/ContextRing.test.ts`.
- E2E (`pnpm --filter @oide/desktop e2e`): window title and web preferences, no Node globals and
  only `window.oide`, CSP blocks string eval and inline scripts, `not_implemented` / `invalid_input`
  / `forbidden` codes over real IPC, rail navigation with `aria-current`, Alt+← history, Ctrl+K,
  no console errors. It writes `test-results/wall-frame.png` for visual comparison with the canvas.
- On Windows, run Vitest from a shell whose cwd uses an upper-case drive letter (`C:\…`); a
  lower-case `c:` cwd loads vitest twice and every suite fails with "reading 'config'".
