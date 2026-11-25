# Marketplace

The v1 marketplace is a static index plus npm tarballs; Add custom brings in anything else. The
UI is the Marketplace screen ([screen-marketplace.md](screen-marketplace.md),
[raw design](../raw/design/Marketplace.dc.html)); extension internals are on
[extensions.md](extensions.md).

## Index

- `index.json` in a public index repo (planned: `oide-dev/oide-marketplace`, not created yet; see
  [Distribution defaults](#distribution-defaults)), shape `MarketplaceIndex`
  ([protocol.md](protocol.md)): per entry the npm name, display name, publisher, description,
  categories, repository, `verified`, `source` (`npm` or `builtin`) and versions, each with the npm
  tarball URL, SRI `integrity`, `engine` range, tools with risk labels and capabilities.
- Categories (`MARKETPLACE_CATEGORIES`, the Browse list): agent-tools, review-testing,
  deploy-targets, artifact-types, views-panels, themes, languages.
- `tools/marketplace-index/validate.mjs` is what the index repo's CI runs: schema and rules, then
  for each tarball the hash, safe extraction, manifest, and that the entry lists exactly the
  manifest's tools (same risk) and capabilities. `build.mjs` writes `bundled/index.json`, the
  offline fallback shipped with the app. It lists only oIDE's built-ins (`source: builtin`,
  `verified: true`, integrity from locally packed tarballs); no third-party entries are invented.
  How to submit an extension: [tools/marketplace-index/README.md](../../../tools/marketplace-index/README.md).

## Install flow (`installer.ts`)

`MarketplaceInstaller.getIndex()` reads `indexUrl` live (in the app: Settings › Extensions ›
Marketplace index URL, `settings.marketplace.indexUrl`). **Empty, the default: the bundled index is the
only source and nothing is fetched.** With an https URL it uses the disk cache (`<cacheDir>/index.json`)
when younger than a day, otherwise fetches the URL; offline it falls back to the cache, then the bundled
index. A non-https URL falls back to the bundled index without fetching. Names the bundled index lists
as `builtin` stay built-in: a remote entry with the same name is replaced by the bundled one, so a
remote index can never turn a built-in into an npm download.

`install(name, version?)`:

1. Pick the exact version, or the newest whose `engine` fits this oIDE. Built-in entries (and any
   name the bundled index marks built-in) are refused, and so is a version whose tarball is not an
   `https://` URL.
2. Download the tarball (64 MB cap) and verify its SRI hash (strongest of sha512/sha384/sha256,
   constant-time compare) **before** anything is unpacked.
3. Validate every tar header first (`tarball.ts`): no absolute or drive paths, no `..` (also with
   backslashes), no `:` in names, no hard links, devices or FIFOs, symlinks only inside the package,
   one top folder, entry and size limits. Then extract with `tar` into a temp folder and rename it
   to `<app-data>/extensions/<name>@<version>`.
4. Load the manifest: name and version must match the entry; the manifest may not declare tools
   the index does not list or mark an "asks first" tool read-only; host code and MCP scripts must
   be bundled under `dist/`. Install scripts are never run and dependencies never installed (both
   reported as warnings). Any failure removes the folder.

The caller adds the returned record to the registry (`reviewed` = the entry's `verified`).
`checkUpdates(installed)` compares versions with the index; an update whose tools or capabilities
grow (or whose tool goes from ask to read) is `needsConsent` (`ExtensionUpdate`, IPC
`extensions.updates`). `installFromGit(url)` clones with depth 1, no submodules and no prompts,
then loads the result as an unreviewed `git` extension (main asks natively, naming the URL, before
it clones; SEC-06); `loadFromFolder(dir)` loads a picked folder
in place (unreviewed, optional developer mode). Nothing runs before the user has seen the
manifest's tools and capabilities. Nothing of a folder or git extension runs before a second
native confirmation, the first time it is turned on ([extensions.md](extensions.md#registry-registryts)).

## Add custom (`custom-tools.ts`, `import-scan.ts`, `oauth.ts`)

All four routes end in one `CustomServer` record, stored through an injected
`CustomServerRepository` (also for project-saved ones, so oIDE knows their tool labels). Custom
servers and folder or git extensions carry the "not reviewed" badge.

| Route | Implementation |
| --- | --- |
| From a URL | `probeUrl(url)`: MCP SDK client over Streamable HTTP, falling back to SSE; returns transport, `serverInfo` ("Metrics API v2.3"), tools with annotations and a suggested risk. A 401 sets `needsAuth`. `CustomTools.authorize(id)` then runs the MCP authorization flow with the SDK's `auth()`: protected-resource metadata, authorization-server metadata, dynamic client registration (or a pasted client id, open question 13), PKCE in the system browser via the injected `openExternal`, loopback redirect on `127.0.0.1:<random port>/callback` with a state check. Tokens, client info and discovery state go to the SecretStore (`custom/<id>/oauth/*`). `setHeaderToken` is the header-secret fallback. |
| Found on this computer | `scanImports()` reads, read-only: Claude Desktop's `claude_desktop_config.json` (per-OS path), Claude Code's `~/.claude.json` (only top-level and per-project `mcpServers`), each open project's `.mcp.json`, `.vscode/mcp.json` and `.cursor/mcp.json`, VS Code's user `mcp.json` (JSONC), Cursor's and Windsurf's configs. Only the MCP servers key is kept; the rest of each file is dropped right after parsing, never logged, and parse errors carry no file content. Results hold env and header **names** only, mark already-added servers, and give a one-line `display`. `toPublic` masks secret-looking args
(`--api-key=…`, `--token <v>`, `API_KEY=…`, token-shaped values like `sk-…`/`ghp_…`), URL passwords
and every query value in `display`, `args` and `url` (SEC-24). `importSelected(items)` re-reads the files in main and moves env and header values straight to the SecretStore, so secrets never cross IPC. |
| Local command or JSON | `parseCommandLine`, `parsePastedJson` (standard `mcpServers` format); `probeCommand(cmd, args, env)` starts the server once over stdio, lists tools and kills it, only after a native confirmation in main that shows the exact command line and env names (SEC-04). |
| Extension from folder or git | `loadFromFolder` / `installFromGit` (above), developer mode on [extensions.md](extensions.md#developer-mode-dev-modets). |

Risk labels come from annotations (`riskFromAnnotations`): `readOnlyHint` → read; `destructiveHint`
or no hint → ask. The user can flip any label. A save that newly makes a tool `read` (pre-allowed)
asks natively first, naming the tools (SEC-15).

`CustomTools` takes a `confirm(req)` hook (`ConfirmRequest`: `probe`, `save` or `import`, with each
server's command line, env names or URL, and newly pre-allowed tools); the desktop wires it to
`confirmNative`. It asks before a probe, before a save that adds or changes a stdio command (one
dialog for a whole import), and before tools become pre-allowed. A confirmed probe covers saving the
same command within 15 minutes. Declining throws `ConfirmDeclinedError` (IPC `forbidden`).

`save(server, secrets)`: env values go to the SecretStore (`custom/<id>/env/<KEY>`), the record keeps
only `envKeys`. "Project .mcp.json" also merges the standard Claude Code entry into each chosen
project's `.mcp.json` (other entries and keys kept, atomic write) with `${KEY}` placeholders; oIDE
supplies the values as env at spawn (guess: relies on the CLI's env expansion in MCP config).
`remove` cleans the record, the `.mcp.json` entries and all secrets. Secrets follow what they were
entered for (SEC-09): a save that changes a stdio command deletes its stored env values (unless new
ones come in the same call), and one that moves a remote server to another origin deletes its OAuth
and header credentials. `authorize` and `setHeaderToken` bind credentials to the server's origin
(`custom/<id>/origin`), and `TokenSource` attaches nothing when that origin is missing or differs.

## Loopback proxy

`McpProxy` (`mcp-proxy.ts`) listens on `127.0.0.1:<port>` and serves `/mcp/<server>`. Per request it
requires a loopback peer, a `Host` of `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding),
no `Origin` or a loopback one, and the `x-oide-agent-secret` header matching a secret from
`issueAgentSecret(agentId, servers?)` (constant-time compare; optionally limited to some servers).
It strips the agent's own `authorization`, cookies and the secret, adds the server's auth headers
from `TokenSource` (header token, or OAuth bearer refreshed shortly before expiry), retries once
after a refresh on 401, and streams the response (JSON or SSE) back with `mcp-session-id`
intact. Tokens never leave main. `revokeAgent` when the agent ends.

Each agent's secret is issued with an empty server list, and `ExtensionsService.agentConfig` then
calls `setAgentServers(agentId, …)` with exactly the remote servers in that agent's config (SEC-10),
so an agent cannot reach another project's server through the proxy (403).

## Distribution defaults

All distribution names live in one module, `packages/protocol/src/distribution.ts`
(review-publication §3). Until the maintainer has claimed the names, no default points at them:

| Constant | Value | Used for |
| --- | --- | --- |
| `DEFAULT_MARKETPLACE_INDEX_URL` | `''` | Settings › Extensions › Marketplace index URL default: bundled index only, nothing fetched |
| `PLANNED_GITHUB_OWNER`, `PLANNED_MARKETPLACE_REPO` | `oide-dev`, `oide-marketplace` | docs and the owner checklist only; no runtime code builds a URL from them (a test checks the shipped sources) |
| `PLANNED_MARKETPLACE_INDEX_URL` | `https://raw.githubusercontent.com/oide-dev/oide-marketplace/main/index.json` | the value to configure once that repo exists |
| `builtinTarballUrl(name, version)` | `oide-builtin:<name>@<version>` | the "tarball" of built-in entries in `bundled/index.json`: never a download URL, never npm |

- **Setting a remote index** goes through `settings.update`, and main asks natively first
  (`confirmMarketplaceIndex` in `handlers/settings.ts`): https only, no `user:password@`, the dialog shows
  the origin in full. Declining keeps the old value (IPC `forbidden`); clearing needs no confirmation.
- **Built-ins** (`@oide/ext-*`) are `source: builtin` in the bundled index, with `oide-builtin:` URLs;
  `install()` refuses them, `checkUpdates()` skips them, and a remote index cannot override them. The
  npm scope `@oide` belongs to someone else ([open questions](open-questions.md) 15).
- **What the owner sets after claiming the names:** create `oide-dev/oide-marketplace` with an
  `index.json` validated by `tools/marketplace-index/validate.mjs`; then either ship a build whose
  default is `PLANNED_MARKETPLACE_INDEX_URL` (change `DEFAULT_MARKETPLACE_INDEX_URL`, keeping the native
  confirmation for any other URL) or tell users to paste it into Settings › Extensions. Once an npm scope
  is chosen, publish the built-ins under it only if they should also be installable outside the app;
  the bundled entries stay `builtin` either way.
- Tests: `packages/extension-host/test/installer.test.ts` (no fetch by default, getter, non-https,
  built-in override, shipped bundled index), `test/security/publication-defaults.test.ts` (no shipped
  source names the unclaimed org or scope, native confirmation, no release feed by default). The gate
  tests point the setting at a local `.invalid` index (`test/gates/marketplace.ts`).