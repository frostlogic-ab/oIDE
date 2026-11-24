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
  integrity, load only from asar (`electron-builder.yml`).

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
- Paths that would be dangerous to take from the renderer are only accepted when the user picked
  them in a native dialog this session (`services.picked`): `artifacts.import({ filePath })` and
  `extensions.addFromFolder({ path })`.

## Artifact preview protocol

`oide-artifact://<artifact-id>/<file>` is a privileged standard scheme (`services/electron-platform.ts`).
`resolveArtifactUrl` (`services/core.ts`) serves only real files inside that artifact's folder:
`..` segments, `.versions/`, `artifact.json` and symlinks that resolve outside the folder answer 404.
Every response carries `Content-Security-Policy: default-src 'none'; script-src 'unsafe-inline' oide-artifact:; …;
connect-src 'none'; frame-src 'none'; form-action 'none'` (no network at all), `nosniff` and
`no-store`. The renderer shows it in `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), so
the page has an opaque origin and no access to `window.oide`.

## Permission prompts

- The CLI calls `mcp__oide__permission_prompt` on oIDE's MCP server (127.0.0.1, per-agent URL and
  32-byte secret header, Host/Origin checks). The call blocks until the user answers.
- `agents.answerPermission` is accepted only for the exact pending request id of that agent
  (`not_found` otherwise). "Always in <project>" saves the suggested rule to `.oide/permissions.json`.
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
  (`hasKey` only); they reach only that agent's process env.
- Custom stdio MCP server env values stay in the keychain; mcp.json has `${OIDE_MCP_<SERVER>_<KEY>}`
  placeholders and the values are added to that agent's env at spawn (`SettingsProvider.extraEnv`).
- Remote MCP servers with OAuth or header tokens go through the loopback proxy (127.0.0.1, per-agent
  secret issued once per agent, revoked when the agent is removed); tokens never leave main.

## Extensions and custom tools

- Marketplace installs: no install scripts, SRI-checked tarballs, safe extraction, manifest must
  match the index (see [marketplace](marketplace.md)). Updates that add tools or capabilities are
  refused without consent (`consent_required`).
- Host code runs in one Electron utility process per extension (`out/main/host-process.js`), only
  for extensions that are on somewhere, with an allow-listed env; secrets are scoped per extension.
- Folder extensions (unreviewed) only from a folder picked in the dialog; developer-mode reload only
  for those.
- Tool risk labels: `read` tools pre-allowed, `ask` tools always prompt, turned-off tools disallowed;
  names normalized like the CLI does (verified, see [cli-integration](cli-integration.md)).

## Custom model test ("Test connection")

`settings.testCustomModel` sends one minimal request (`POST <base>/v1/messages`, `max_tokens: 1`) to
that third-party endpoint only: hosts under `anthropic.com` or `claude.ai` are refused (no direct calls
to Anthropic's API on the user's plan), plain http only for localhost, no redirects, 15 s timeout.
Bedrock and Vertex are not tested (oIDE does not read cloud credentials).

## Agent environment and sign-in

- Agent env is built from an allow-list (`ENV_ALLOW_LIST` in agent-core) plus `OIDE_AGENT_ID`, custom
  model env and MCP placeholder values. Electron/Node variables are not passed.
- Sign-in is only through Anthropic's flow: `cli.openSignIn` opens a terminal running the user's
  `claude`. `test/no-credentials.test.ts` fails the build if credential paths appear in code.
