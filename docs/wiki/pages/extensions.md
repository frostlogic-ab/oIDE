# Extensions

An oIDE extension is an npm package with an `oide` manifest in its `package.json`
([build brief, Extension system](../raw/build-brief.md)). Its main job is to give agents tools
through MCP servers; it can also add commands, panels, settings, themes, techniques, artifact
types, languages and deploy targets. oIDE's own Git, Browser preview, accent themes and Languages ship as
extensions in `extensions/`, so the API is used from day one. Marketplace, install and Add custom
are on [marketplace.md](marketplace.md).

## Packages

| Package | What it holds |
| --- | --- |
| `packages/extension-api` (`@oide/extension-api`, published to npm) | Types for authors: `activate(ctx)` / `deactivate()`, `ExtensionContext`, `defineExtension`, `API_VERSION` (1.0.0). No runtime dependencies. `tsc -p tsconfig.build.json` builds `dist/`; `publishConfig.exports` points npm at `dist/` while the repo uses `src/` (ADR 0002). |
| `packages/extension-host` (`@oide/extension-host`) | Manifest loader, registry, installer, MCP config, host process and client, custom tools, OAuth, loopback proxy, developer mode. |
| `extensions/*` | Built-ins: `@oide/ext-git`, `@oide/ext-browser-preview`, `@oide/ext-themes`. |
| `tools/marketplace-index` | Index validation and the bundled offline index. |

## Manifest (`manifest.ts`)

`loadManifest(dir)` reads `package.json`, validates it with the protocol's `ExtensionManifest`
schema plus extra rules (semver `version`, valid `engine` range, server names `[A-Za-z0-9_-]`,
unique panel and command ids, known activation events), checks `engine` against
`ENGINE_VERSION` (= `API_VERSION`) with a small built-in semver (`semver.ts`), and resolves
every path inside the package: `main`, panel and artifact-type entries, MCP server commands and
script args, language servers. Absolute paths, `..` segments and symlinks that resolve outside the
package are rejected (`ManifestError` code `path-escape`); referenced files must exist. Contributed
commands imply `onCommand:<id>` activation.

## Registry (`registry.ts`)

`ExtensionRegistry` keeps the installed list through an injected `ExtensionRepository` (the
store's SQLite repo) and discovers built-ins from `builtinDirs` (the repo's `extensions/` in dev,
`<resources>/extensions` when packaged). Built-ins are on globally by default, reviewed, cannot be
removed; their enable state is persisted like any other record.

Enable state per extension: `enabledGlobally`, `enabledProjects`, `disabledProjects` and
`disabledTools`. For a project the order is: turned off in the project → on in the project → the
project's `.oide/extensions.json` (name → version range; read through an injected
`ProjectExtensionsReader`, ignored for untrusted projects, and never applied to folder or git
extensions) → global. `missingForProject` lists team-requested extensions that are not installed.
`onChange` feeds the `extensions.changed` event.

`add` refuses (`ExtensionConflictError`, IPC `conflict`) a record whose name is already installed
from another source, or from another folder or git URL (SEC-13): a folder extension named like a
marketplace one would otherwise take over its `ext:<name>/` secrets and team enablement. Uninstall
first; that deletes the secrets (prefix `ext:<name>/`, so `foo` never takes `foo-bar`'s).

Turning on a folder or git extension for the first time (`ExtensionsService.setEnabled`) shows a
native confirmation in main that lists the host code, MCP server and language server command lines
and the declared capabilities (marked "not enforced"). The answer is kept per extension and folder
(ui kv `ext-run-confirmed:<id>`); declining returns `forbidden`. `addFromGit` asks natively, naming
the URL, before it clones.

## Risk labels and agent config (`mcp-config.ts`)

`buildMcpConfig` produces, for one agent in one project, the `mcpServers` for `--mcp-config`, the
`allowedTools` and `disallowedTools` lists and the env for secrets:

- `read` tools of enabled extensions and custom servers are pre-allowed; `ask` tools never are, so
  they always prompt on the tile; turned-off tools are disallowed.
- `effectiveToolRisk`: tools of folder and git extensions are always `ask`, whatever their manifest
  says (SEC-15). `ExtensionsService.agentConfig` applies it to the tool refs agent-core turns into
  `--allowedTools`. Marketplace labels are trusted because the installer checks them against the
  index; a custom server's `read` label needs a native confirmation when it is saved.
- Tool names are `mcp__<server>__<tool>` with characters outside `[A-Za-z0-9_-]` replaced by `_`
  (verified on CLI 2.1.325, see [cli-integration](cli-integration.md), "MCP tool names": `db.schema` → `mcp__postgres__db_schema`).
- The server name `oide` is reserved for oIDE's own MCP server; duplicate names are skipped with a
  warning.
- Custom stdio servers get `${OIDE_MCP_<SERVER>_<KEY>}` placeholders; the values come back in
  `env` for the spawn and never touch the generated `mcp.json`. Servers saved to the project's
  `.mcp.json` are left to the CLI (it reads that file natively) but still get their allow/deny
  lists and env, and are skipped entirely in untrusted projects.
- Remote servers with OAuth or header tokens point at the loopback proxy with the agent's secret
  header ([marketplace.md](marketplace.md#loopback-proxy)).

## Host process (`host-process.ts`, `host-client.ts`)

Each extension with host code (`main`) runs in its **own** utility process, started on its first
activation event (`onStartup`, `onAgentSpawn`, `onCommand:<id>`, or `*`). One process per
extension means main knows who is calling from the channel itself, so one extension cannot claim
another's identity to read its secrets (build brief: secrets scoped per extension). Host processes
get an allow-listed env, never the full environment.

`ExtensionHostClient` takes a `fork(path, opts)` function: `utilityProcessFork(utilityProcess)`
in Electron, `nodeFork()` in tests and plain Node (`HOST_PROCESS_ENTRY` is the TypeScript entry;
the desktop build emits its own bundle and passes `entry`). It implements the extension API over
the channel by calling an injected `HostServices`; `createHostServices` is the default
implementation (settings namespaced `extensions:<name>:<key>`, a separator package names cannot
contain; secret ones in the SecretStore under `extension/<name>/<key>`; agents, events and
`artifacts.read` limited to projects where the extension is enabled, project-less artifacts
readable by any running extension).
Commands run with a timeout; panel ids are checked against the manifest. On a crash the client
emits `reloading` with the extension's panel ids (`extensions.hostState`), restarts with
exponential backoff (500 ms → 30 s) and gives up as `failed` after 5 crashes in 2 minutes.
`host-process.ts` only has `node:` and type-only imports so Node can run it directly.

The utility process is separation, not a sandbox (SEC-14): host code has full Node (files, network,
child processes) as the user. Node's permission model would map `fs` and `spawn` to
`--allow-fs-*` / `--allow-child-process`, but Electron 45's utilityProcess ignores `--permission` in
`execArgv` (checked on 45.4.1: `process.permission` is undefined and reads, writes and spawns
succeed), and `child_process.fork` of the Electron binary needs the RunAsNode fuse, which is off.
So capabilities stay consent text, and the Marketplace copy says they are not enforced.

## UI contributions

Every v1 contribution point reaches the product. Security details: [security](security.md#extension-panel-isolation).

| Point | Where it shows | How it works |
| --- | --- | --- |
| `panels` | `inspector`: a tab in Focus's inspector, for agents in projects where the extension is on. `screen`: a full screen (route `extension`), with a letter button in the rail under the top group. Both also get "Open <title>" in Ctrl K. | `<iframe sandbox="allow-scripts">` on `oide-ext://<hash of name>/<entry>` (`ExtensionFrame.tsx`), served by main from the extension folder with a no-network CSP (`services/extension-ui.ts`). Inspector frames mount on first view and stay mounted while hidden. |
| panel ⇄ host | `ctx.panels.postMessage` / `onMessage` / `open` | Panel → `parent.postMessage(data, '*')` → renderer bridge (`extensions/panelBridge.ts`, checks `event.source`) → `extensions.panelMessage` → main (extension on, panel declared, JSON ≤ 256 KB) → `ExtensionHostClient.sendPanelMessage`, which starts stopped host code first (internal event `onPanel:<id>`). Host → `extensions.panelMessage` event → every loaded frame of that panel (queued until it loads). `ctx.panels.open` → `extensions.panelOpen` event → Focus tab for that agent (or the agent already in Focus), otherwise full screen. The app sends `{ type: 'oide:context', agentId, projectId, worktreePath, branch }` when a frame loads; `oide:*` messages never reach host code. |
| `commands` | Ctrl K, grouped under the extension | `extensions.runCommand` in the host. In Focus the argument is `{ agentId }`. Only extensions that are on somewhere are listed. |
| `settings` | Settings › Extensions | `extensions.settings` / `extensions.setSetting` (type-checked; `extensions.settingChanged` event). Secret fields are password inputs; values go to the keychain (`ext:<name>/<key>`) and never come back, only `hasValue`. Text fields save on blur; a field the user has edited keeps its text when the section reloads (a late load or `settingChanged`), and follows the saved value only while unedited. Host code reads them with `ctx.settings.get`. |
| `themes` | Settings › Appearance lists the themes of extensions that are on (falls back to the canvas's four accents); "Next accent colour" in Ctrl K | The choice is stored as `ui.accent` (the theme's `accent` token). `extensions/store.ts` `applyTheme` sets allow-listed tokens: `accent`, `accent-contrast` (→ `--color-on-accent`), `link`, `link-hover`, `#rrggbb` only. |
| `techniques` | Spawn agent › Advanced techniques, and a read-only "From extensions" list in Settings › Techniques | Main appends them to `settings.techniques` and to the supervisor's technique list as `ext:<name>:<id>` with `extension` = display name, off by default. Editing or deleting one is `forbidden`; a settings file cannot mark its own techniques as an extension's. |
| `deployTargets` | Review's summary column, above Open pull request | `extensions.runDeployTarget({ extension, targetId, agentId })` checks the agent and that the extension is on for its project, then calls the host command registered under the target id with `{ agentId, projectId, title, branch, baseRef, worktreePath }`. Deploy targets are not plain commands (Ctrl K and `runCommand` cannot run them). A result `{ message, url }` becomes a toast with an Open link (https only). |
| `artifactTypes` | Artifacts › Open, for artifacts whose `artifact.json` has `type: "<name>:<type id>"` | The extension's entry in the same sandboxed iframe (`ExtensionArtifactView.tsx`). It receives `{ type: 'oide:artifact', artifact: { id, title, kind, type, version, content } }` on load (or when it posts `oide:ready`) and saves with `{ type: 'oide:artifact.save', content }`, a new version of that artifact only. Storage stays one of the three kinds (ADR [0009](../../adr/0009-extension-artifact-types-use-existing-storage-kinds.md)). |
| `languages` | Files editor: hover, completions, go to definition, references, symbols, Format Document, diagnostics (markers, tree colours, Problems list) | Main starts the server (`command` + `args`; optional `name`, `install`, `initializationOptions`) per (language, checkout) for trusted projects where the extension is on, ADR [0019](../../adr/0019-language-servers-in-main-with-a-monaco-bridge.md). Folder and git extensions list the command line in the first-run consent. Details: [screen-files](screen-files.md#language-servers). |

The fixture `packages/extension-host/test/fixtures/ui-builtins/ext-ui` (`@oide-test/ui`) has one of
each point; `test/integration/extension-ui.test.ts`, `packages/extension-host/test/host-client-ui.test.ts`,
`renderer/src/extensions/*.test.ts(x)` and the e2e `apps/desktop/e2e/extensions.spec.ts` (Browser
preview in Focus, its default URL from Settings › Extensions, Ctrl K "Open browser preview", the
frame's opaque origin and blocked fetch) cover them.

## Developer mode (`dev-mode.ts`)

`DevModeWatcher` watches a folder the user picked (`source: 'folder'`, `devMode: true`; refused
for anything else) with `fs.watch` and calls `onReload` after a 300 ms debounce; main restarts the
host code (`client.restart(name)`) and tells the supervisor the extension's MCP servers changed
(the CLI owns those processes, so new agents pick up the change).

## Built-in extensions

| Extension | Contributes |
| --- | --- |
| `@oide/ext-git` (Git) | Commands `git.openPullRequest` (`gh pr create --web --fill`) and `git.viewPullRequest` (`gh pr view --json …`, or `--web`) for an agent's worktree; no deploy targets, no agent tools. Capabilities: spawn, network github.com. |
| `@oide/ext-browser-preview` (Browser preview) | Dependency-free stdio MCP server with one read-only tool `preview_url` (status, content type, redirect and `<title>` of a localhost URL; other hosts refused); inspector panel `browserPreview.panel` that iframes a localhost URL (posts `ready`, host answers `init` with the `browserPreview.defaultUrl` setting; no `<form>`, since the sandbox has no `allow-forms`); command `browserPreview.open` (opens the panel for the agent in Focus and navigates it). |
| `@oide/ext-languages` (Languages) | Manifest only: language servers by command name, found on PATH (then the checkout's `node_modules/.bin`), none bundled: `typescript-language-server --stdio` (.ts/.tsx/.js/.jsx/.mjs/.cjs/.mts/.cts), `pyright-langserver --stdio` (.py/.pyi), `rust-analyzer`, `gopls`, `clangd` (C/C++), `vscode-css-language-server` / `vscode-html-language-server` / `vscode-json-language-server --stdio` (from `vscode-langservers-extracted`, with `provideFormatter`), `yaml-language-server --stdio`, `bash-language-server start`. Each has an `install` hint the editor shows when the command is missing. Capabilities: spawn. |
| `@oide/ext-themes` (Accent themes) | Manifest only: themes Blue `#7AA2F7`, Green `#7FC8A9`, Violet `#C4A7E7`, Amber `#F2C078` (tokens `accent`, `accent-contrast`). Its old `themes.nextAccent` host command changed a setting nothing read; the renderer's "Next accent colour" replaces it. |

Their bundled code lives in `dist/` (plain ESM, checked with `checkJs`); `extensions/.gitignore`
re-includes `dist/` and `.gitattributes` pins LF so packed hashes match across OSes.

## Gaps

- Declared `capabilities` are shown for consent, not enforced (open question 12, SEC-14): see Host
  process above. Revisit when Electron's utilityProcess supports Node's permission model.
- Language servers (ADR 0019): no rename, code actions, semantic tokens, inlay hints or workspace
  symbols yet. Typed artifacts cannot be created from the UI yet (ADR 0009).
- UI loads for extensions that are on globally or in some project; one that only a team file
  (`.oide/extensions.json`) turns on gets its agent tools but no host code or panels, as before.
- The proxy speaks Streamable HTTP; legacy SSE remotes behind OAuth are not proxied.
