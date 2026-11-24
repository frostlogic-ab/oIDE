# Marketplace

The v1 marketplace is a static index plus npm tarballs; Add custom brings in anything else. The
UI is the Marketplace screen ([screen-marketplace.md](screen-marketplace.md),
[raw design](../raw/design/Marketplace.dc.html)); extension internals are on
[extensions.md](extensions.md).

## Index

- `index.json` in the public `oide-dev/oide-marketplace` repo, shape `MarketplaceIndex`
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

`MarketplaceInstaller.getIndex()` uses the disk cache (`<cacheDir>/index.json`) when younger than
a day, otherwise fetches `indexUrl` (default
`https://raw.githubusercontent.com/oide-dev/oide-marketplace/main/index.json`); offline it falls
back to the cache, then the bundled index.

`install(name, version?)`:

1. Pick the exact version, or the newest whose `engine` fits this oIDE. Built-in entries are refused.
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
then loads the result as an unreviewed `git` extension; `loadFromFolder(dir)` loads a picked folder
in place (unreviewed, optional developer mode). Nothing runs before the user has seen the
manifest's tools and capabilities.

## Add custom (`custom-tools.ts`, `import-scan.ts`, `oauth.ts`)

All four routes end in one `CustomServer` record, stored through an injected
`CustomServerRepository` (also for project-saved ones, so oIDE knows their tool labels). Custom
servers and folder or git extensions carry the "not reviewed" badge.

| Route | Implementation |
| --- | --- |
| From a URL | `probeUrl(url)`: MCP SDK client over Streamable HTTP, falling back to SSE; returns transport, `serverInfo` ("Metrics API v2.3"), tools with annotations and a suggested risk. A 401 sets `needsAuth`. `CustomTools.authorize(id)` then runs the MCP authorization flow with the SDK's `auth()`: protected-resource metadata, authorization-server metadata, dynamic client registration (or a pasted client id, open question 13), PKCE in the system browser via the injected `openExternal`, loopback redirect on `127.0.0.1:<random port>/callback` with a state check. Tokens, client info and discovery state go to the SecretStore (`custom/<id>/oauth/*`). `setHeaderToken` is the header-secret fallback. |
| Found on this computer | `scanImports()` reads, read-only: Claude Desktop's `claude_desktop_config.json` (per-OS path), Claude Code's `~/.claude.json` (only top-level and per-project `mcpServers`), each open project's `.mcp.json`, `.vscode/mcp.json` and `.cursor/mcp.json`, VS Code's user `mcp.json` (JSONC), Cursor's and Windsurf's configs. Only the MCP servers key is kept; the rest of each file is dropped right after parsing, never logged, and parse errors carry no file content. Results hold env and header **names** only, mark already-added servers, and give a one-line `display`. `importSelected(items)` re-reads the files in main and moves env and header values straight to the SecretStore, so secrets never cross IPC. |
| Local command or JSON | `parseCommandLine`, `parsePastedJson` (standard `mcpServers` format); `probeCommand(cmd, args, env)` starts the server once over stdio, lists tools and kills it. |
| Extension from folder or git | `loadFromFolder` / `installFromGit` (above), developer mode on [extensions.md](extensions.md#developer-mode-dev-modets). |

Risk labels come from annotations (`riskFromAnnotations`): `readOnlyHint` → read; `destructiveHint`
or no hint → ask. The user can flip any label.

`save(server, secrets)`: env values go to the SecretStore (`custom/<id>/env/<KEY>`), the record keeps
only `envKeys`. "Project .mcp.json" also merges the standard Claude Code entry into each chosen
project's `.mcp.json` (other entries and keys kept, atomic write) with `${KEY}` placeholders; oIDE
supplies the values as env at spawn (guess: relies on the CLI's env expansion in MCP config).
`remove` cleans the record, the `.mcp.json` entries and all secrets.

## Loopback proxy

`McpProxy` (`mcp-proxy.ts`) listens on `127.0.0.1:<port>` and serves `/mcp/<server>`. Per request it
requires a loopback peer, a `Host` of `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding),
no `Origin` or a loopback one, and the `x-oide-agent-secret` header matching a secret from
`issueAgentSecret(agentId, servers?)` (constant-time compare; optionally limited to some servers).
It strips the agent's own `authorization`, cookies and the secret, adds the server's auth headers
from `TokenSource` (header token, or OAuth bearer refreshed shortly before expiry), retries once
after a refresh on 401, and streams the response (JSON or SSE) back with `mcp-session-id`
intact. Tokens never leave main. `revokeAgent` when the agent ends.
