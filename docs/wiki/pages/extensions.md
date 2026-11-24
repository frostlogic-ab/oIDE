# Extensions

An oIDE extension is an npm package with an `oide` manifest in its `package.json`
([build brief, Extension system](../raw/build-brief.md)). Its main job is to give agents tools
through MCP servers; it can also add commands, panels, settings, themes, techniques, artifact
types, languages and deploy targets. oIDE's own Git, Browser preview and accent themes ship as
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
`ProjectExtensionsReader`, ignored for untrusted projects) → global. `missingForProject` lists
team-requested extensions that are not installed. `onChange` feeds the `extensions.changed` event.

## Risk labels and agent config (`mcp-config.ts`)

`buildMcpConfig` produces, for one agent in one project, the `mcpServers` for `--mcp-config`, the
`allowedTools` and `disallowedTools` lists and the env for secrets:

- `read` tools of enabled extensions and custom servers are pre-allowed; `ask` tools never are, so
  they always prompt on the tile; turned-off tools are disallowed.
- Tool names are `mcp__<server>__<tool>` with characters outside `[A-Za-z0-9_-]` replaced by `_`
  (guess: matches the CLI's normalisation, check in M1; `db.schema` → `mcp__postgres__db_schema`).
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
implementation (settings namespaced `extensions.<name>.<key>`, secret ones in the SecretStore under
`extension/<name>/<key>`, agents and events limited to projects where the extension is enabled).
Commands run with a timeout; panel ids are checked against the manifest. On a crash the client
emits `reloading` with the extension's panel ids (`extensions.hostState`), restarts with
exponential backoff (500 ms → 30 s) and gives up as `failed` after 5 crashes in 2 minutes.
`host-process.ts` only has `node:` and type-only imports so Node can run it directly.

## Developer mode (`dev-mode.ts`)

`DevModeWatcher` watches a folder the user picked (`source: 'folder'`, `devMode: true`; refused
for anything else) with `fs.watch` and calls `onReload` after a 300 ms debounce; main restarts the
host code (`client.restart(name)`) and tells the supervisor the extension's MCP servers changed
(the CLI owns those processes, so new agents pick up the change).

## Built-in extensions

| Extension | Contributes |
| --- | --- |
| `@oide/ext-git` (Git) | Commands `git.openPullRequest` (`gh pr create --web --fill`) and `git.viewPullRequest` (`gh pr view --json …`, or `--web`) for an agent's worktree; no deploy targets, no agent tools. Capabilities: spawn, network github.com. |
| `@oide/ext-browser-preview` (Browser preview) | Dependency-free stdio MCP server with one read-only tool `preview_url` (status, content type, redirect and `<title>` of a localhost URL; other hosts refused); panel `browserPreview.panel` that iframes a localhost URL; command `browserPreview.open`. |
| `@oide/ext-themes` (Accent themes) | Themes Blue `#7AA2F7`, Green `#7FC8A9`, Violet `#C4A7E7`, Amber `#F2C078` (token `accent`), command `themes.nextAccent`. |

Their bundled code lives in `dist/` (plain ESM, checked with `checkJs`); `extensions/.gitignore`
re-includes `dist/` and `.gitattributes` pins LF so packed hashes match across OSes.

## Gaps

- Declared `capabilities` are shown for consent, not enforced (open question 12).
- `languages`, `artifactTypes`, `techniques` and `deployTargets` are parsed and resolved, but no
  host code runs them yet; the renderer and settings service consume them.
- The proxy speaks Streamable HTTP; legacy SSE remotes behind OAuth are not proxied.
