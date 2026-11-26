# Extension author guide

An oIDE extension is an **npm package with an `oide` manifest** in its `package.json`. Its main
job is to give agents new tools through [MCP](https://modelcontextprotocol.io) servers. It can also
add commands to the command bar (Ctrl/Cmd+K), settings (including secrets kept in the OS keychain),
panels, themes, techniques, artifact types and deploy targets (language servers can be declared but
are not started yet).

oIDE's own Git, Browser preview and Accent themes features ship as extensions
([`extensions/`](https://github.com/frostlogic-ab/oIDE/tree/main/extensions) in the repo), so the API is
used by oIDE itself.

## The parts of an extension

| Part | Declared in | Runs where |
| --- | --- | --- |
| MCP servers (agent tools) | `oide.mcpServers` | A stdio process the agent's `claude` CLI starts, listed in the agent's `--mcp-config` |
| Host code | `oide.main` | A separate Node process per extension (an Electron utility process), started on an activation event |
| Commands | `oide.contributes.commands` | Handled by your host code; listed in Ctrl/Cmd+K |
| Settings | `oide.contributes.settings` | Read and written by your host code; `secret` ones live in the OS keychain |
| Panels | `oide.contributes.panels` | An HTML page in a sandboxed iframe, talking to host code through `postMessage` |
| Themes, techniques, deploy targets, artifact types | `oide.contributes.*` | Settings › Appearance, Spawn, Review and Artifacts; see [what is wired](#what-works-today) |
| Languages | `oide.contributes.languages` | Parsed and shown in the consent dialog; not started in v1 |

An extension with only MCP servers needs no host code at all. That is the most common and most
useful kind.

## What works today

oIDE is pre-1.0 and the extension API is at version `1.0.0`. Honest status:

| Feature | Status |
| --- | --- |
| Manifest loading and validation, path checks, engine check | Built |
| MCP servers and tools with risk labels, per-project and per-tool enablement | Built |
| Host code (`activate` / `deactivate`), separate process per extension, crash restarts | Built |
| Commands in Ctrl/Cmd+K, run in host code | Built |
| `ctx.settings` (plain and secret), `ctx.agents`, `ctx.artifacts.read`, `ctx.log` | Built |
| Marketplace index, integrity-checked install, update consent | Built |
| Add from folder or git, developer mode | Built |
| Panels in a sandboxed `oide-ext://` iframe: a Focus inspector tab or a full screen, with `ctx.panels.open` / `postMessage` / `onMessage` | Built |
| Contributed settings in **Settings › Extensions** (secrets as password fields, kept in the OS keychain) | Built |
| `themes` (Settings › Appearance), `techniques` (Spawn › Advanced techniques), `deployTargets` (Review), `artifactTypes` (Artifacts › Open) | Built |
| `languages` (language servers for the Files editor) | Parsed and validated, **not started** in v1 (ADR 0008) |
| Capability enforcement | **Not enforced**: declared for consent only (see [Capabilities](/extensions/capabilities)) |
| `@oide/extension-api` on npm | **Not published.** The npm scope `@oide` belongs to an unrelated maintainer, so the package will be published under a different scope (an open question). Until then, copy the types or depend on the repo; see [Host API](/extensions/api#getting-the-types) |

Build against what is marked built. The rest is part of the v1 contract and will be wired without
manifest changes.

## Pages

1. [Your first extension](/extensions/first-extension): a complete, minimal extension with one tool and one command.
2. [Manifest reference](/extensions/manifest): every field.
3. [Host API](/extensions/api): `activate(ctx)` and everything on `ctx`.
4. [MCP tools and risk labels](/extensions/tools-and-risk): how your tools reach agents and when they prompt.
5. [Commands, panels and settings](/extensions/contributions).
6. [Capabilities and consent](/extensions/capabilities): what users see before your code runs.
7. [Developing and testing](/extensions/developing): Add from folder, developer mode.
8. [Packaging and publishing](/extensions/publishing): npm, the marketplace index and its checks.

Internals: [extensions](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/extensions.md) and
[marketplace](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/marketplace.md) in the wiki.
