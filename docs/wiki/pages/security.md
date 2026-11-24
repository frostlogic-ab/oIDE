# Security model (as implemented)

oIDE runs agents that execute shell commands, so the main risks are a malicious repo or extension
reaching the user's machine, and an agent going further than the user allowed. This page describes
what the code does today. Requirements: [build brief, Security](../raw/build-brief.md) and the hard
rules in [constraints](constraints.md). Where things live: [desktop-shell](desktop-shell.md),
[mcp-server](mcp-server.md), [extensions](extensions.md), [marketplace](marketplace.md),
[storage](storage.md), [git-worktrees](git-worktrees.md).

## Window hardening

- One `BrowserWindow`: `contextIsolation`, `sandbox`, `nodeIntegration: false` (also in workers and
  subframes), `webSecurity`, no `<webview>`, `app.enableSandbox()`.
- Every webContents refuses navigation away from the app and `window.open`; allow-listed `https` hosts
  open in the system browser (`security/external.ts`). Permissions are denied except
  `clipboard-sanitized-write`.
- CSP (`security/csp.ts`, injected as `<meta>` at build and as a header for the dev server):
  `script-src 'self'` (no inline, no eval), `object-src 'none'`, `base-uri 'none'`,
  `form-action 'none'`, `frame-src oide-artifact:` (artifact previews only).
- Electron fuses in packaged builds: `RunAsNode` off, `NODE_OPTIONS` and `--inspect` off, asar
  integrity, load only from asar (`electron-builder.yml`). `grantFileProtocolExtraPrivileges` stays
  on until the renderer moves to an `app://` protocol (accepted risk, SEC-25).
- WebRTC: every webContents uses `disable_non_proxied_udp`, so an artifact preview cannot leak data
  to a STUN/TURN host (CSP does not cover WebRTC).
- `githubusercontent.com` is not on the external-link allow-list (anyone can host there); hosts
  are `github.com`, `gitlab.com`, `bitbucket.org`, `claude.ai`, `anthropic.com`, `claude.com`,
  `npmjs.com`, `modelcontextprotocol.io`, `oide.dev` and project remotes added at runtime.

## Programs oIDE runs (Windows planting)

- `security/early-env.ts`, the first import of main, sets `NoDefaultCurrentDirectoryInExePath=1`, so
  no bare program name is looked up in the current folder by main or anything it starts (agents,
  extension hosts, MCP servers inherit it). `buildLaunch` also sets it in the agent env on Windows,
  covering the CLI's own git and shell spawns in the worktree.
- `git`, `gh` and `node` are resolved to absolute paths from PATH (`@oide/git` `resolveTool`,
  agent-core `findOnPath`/`nodeBinary`); relative and empty PATH entries are skipped. The terminal
  shell (`powershell.exe`) and `taskkill.exe` use absolute `%SystemRoot%` paths.

## IPC

- Preload exposes exactly `window.oide` (`invoke`, `on`, `platform`) and refuses names outside the contract.
- `IpcRouter` (main) Zod-validates every input against `packages/protocol/src/ipc.ts`, checks outputs
  against the contract, and refuses senders whose frame is not the app's own page (`forbidden`).
- Error codes cross IPC as `[code] message`: `invalid_input`, `not_found`, `forbidden`,
  `forbidden_path`, `conflict`, `unavailable`, `not_a_repo`, `git_failed`, `consent_required`,
  `install_failed`, `secure_storage_unavailable`, `internal`.

## Path guards

- `ctx.roots` (`AllowedRoots`) holds every folder the renderer may name: project folders (on open and
  at startup), agent worktrees (on create and on restore), the app-data artifact folder, userData.
- `files.*`, `terminal.create`, `shell.revealPath` resolve the path (`..`, symlinks via realpath of the
  longest existing prefix, case-insensitive on Windows/macOS) and require it inside an allowed root of
  the right kind; `files.*` also refuse anything inside `.git`, and the tree hides symlinks pointing
  out of the checkout.
- `terminal.create` takes no command (interactive shell only) and only a `project` or `worktree`
  root as cwd. The sign-in terminal (`cli.openSignIn`) is started by main itself.
- Paths that would be dangerous to take from the renderer are only accepted when the user picked
  them in a native dialog this session (`services.picked`): `artifacts.import({ filePath })`,
  `extensions.addFromFolder({ path })`, and `projects.open({ path })`, which also accepts an already
  known project. The integration harness (`h.allowOpen`) and unpackaged e2e builds
  (`OIDE_E2E_OPEN_PATHS`) have a test-only list (`Platform.openablePaths`); packaged builds have none.

## Artifact preview protocol

`oide-artifact://<artifact-id>/<file>` is a privileged standard scheme (`services/electron-platform.ts`).
`resolveArtifactUrl` (`services/core.ts`) serves only real files inside that artifact's folder:
`..` segments, `.versions/`, `artifact.json` (compared case-insensitively, trailing dots and spaces
ignored, checked again on the real path) and symlinks that resolve outside the folder answer 404.
Every response carries `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' 'self'; …;
connect-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'` (no network at all;
`'self'` so one artifact cannot load another's scripts), `nosniff` and
`no-store`. The renderer shows it in `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), so
the page has an opaque origin and no access to `window.oide`.

## Permission prompts

- The CLI calls `mcp__oide__permission_prompt` on oIDE's MCP server (127.0.0.1, per-agent URL and
  32-byte secret header, Host/Origin checks). The call blocks until the user answers.
- `agents.answerPermission` is accepted only for the exact pending request id of that agent
  (`not_found` otherwise). "Always in <project>" saves the suggested rule to `.oide/permissions.json`.
- An `updatedInput` in the answer is honoured only for Bash, and only its `command` field; every
  other tool runs with the input the agent sent.
- One agent may have at most 5 prompts open; more are denied at once.
- Edits to `.oide/`, `.claude/` and `.mcp.json` always ask: every agent gets
  `--settings {"permissions":{"ask":[Edit/Write/MultiEdit/NotebookEdit on **/.oide/**, **/.claude/**,
  **/.mcp.json]}}`, and allow rules that name those paths are dropped. Review marks changed files
  there and in `.gitattributes`/`.gitmodules` (`FileDiff.sensitive`) and warns before Merge. A Bash
  command the user allowed can still write them.
- On quit (`services.dispose` → `AgentsService.shutdown`) the MCP server is closed first, which denies
  every pending prompt, then agent processes are stopped; sessions stay resumable.

## Workspace trust

- First open of a repo shows a native dialog in main ("Trust project" / "Not now", default Not now).
  "Not now" stores the project untrusted; `projects.trust` changes it later. The renderer never needs
  its own trust prompt. E2E tests answer it with `OIDE_E2E_TRUST`, honoured only by unpackaged builds.
- Untrusted projects: `.oide/setup` never runs (checked in the WorktreeProvider's `runSetup`), allow
  rules in `.oide/permissions.json` are dropped (ask/deny still apply), `.oide/config.json` cannot set
  the default mode, project MCP servers (`.mcp.json` custom servers) are skipped, `.oide/extensions.json`
  cannot enable extensions, project techniques start off and stay in the first message.
- Untrusted projects, Claude Code itself: agents start with `--setting-sources user
  --strict-mcp-config` (`claude -p` skips the CLI's own trust dialog), so the repo's
  `.claude/settings.json` and `.claude/settings.local.json` (hooks, permissions, env,
  `apiKeyHelper`, plugins) and `.mcp.json` are not loaded; `--mcp-config` still lists oIDE's server
  and the extension and custom servers main allows. A CLI known to lack either flag refuses an
  untrusted spawn. CLAUDE.md, skills, agents and commands in the repo can still reach the agent as
  text. User-scope MCP servers from `~/.claude.json` are not loaded for untrusted projects either.
- Untrusted projects, git: oIDE's own git calls override every exec-capable key that the repo's
  local or worktree config sets (fsmonitor, hooks, ssh command, pager, editor, external diff and
  textconv, filters, merge drivers, gpg programs, credential helpers, upload/receive-pack, trailer
  commands, …) through `GIT_CONFIG_COUNT`, point `core.hooksPath` at an empty folder and turn signing
  off (`packages/git/src/git.ts`, `repoConfigOverrides`). Every call also gets
  `protocol.ext.allow=never`, and diff/log/show get `--no-ext-diff --no-textconv`. No file watcher
  and no background fetch run until the project is trusted. Trusted projects and their worktrees
  (main's `setRepoTrustResolver`) use their git config and hooks as they are.
- Untrusted projects, artifacts: repo artifacts (`.oide/artifacts/`) are not offered to agents
  through `artifacts_list`/`artifacts_read` until the project is trusted. An agent reaches only its
  own project's artifacts and project-less ones.
- Setup never runs in the user's own checkout (project-folder agents).

## Bypass mode

Refused at spawn and on mode change unless Settings > Allow Bypass is on, and always refused for
agents working in the project folder (supervisor, `buildLaunch` and the WorktreeProvider all check).
Only one agent at a time may hold the project folder (`conflict`).

## Secrets and MCP

- `SqliteSecretStore` over Electron `safeStorage`; when encryption is unavailable, writes are refused
  (`secure_storage_unavailable`) and a startup notice says so. Namespaces: `model:<id>`,
  `ext:<extension>/<key>`, `mcp:<server-id>/…` (the extension host's `extension/…` and `custom/…` keys
  are mapped onto these by `hostSecretAdapter`). Claude credentials have no slot and are never read.
- Custom model keys go in with `settings.saveCustomModel({ apiKey })` and never come back over IPC
  (`hasKey` only); they reach only that agent's process env. A key is bound to the origin of the
  base URL it was entered for (`model:<id>:origin`, `security/model-keys.ts`) and is used only
  while the model still points there; moving the model elsewhere (also through a raw
  `settings.update`) needs the key again.
- Each agent's mcp.json holds no secret: the oIDE server header is `${OIDE_MCP_HANDSHAKE}` and other
  header values (the proxy secret) become `${OIDE_MCP_HEADER_n}`; the values are only in that
  agent's env, and the CLI expands them (verified in the 2.1.325 binary: `--mcp-config` files are
  parsed with env expansion of url and headers). A process of the same OS user can still read
  another process's environment.
- Custom stdio MCP server env values stay in the keychain. A server whose env or args use them is
  started through `<app-data>/bin/oide-mcp-launch.cjs` (`packages/mcp-server/src/launcher.ts`): it
  fetches that one server's command, args and env from the oIDE MCP server with the agent's secret
  and a one-time nonce (fresh mcp.json on every launch), removes the agent secret from the child
  env and runs the server. So the values are in that server's process only, not in the `claude`
  env the Bash tool inherits. Without an absolute `node` on PATH, and for a project `.mcp.json`
  that the CLI reads itself, the values are still added to the agent env as `${VAR}` placeholders.
- Remote MCP servers with OAuth or header tokens go through the loopback proxy (127.0.0.1, per-agent
  secret issued once per agent, revoked when the agent is removed); tokens never leave main. An
  agent's secret opens only the remote servers in that agent's own config (others answer 403).
- Stored server credentials are bound to the origin they were entered for (`mcp:<id>/origin`): a
  `custom.save` that moves the URL to another origin deletes them, and the proxy's `TokenSource`
  attaches nothing when the origins differ. A changed stdio command drops its stored env values
  unless new ones come in the same call.

## Extensions and custom tools

- Marketplace installs: no install scripts, SRI-checked tarballs, safe extraction, manifest must
  match the index (see [marketplace](marketplace.md)). Updates that add tools or capabilities are
  refused without consent (`consent_required`).
- Host code runs in one Electron utility process per extension (`out/main/host-process.js`), only
  for extensions that are on somewhere, with an allow-listed env; secrets are scoped per extension.
  This is process separation, **not a sandbox**: the host has full Node (files, network, child
  processes) as the user. Declared `capabilities` are consent text only. Electron 45's
  utilityProcess accepts `--permission` in `execArgv` but does not enable Node's permission model
  (checked on 45.4.1), and the RunAsNode fuse is off, so there is no enforcing fallback yet.
- Folder extensions (unreviewed) only from a folder picked in the dialog; developer-mode reload only
  for those. Git extensions are cloned only after a native confirmation that names the URL.
- The first time a folder or git extension is turned on, main shows a native confirmation listing
  what will run (host code, MCP server and language server command lines). `.oide/extensions.json`
  never turns on a folder or git extension.
- An installed name cannot be replaced by an extension from another source (or another folder):
  uninstall first, which deletes its `ext:<name>/` secrets.
- Custom tools: `custom.probeCommand`, saving or importing a stdio server, and changing its command
  each need a native confirmation in main that shows the exact command line and env variable names.
  A probe confirmation covers saving that same command within 15 minutes.
- Tool risk labels: `read` tools pre-allowed, `ask` tools always prompt, turned-off tools disallowed;
  names normalized like the CLI does (verified, see [cli-integration](cli-integration.md)). Folder
  and git extensions' own `read` labels are ignored (their tools always ask). A custom server's tool
  becomes pre-allowed only after a native confirmation naming it.
- Native confirmations go through `security/confirm.ts` (`confirmNative`): Cancel is the default,
  plain Node answers no, and only unpackaged builds honour `OIDE_E2E_CONFIRM=accept|deny`.

## Custom model test ("Test connection")

`settings.testCustomModel` sends one minimal request (`POST <base>/v1/messages`, `max_tokens: 1`) to
that third-party endpoint only: hosts under `anthropic.com`, `claude.ai` or `claude.com` are refused
(no direct calls to Anthropic's API on the user's plan), plain http only for localhost, no
redirects, 15 s timeout. Bedrock and Vertex are not tested (oIDE does not read cloud credentials).

## Settings that run programs

`settings.update` asks through `confirmNative`, showing the exact value, before it sets a
non-empty `claude.cliPath` (`cli.detect` runs it at once) unless that path was picked in
`dialog.pickFile` this session, and before it changes `claude.extraFlags`. Extra flags can never set
what oIDE controls or what would undo its isolation (`RESERVED_FLAGS` in agent-core: settings
sources, `--settings`, MCP config, `--add-dir`, plugins, tool lists, permission flags, system
prompt, `--safe-mode`/`--restricted`/`--bare`), whatever their spelling or number of values.

## Agent environment and sign-in

- Agent env is built from an allow-list (`ENV_ALLOW_LIST` in agent-core) plus `OIDE_AGENT_ID`, custom
  model env, the agent's own MCP header values and any leftover MCP placeholder values (see
  above), and `NoDefaultCurrentDirectoryInExePath=1` on Windows. Electron/Node variables are not passed.
- Sign-in is only through Anthropic's flow: `cli.openSignIn` opens a terminal running the user's
  `claude`. `test/no-credentials.test.ts` fails the build if credential paths appear in code.
