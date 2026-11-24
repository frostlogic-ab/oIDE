# Security review (2026-11-24)

An adversarial review of oIDE as it is in the tree on 2026-11-24, done before the open-source
release. It tested five attackers: a malicious repo the user opens, a compromised renderer, a
prompt-injected agent, a malicious extension, marketplace index or custom MCP server, and code
that targets credentials and the hard rules. The claimed model is in [security](security.md). The
requirements are in [build brief, Security](../raw/build-brief.md) and [constraints](constraints.md).
No product code was changed. The proof-of-concept tests are in `test/security/*.test.ts`. Each test
asserts the secure behaviour and is marked `it.fails` while the gap is open, so the suite stays
green. Once a fix lands, change `it.fails` to `it` in its test.

Run them from a cwd on an uppercase drive letter (a lowercase `c:\` breaks vitest):
`Set-Location 'C:\…\oide'; node node_modules/vitest/vitest.mjs run test/security`.

**Counts:** 2 critical, 5 high, 9 medium, 11 low. `pnpm audit --prod` reports no known
vulnerabilities.

## Critical

### SEC-01 A repo can plant `git.exe`, `gh.exe` or `node.exe` and run it on Windows

- **Attack:** the user clones a repo with `git.exe` (or `git.com`) at its root and opens it. On
  Windows, Node/libuv looks for a bare command name in the child's `cwd` before it searches `PATH`.
  It skips the `cwd` only when `NoDefaultCurrentDirectoryInExePath` is set, and on a normal machine
  it is not. `projects.open` runs `git rev-parse` with `cwd` set to the chosen folder, so the
  attacker's binary runs as the user before the trust dialog appears. Every later git call (status
  watcher, background fetch, diff, merge) runs it again. The same applies to `gh` (PR state and
  Open PR run in the worktree) and to `node`. `node` is spawned bare in the agent's worktree when
  `claude` is an npm `.cmd` shim and the system prompt has newlines, which is the normal Windows
  npm install.
- **Evidence:** `packages/git/src/git.ts:92` (`gitBinary ?? 'git'`) and `:108-112` (`execFile`
  with the repo as `cwd`); `packages/git/src/gh.ts:279` (`'gh'`) and `:285-289`;
  `packages/agent-core/src/cli.ts:47` and `packages/agent-core/src/args.ts:350` (`'node'`);
  `packages/agent-core/src/driver.ts:141-143` (agent spawn with `cwd: worktree`);
  `apps/desktop/src/main/services/projects.ts:66-67` (git runs before `confirmTrust`).
  Confirmed on this machine with Node 24.11.1 and Git 2.51: a copy of `hostname.exe` named
  `git.exe` in the cwd ran instead of git.
- **PoC:** `test/security/windows-cwd-binary.test.ts` (SEC-01).
- **Fix:** (1) At the very top of `apps/desktop/src/main/index.ts`, set
  `process.env.NoDefaultCurrentDirectoryInExePath = '1'`. Add it to the agent env in
  `ENV_ALLOW_LIST`, or set it in `buildLaunch`, so the CLI's own git and tool spawns are covered
  too. (2) Resolve `git`, `gh` and `node` to absolute paths once at startup with `findOnPath`, and
  have `findOnPath` skip relative or empty `PATH` entries. Make that resolved path the default for
  `GitOptions.gitBinary`, `GhCli` and `cliCommand`/`resolveSpawn`, and never spawn a bare name with
  a repo as cwd.
- **Status:** **fixed.** `apps/desktop/src/main/security/early-env.ts` (first import of
  `index.ts`) sets `NoDefaultCurrentDirectoryInExePath=1`, and `buildLaunch` sets it in the agent
  env on Windows. New `packages/git/src/bin.ts` (`findExecutable`, `resolveTool`) resolves `git`
  and `gh` to absolute paths and skips relative or empty PATH entries; it is the default of
  `Git` and `GhCli`. agent-core `findOnPath` (now in `args.ts`) skips relative entries,
  `cliCommand` resolves a bare CLI name, and `nodeBinary()` replaces the bare `node` in
  `cliCommand`/`resolveSpawn`. `powershell.exe` (terminals) and `taskkill.exe` (driver) are
  absolute. Files: `packages/git/src/{bin,git,gh,index}.ts`, `packages/agent-core/src/{args,cli,driver}.ts`,
  `apps/desktop/src/main/{index.ts,security/early-env.ts,services/terminals.ts}`. PoC flipped.

### SEC-02 Untrusted projects still get their `.claude/settings.json` hooks and `.mcp.json` servers run

- **Attack:** oIDE's workspace trust only filters `.oide/*` and oIDE's own list of `.mcp.json`
  custom servers. The agent is the real `claude -p` running inside a checkout of the repo, and the
  CLI's help says `-p` **skips the CLI's own workspace trust dialog**
  ([raw CLI help](../raw/claude-cli-help-2.1.325.txt), `-p`). On the first agent spawn in an
  untrusted project, the CLI honours whatever the repo commits:
  - a SessionStart or PreToolUse hook in `.claude/settings.json`, which runs any command;
  - `permissions.allow: ["Bash"]`;
  - `apiKeyHelper` and `env`;
  - `enableAllProjectMcpServers: true`, which starts every stdio server in `.mcp.json`.

  The trust dialog's text ("Untrusted projects ignore all three") is therefore false.
- **Evidence:** `packages/agent-core/src/args.ts:358-440` (`buildLaunch`) never passes
  `--setting-sources` or `--strict-mcp-config`. `apps/desktop/src/main/services/electron-platform.ts:41-43`
  holds the promise in the dialog text.
- **PoC:** `test/security/untrusted-cli-settings.test.ts` (SEC-02).
- **Fix:** when `ctx.trusted === false`, pass `--setting-sources user` and `--strict-mcp-config`
  (oIDE's `--mcp-config` already lists every server the agent should get). Against the pinned CLI,
  check whether project skills, agents, commands and plugins (`.claude/skills`, `.claude/agents`,
  `enabledPlugins`) are still loaded. Add them to the dialog text, or use a stricter mode for
  untrusted repos. Add `--setting-sources` and `--strict-mcp-config` to `RESERVED_FLAGS` (see
  SEC-27). Update the trust dialog and [security](security.md).
- **Status:** **fixed.** Untrusted projects launch with `--setting-sources user
  --strict-mcp-config` (both in the pinned 2.1.325 help; detected as features, and a CLI known to
  lack them refuses an untrusted spawn). `--mcp-config` still carries oIDE's own server and the
  extension and custom servers main allows for the agent. Both flags are reserved (SEC-27). The trust
  dialog text now says what untrusted means, including the residual: CLAUDE.md, skills, agents and
  commands in the repo can still reach the agent as text (they are prompts, not settings; hooks,
  permissions, env, `apiKeyHelper` and plugins come only from settings and are off). Files:
  `packages/agent-core/src/{args,cli}.ts`, `services/electron-platform.ts`. PoC flipped.

## High

### SEC-03 A repo's own git config runs code through oIDE's git calls, trusted or not

- **Attack:** oIDE runs git on every opened project with no regard to trust:
  - the status watcher, right after open (`services/core.ts:126-127`);
  - the background fetch every N minutes (`services/git.ts:357-363`);
  - diff, commit and merge.

  A project that arrives with its `.git` folder can set exec-capable config and get code run by
  oIDE itself. Such projects include a zip or tarball someone sends, a shared drive, a USB copy, or
  a nested bare repo inside a clone. The config keys include `core.fsmonitor` (run on every
  `status`), `core.hooksPath` (oIDE runs `commit` and `merge`), `diff.external`,
  `core.sshCommand`, `gpg.program` with `commit.gpgsign`, filter drivers, `protocol.ext.allow`
  with an `ext::` remote, and `credential.helper`.
- **Evidence:** `packages/git/src/git.ts:66-70` (`baseConfigArgs` only sets display options).
- **PoC:** `test/security/git-config-exec.test.ts` (SEC-03: `core.fsmonitor` writes a marker
  file during `status()`).
- **Fix:** for every git call, or at least for projects that are not trusted, add
  `-c core.fsmonitor=false -c core.hooksPath=<empty oIDE dir> -c diff.external= -c core.sshCommand=
  -c credential.helper= -c protocol.ext.allow=never -c gpg.program=… --no-ext-diff`.
  `commit`/`merge` can take `--no-verify`, and setting `GIT_CONFIG_NOSYSTEM` is not enough on its
  own. Better: until a project is trusted, do no git work beyond `rev-parse`, and run no background
  fetch. Show git's `safe.directory` warning when it fires.
- **Status:** **fixed.** `Git.run` treats a checkout as untrusted unless main's trust
  resolver (`setRepoTrustResolver`, set in `services/core.ts`: trusted projects and their
  worktrees) says otherwise. Untrusted: it lists `git config --show-scope` and overrides every
  exec-capable key from local/worktree scope (fsmonitor, hooksPath, sshCommand, askPass, gitProxy,
  pager, editor, diff.external and drivers, filter clean/smudge/process, merge drivers, gpg
  programs, credential helpers, uploadpack/receivepack, trailer commands,
  alternateRefsCommand, submodule update), always sets an empty `core.hooksPath` and turns
  signing off. Overrides go through `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n`, so a subsection with
  `=` cannot dodge them. Every call gets `protocol.ext.allow=never` and `log.showSignature=false`,
  and diff/log/show get `--no-ext-diff --no-textconv`. No watcher and no background fetch until a
  project is trusted (watchers start on trust). Trusted projects keep their own config and hooks
  (said in the trust dialog). Not done: surfacing git's `safe.directory` warning. Files:
  `packages/git/src/git.ts`, `services/{core,git,agents}.ts`. PoC flipped.

### SEC-04 `custom.probeCommand` runs any command line the renderer sends

- **Attack:** a compromised renderer, for example through XSS, calls
  `custom.probeCommand({ command, args, env })` and main spawns it at once. This is RCE with no
  user interaction, flagged by the commit scanner.
- **Evidence:** `apps/desktop/src/main/handlers/extensions.ts:45`;
  `packages/extension-host/src/custom-tools.ts:154-157`.
- **PoC:** `test/security/renderer-ipc-reach.test.ts`, test "custom.probeCommand does not run an
  arbitrary renderer-supplied command".
- **Fix:** before spawning, show a native `dialog.showMessageBox` in main with the exact command
  line, args and env names ("Run this command to list its tools?", default Cancel). Or probe only a
  record the user already confirmed in main. Do not trust a renderer-side confirm.
- **Status:** **fixed.** `CustomTools.probeCommand` asks through `confirmNative`
  (`apps/desktop/src/main/security/confirm.ts`, Cancel default) with the exact command line and
  env names before spawning; declining is `forbidden`. A confirmed probe covers saving the same
  command within 15 minutes. PoC flipped to `it`; more cases in `test/security/extension-confirm.test.ts`.

### SEC-05 `terminal.create` takes a free-form `command`, and any registered root (including userData) as cwd

- **Attack:** the renderer never uses `command`. The only command-running terminal is
  `cli.openSignIn`, which calls the service directly. A compromised renderer can still run
  `terminal.create({ cwd: <userData>, command: '…' })`, because `assertAllowed(cwd)` accepts every
  root kind, including `app-data`.
- **Evidence:** `apps/desktop/src/main/handlers/terminal.ts:118-121`;
  `packages/protocol/src/ipc.ts:92`; `apps/desktop/src/main/index.ts:95` (userData registered as
  `app-data`).
- **PoC:** `test/security/renderer-ipc-reach.test.ts`, test "terminal.create refuses a
  renderer-chosen command line in the app-data folder".
- **Fix:** drop `command` from the IPC contract (keep it in the service for `cli.openSignIn`), and
  call `assertAllowed(cwd, ['project', 'worktree'])`. An interactive shell is still a big
  capability, so keep SEC-06 and SEC-07 tight as well.
- **Status:** **fixed.** `command` is gone from the IPC contract (`z.strictObject`), the
  sign-in terminal still calls the service from main, and `terminal.create` accepts only
  `project`/`worktree` roots. Files: `packages/protocol/src/ipc.ts`, `handlers/terminal.ts`. PoC
  flipped; `test/security/core-fixes.test.ts` checks app-data is refused.

### SEC-06 `extensions.addFromGit` clones and registers unreviewed code with no confirmation in main

- **Attack:** the renderer sends any `https://` or `ssh` URL. Main clones it into app-data and
  registers it, and `extensions.setEnabled` then starts its host code in a full-Node utility
  process (see SEC-14). That is two IPC calls to RCE. This rule is unlike `addFromFolder`'s
  picked-path rule. Flagged by the commit scanner.
- **Evidence:** `apps/desktop/src/main/handlers/extensions.ts:37`;
  `packages/extension-host/src/installer.ts:216-234`;
  `apps/desktop/src/main/services/extensions.ts:189-197` (host starts when enabled).
- **Fix:** before cloning, show a native confirmation in main that names the URL and says
  "unreviewed code". Require a second native confirmation the first time an unreviewed
  (`folder`/`git`) extension with `main` or stdio servers is enabled.
- **Status:** **fixed.** `ExtensionsService.addFromGit` asks natively, naming the URL, before it
  clones. The first `setEnabled(true)` of any folder or git extension asks natively and lists the
  host code, MCP server and language server command lines (kept per extension and folder). Tests in
  `test/security/extension-confirm.test.ts`.

### SEC-07 Other renderer-to-exec paths with no confirmation in main

- **Attack:** the following are each RCE for a compromised renderer:
  - `custom.save` with a stdio `transport.command`, which every later agent launches as an MCP
    server;
  - `settings.update({ claude: { cliPath } })`, which `cli.detect` executes at once
    (`services/cli.ts:207-213`, `agent-core/src/cli.ts:174`);
  - `settings.update({ claude: { extraFlags } })`, for example `--settings`/`--add-dir` (see
    SEC-27);
  - `extensions.setEnabled` on a folder extension.
- **Evidence:** `apps/desktop/src/main/handlers/extensions.ts:53`; `handlers/settings.ts:64-70`.
- **Fix:** for any setting that names an executable or an exec-capable server (cliPath, stdio
  custom servers, extra flags, enabling unreviewed extensions with code), show a native
  confirmation in main. Or accept `cliPath` only from `dialog.pickFile`, the same way as the
  `services.picked` rule.
- **Status (extensions and custom tools):** **fixed.** `custom.save` and `custom.importSelected`
  ask natively before a stdio command is added or changed (exact command line, env names; one
  dialog per import), and enabling a folder or git extension asks as in SEC-06. Tests in
  `test/security/extension-confirm.test.ts`. The settings rows (`cliPath`, `extraFlags`) belong to
  the core fix.
- **Status (settings):** **fixed.** `settings.update` asks through `confirmNative`, showing
  the exact value, before it sets a non-empty `claude.cliPath` (unless the path was picked in
  `dialog.pickFile` this session) or changed `claude.extraFlags`; Cancel leaves Settings as they
  were (`forbidden`). Clearing needs no confirmation. Files: `handlers/settings.ts`. Tests:
  `test/security/core-fixes.test.ts`.

## Medium

### SEC-08 `projects.open({ path })` accepts any path, which widens the file-access roots

- **Attack:** the renderer names any git folder that was never picked in a dialog, for example a
  home folder kept in git or another repo with secrets. Main runs git there, which SEC-01 and
  SEC-03 make worse, and adds it to `ctx.roots`. After that, `files.read`, `files.write` and
  `terminal.create` reach it. Flagged by the commit scanner.
- **Evidence:** `apps/desktop/src/main/handlers/projects.ts:126`;
  `apps/desktop/src/main/services/projects.ts:61-78`.
- **PoC:** `test/security/renderer-ipc-reach.test.ts`, test "projects.open refuses an explicit
  path…".
- **Fix:** accept an explicit `path` only if `services.picked` has it, the path is already a known
  project, or it arrived through a main-side drop or second-instance path. Today
  `test/integration/*` opens repos by path, so add a test-only platform hook that marks those
  paths as picked.
- **Status:** **fixed.** `ProjectsService.open` accepts an explicit path only when it is in
  `services.picked`, is already a known project, or is listed in `Platform.openablePaths`, a test
  hook set only by the integration harness (`h.allowOpen`) and, in unpackaged builds only, by
  `OIDE_E2E_OPEN_PATHS`. Otherwise `forbidden_path`, before any git runs. Files:
  `services/{projects,platform,electron-platform,core}.ts`, `test/integration/harness.ts`. PoC
  flipped.

### SEC-09 Stored secrets follow a record when its URL is changed, so keys can be exfiltrated

- **Attack:**
  - **Custom model key:** a compromised renderer calls `settings.saveCustomModel` with the same
    `id`, a new `baseUrl` and no `apiKey`. The stored key is kept. `settings.testCustomModel`, or
    any agent spawn, then sends it to the new host. That breaks "keys never leave main except to
    that agent".
  - **Custom server tokens:** the same happens for custom servers. `custom.save` with a changed
    `transport.url` keeps the `mcp:<id>/…` OAuth and header tokens, and the loopback proxy forwards
    them to the new upstream.
- **Evidence:** `apps/desktop/src/main/handlers/settings.ts:86-97`;
  `packages/extension-host/src/custom-tools.ts:321-345`;
  `packages/extension-host/src/mcp-proxy.ts:153-160`.
- **PoC:** `test/security/renderer-ipc-reach.test.ts`, test "settings.testCustomModel does not send
  a stored key to a changed base URL".
- **Fix:** bind each secret to the origin it was entered for. Store `origin` next to the key, and
  when `baseUrl` or `transport.url` changes origin, delete the secret unless a new one comes in the
  same call. `TokenSource` should refuse to attach a token whose stored origin differs from the
  upstream.
- **Status (custom server tokens):** **fixed.** `authorize` and `setHeaderToken` bind credentials
  to the server's origin (`mcp:<id>/origin`); a `custom.save` that moves `transport.url` to another
  origin deletes the OAuth and header credentials; `TokenSource` attaches nothing (and does not
  refresh) when the bound origin is missing or differs. A changed stdio command also drops its stored
  env values unless new ones come in the call. Tests: `packages/extension-host/test/oauth.test.ts`
  ("SEC-09") and `test/security/extension-confirm.test.ts`. The custom model key row belongs to the
  core fix.
- **Status (custom model key):** **fixed.** New `security/model-keys.ts`: the key is stored
  with the origin of the base URL (`model:<id>:origin`) and handed out (Test connection, agent env,
  `hasKey`) only while the model still has that origin, whether the URL changed through
  `saveCustomModel` or a raw `settings.update`. `saveCustomModel` with a new origin and no key
  deletes the old key. Keys saved before this change must be entered again. Files:
  `handlers/settings.ts`, `services/agents.ts`, `security/model-keys.ts`. PoC flipped.

### SEC-10 One agent's proxy secret opens every remote MCP server, including other projects' servers

- **Attack:** an agent in project A, possibly untrusted, reads its own
  `<app-data>/agents/<id>/mcp.json`. It then calls `http://127.0.0.1:<proxy>/mcp/<server-of-B>`
  and gets project B's OAuth tokens applied to its requests.
- **Evidence:** `apps/desktop/src/main/services/extensions.ts:320-323` calls
  `issueAgentSecret(agentId)` with no server list, so `grant.servers` is `null` and
  `packages/extension-host/src/mcp-proxy.ts:139` lets every server through.
- **Fix:** `issueAgentSecret(agentId, Object.keys(<http servers in this agent's cfg>))`, and
  re-issue when the config changes.
- **Status:** **fixed.** The agent secret is issued with an empty server list, and every
  `agentConfig` call sets it to exactly the proxied remote servers in that agent's config
  (`McpProxy.setAgentServers`); other servers answer 403. Test in
  `test/security/extension-confirm.test.ts`.

### SEC-11 Every custom stdio server's secret values sit in the agent's own environment

- **Attack:** `extraEnv` puts `OIDE_MCP_<SERVER>_<KEY>` values for every server that applies to
  the project into the `claude` process env. The Bash tool, and every MCP server the agent starts,
  inherit it, so a prompt-injected agent can `env | curl`.
- **Evidence:** `packages/agent-core/src/args.ts:445-446`;
  `packages/extension-host/src/mcp-config.ts:166-179`;
  `apps/desktop/src/main/services/agents.ts:251`.
- **Fix:** do not put server secrets into the agent env. Launch secret-bearing stdio servers through
  a tiny oIDE launcher, for example `node <oide>/mcp-launch.js <serverId> <nonce>`, which gets the
  env for that server only from main over the authenticated loopback channel and then `exec`s the
  real command. Or run them behind the loopback proxy. At the very least, include only the servers
  this agent actually gets.
- **Status:** **fixed** (residual below). A custom stdio server whose env or args use a
  secret placeholder is written into mcp.json as `node <app-data>/bin/oide-mcp-launch.cjs
  <url> <nonce>`; the launcher (`packages/mcp-server/src/launcher.ts`) fetches that one server's
  real command, args and env from the oIDE MCP server (agent secret + one-time nonce, fresh mcp.json
  on every launch), drops the agent secret from the child env and runs it. Secret values are no
  longer in the `claude` env or on disk. Residual: values for a project `.mcp.json` (read by the
  CLI itself) stay in the agent env, and with no absolute `node` on PATH the old env placeholders
  are used. Files: `packages/mcp-server/src/{launcher,server,types}.ts`,
  `packages/agent-core/src/{supervisor,ports}.ts`, `services/core.ts`. Test:
  `packages/mcp-server/src/server.test.ts`.

### SEC-12 An agent can widen its own permissions through `.oide/` and `.claude/` in trusted projects

- **Attack:**
  - **Writing the files directly:** an agent in the project folder, in `acceptEdits` mode or with
    `Edit` allowed, writes `.oide/permissions.json` allow rules such as `Bash`, a `.oide/config.json`
    `setup` command, or `.claude/settings.json` hooks. The next spawn honours them with no prompt,
    because the project is trusted.
  - **Merging the files in:** worktree agents get there through Merge locally, which applies
    `.oide/` changes along with the code.
- **Evidence:** `apps/desktop/src/main/services/agents.ts:128-148` and `:243-248` (read from
  `p.path` on every spawn); `packages/store/src/settings.ts:296-318`.
- **Fix:** add `Edit(.oide/**)`, `Write(.oide/**)`, `Edit(.claude/**)`, `Write(.claude/**)` and
  `.mcp.json` to the `ask` set (never pre-allowed) for every agent. In Review, flag any diff that
  touches `.oide/`, `.claude/`, `.mcp.json` or `.gitattributes`/`.gitmodules` with a warning banner
  before Merge.
- **Status:** **fixed.** Every agent gets `--settings {"permissions":{"ask":[…]}}` with
  `Edit/Write/MultiEdit/NotebookEdit` on `**/.oide/**`, `**/.claude/**` and `**/.mcp.json`
  (CLI ask rules beat allow rules and acceptEdits), and allow rules that name those paths are
  dropped. `git.diff` marks such files and `.gitattributes`/`.gitmodules` with
  `FileDiff.sensitive`; Review shows a warning in the summary column and in the Merge dialog.
  Residual: a Bash command the user allowed can still write these files. Files:
  `packages/agent-core/src/args.ts`, `packages/protocol/src/project.ts`, `services/git.ts`,
  `renderer/src/screens/Review/{SummaryPanel,index}.tsx`. Tests: `args.test.ts`, `core-fixes.test.ts`.

### SEC-13 An unreviewed extension with the same name replaces a marketplace extension and inherits its secrets

- **Attack:** the extension id is the package name. `registry.add` protects only builtins, so a
  folder or git extension named like an installed marketplace one replaces it silently. It then
  reads that extension's `ext:<name>/…` keychain entries and picks up its `.oide/extensions.json`
  team enablement.
- **Evidence:** `packages/extension-host/src/registry.ts:89-97`;
  `packages/extension-host/src/services.ts:21-24`.
- **PoC:** `test/security/extension-name-takeover.test.ts`.
- **Fix:** refuse an add whose `source` differs from the existing record's, unless the user
  uninstalls first (which already deletes the secrets). Or key records by `source:name`.
- **Status:** **fixed.** `ExtensionRegistry.add` throws `ExtensionConflictError` (IPC `conflict`)
  when the name is installed from another source, or from another folder or git URL.
  `.oide/extensions.json` never turns on a folder or git extension. Uninstall now deletes only
  `ext:<name>/…` (it also took `foo-bar`'s secrets when removing `foo`). PoC flipped to `it`.

### SEC-14 Extension "capabilities" are shown for consent but never enforced

- **Attack:** host code runs in an Electron `utilityProcess` with full Node: fs, net and
  `child_process`. `oide.capabilities` (`network`, `spawn`, `fs`) only feed the consent diff. An
  extension that declares nothing can still read `~/.ssh` and spawn processes. The docs present
  the utility process as isolation.
- **Evidence:** `packages/extension-host/src/host-client.ts:61-63`;
  `packages/extension-host/src/manifest.ts:196-199`; [security](security.md) "Extensions and
  custom tools".
- **Fix:** run hosts under Node's permission model. `utilityProcess.fork(..., { execArgv:
  ['--permission', '--allow-fs-read=<ext dir>', …] })` maps `fs` to `--allow-fs-*` and `spawn` to
  `--allow-child-process`. Network has no Node flag yet, so state that plainly. At minimum, change
  the consent copy and the security page to "declared, not enforced".
- **Status:** **accepted risk (enforcement); copy and docs fixed.** Tested on Electron 45.4.1:
  `utilityProcess.fork` accepts `--permission`/`--allow-fs-read` in `execArgv` but does not enable
  the permission model (`process.permission` undefined; reads, writes and spawns succeed), and the
  RunAsNode fuse is off, so `child_process.fork` of the Electron binary is no fallback. The
  Marketplace copy now says capabilities are not enforced and the code runs as the user;
  [security](security.md), [extensions](extensions.md) and the extension-api README say "not a
  sandbox". Mitigated by the native confirmations of SEC-06/07 and SEC-15. Revisit when Electron
  supports the permission model in utility processes.

### SEC-15 Unreviewed extensions can label their own tools `read`, and those tools are pre-allowed

- **Attack:** `buildLaunch` adds every enabled `risk: 'read'` extension tool to `--allowedTools`.
  The marketplace installer cross-checks the label against the index, but folder and git
  extensions are believed as they are. A tool named `query` that writes files never prompts.
- **Evidence:** `packages/agent-core/src/args.ts:428`;
  `packages/extension-host/src/installer.ts:165-168` (marketplace only).
- **Fix:** for `reviewed: false` extensions (folder or git) and custom servers, treat every tool as
  `ask` unless the user changes it in the UI. Record that choice in main, not from the manifest.
- **Status:** **fixed** without touching `args.ts`: `effectiveToolRisk` makes every tool of a
  folder or git extension `ask`, in `buildMcpConfig` and in the tool refs
  `ExtensionsService.agentConfig` hands to agent-core. A custom server's tool becomes `read`
  (pre-allowed) only after a native confirmation naming it, so the choice is recorded in main.
  Tests in `test/security/extension-confirm.test.ts`.

### SEC-16 Any agent can read every agent's MCP secret, and can then spoof prompts and reviews

- **Attack:** each agent's `X-Oide-Secret` is written in clear to
  `<app-data>/agents/<id>/mcp.json`. On Windows, `mode: 0o600` has no effect. A prompt-injected
  agent with Bash or Read reads a sibling's file and uses that sibling's secret to:
  - call `submit_for_review` as the sibling;
  - flood the sibling's tile with crafted `permission_prompt` requests whose "Always in project"
    rule then lands in `.oide/permissions.json` (escalation);
  - write artifacts attributed to the sibling.
- **Evidence:** `packages/mcp-server/src/server.ts:173-187` and `:386-420` (no cap on pending
  prompts).
- **Fix:** put a `${OIDE_MCP_SECRET}` placeholder in the file and pass the value through that
  agent's env only. The CLI expands env vars in MCP config; verify this on the pinned version. Or
  tighten the ACL on the agent folder. Cap pending prompts per agent, for example at 3.
- **Status:** **fixed** (residual below). mcp.json holds `X-Oide-Secret: ${OIDE_MCP_HANDSHAKE}`
  and every other header value as `${OIDE_MCP_HEADER_n}`; the values go only into that agent's
  env. Verified in the pinned CLI 2.1.325 binary: `--mcp-config` files are parsed with env
  expansion of url and headers (names on the CLI's credential list are withheld; ours are not on
  it). fake-claude expands the same way. Pending prompts are capped at 5 per agent; more are denied
  at once. Residual: a process of the same user can still read another process's environment.
  Files: `packages/mcp-server/src/server.ts`, `tools/fake-claude/bin/fake-claude.mjs`. Tests:
  `server.test.ts`, `core-fixes.test.ts`.

## Low

### SEC-17 The artifact scheme's deny checks are case-sensitive

`ARTIFACT.JSON` and `.VERSIONS/1/…` are served on Windows and macOS. See
`apps/desktop/src/main/services/core.ts:238`. PoC: `test/security/artifact-url-case.test.ts`.
**Fix:** compare in lowercase on case-insensitive platforms, or serve only
files whose real path is not under `.versions` and is not `artifact.json`.
**Status:** **fixed.** Deny checks fold case and trailing dots/spaces and run again on the real
path. File: `services/core.ts`. PoC flipped.

### SEC-18 The artifact CSP leaves some leaks open

- `connect-src 'none'` does not block WebRTC (`RTCPeerConnection` to a STUN host leaks data).
- `script-src oide-artifact:` lets one artifact load scripts from another artifact's host.

See `apps/desktop/src/main/services/core.ts` (`ARTIFACT_CSP`). **Fix:** use `script-src
'unsafe-inline' 'self'`, and disable WebRTC for the artifact frames. Electron's
`webRTCIPHandlingPolicy: 'disable_non_proxied_udp'` on the session does this, or deny it in a
`session.setPermissionCheckHandler` keyed on the frame origin.
**Status:** **fixed.** `ARTIFACT_CSP` uses `'self'` instead of the whole scheme (plus
`worker-src 'none'`), and every webContents gets `setWebRTCIPHandlingPolicy('disable_non_proxied_udp')`.
Files: `services/core.ts`, `security/hardening.ts`.

### SEC-19 `isAnthropicHost` misses `claude.com`

See `apps/desktop/src/main/handlers/settings.ts:13-19`. **Fix:** add `claude.com` and its
subdomains. Hard rule 4 is not broken today, but this keeps it from being broken by a typo.
**Status:** **fixed.** `claude.com` and subdomains count. File: `handlers/settings.ts`.

### SEC-20 The external-link allow-list includes `githubusercontent.com`

Anyone can host content there. See `apps/desktop/src/main/security/external.ts:7-18`. **Fix:**
drop it unless a feature needs it.
**Status:** **fixed.** Removed; no link feature needs it (the marketplace index is fetched, not
opened). File: `security/external.ts`.

### SEC-21 Renderer-supplied refs reach git without `--end-of-options`

`git.log`'s `ref` and `AgentSpec.baseRef` go to `log`, `worktree add` and `merge-base`. Today only
the `rev-parse --verify <ref>^{commit}` pre-check stops `--output=…`-style injection. See
`packages/git/src/log.ts:37-39` and `packages/git/src/worktrees.ts:156`. **Fix:** put
`--end-of-options` before refs, and validate refs with `git check-ref-format` or a strict regex in
Zod.
**Status:** **fixed.** `GitRef` in the protocol (no leading `-`, no whitespace or `..`) for
`git.log` and `AgentSpec.baseRef`; `isSafeRef` in `revParse` and `worktree add`;
`--end-of-options` in `rev-parse`, `log`, `merge-base` and `merge`, and `--` in `worktree add`.
Files: `packages/protocol/src/{agent,ipc}.ts`, `packages/git/src/{git,log,diff,merge,worktrees}.ts`.

### SEC-22 The renderer may rewrite a tool's input when allowing it

`answer` honours `updatedInput` from the renderer. See `packages/mcp-server/src/server.ts:212`.
**Fix:** accept `updatedInput` only for the tools whose UI edits the input, and keep it within
that tool's schema.
**Status:** **fixed.** `answer` keeps the agent's input except for tools whose prompt may edit
it: only Bash, and only its `command` field. File: `packages/mcp-server/src/server.ts`. Test:
`server.test.ts`.

### SEC-23 The extension host's `artifacts.read` is not scoped

Any running extension can read any artifact, including artifacts of projects it is off for. Plain
setting keys `extensions.<name>.<key>` also collide when names contain dots: `foo` with key
`bar.x` is the same key as `foo.bar` with key `x`. See
`packages/extension-host/src/services.ts:27-29` and `:80`. **Fix:** check `isEnabledFor`
against the artifact's project. Use `extensions/<name>/<key>` with a separator that names cannot
contain.
**Status:** **fixed.** `artifacts.read` checks `isEnabledFor` against the artifact's project
(project-less artifacts stay readable) and no longer passes the project id on; plain settings use
`extensions:<name>:<key>` (`:` is not allowed in package names). Test in
`packages/extension-host/test/registry.test.ts`.

### SEC-24 The import scan's public output can still carry secrets

The scan sends `display`, `args` and `url` to the renderer, and these often embed tokens such as
`--api-key=…` or `?key=`. See `packages/extension-host/src/import-scan.ts:202-217`. **Fix:** redact
`=value` after secret-looking flag names, and query strings, in `display`/`args`/`url` shown over
IPC.
**Status:** **fixed.** `toPublic` masks `--flag=value` and `--flag value` for secret-looking flag
names, `KEY=value`, token-shaped values (`sk-…`, `ghp_…`, …), URL passwords and every query value,
and `display` is built from the masked config. Test in
`packages/extension-host/test/import-scan.test.ts` ("SEC-24").

### SEC-25 Electron fuse `grantFileProtocolExtraPrivileges` is left on

It stays on so that `file://` keeps its extra privileges. See
`apps/desktop/electron-builder.yml`. **Fix (later):** serve the renderer from a custom `app://`
protocol and turn the fuse off.
**Status:** **accepted risk.** Turning the fuse off needs the renderer served from an `app://`
protocol first, which is a packaging change for after the release; the window is sandboxed with
context isolation, so the extra privileges only matter together with a renderer compromise.

### SEC-26 Repo artifacts of untrusted projects are indexed and given to agents

Artifacts under `.oide/artifacts/` are offered to agents through `artifacts_list`/`artifacts_read`,
which makes them a prompt-injection channel. Their previews are sandboxed correctly. **Fix:** label
them "from untrusted project", and leave them out of `artifacts_list` until the project is trusted.
**Status:** **fixed (agents).** The MCP artifacts backend hides repo artifacts of untrusted
projects from `artifacts_list`/`artifacts_read`/`artifacts_write` until the project is trusted,
and an agent reaches only its own project's (and project-less) artifacts. Not done: an "untrusted"
label in the Artifacts screen (renderer). File: `services/core.ts`. Test: `core-fixes.test.ts`.

### SEC-27 Extra CLI flags can undo the isolation once SEC-02 is fixed

These flags are not reserved: `--settings`, `--setting-sources`, `--strict-mcp-config`,
`--mcp-config`, `--add-dir`, `--plugin-dir`, `--plugin-url`, `--tools`, `--allowed-tools` and
`--disallowed-tools` (kebab aliases), and `--safe-mode`/`--restricted`. See
`packages/agent-core/src/args.ts:191-215`. **Fix:** reserve them, or at least the ones that change
settings sources or MCP configuration.
**Status:** **fixed.** Reserved, with all their values (variadic flags too) and case or `_`
spellings: `--settings`, `--setting-sources`, `--strict-mcp-config`, `--mcp-config`, `--add-dir`,
`--plugin-dir`, `--plugin-url`, `--tools`, `--allowed-tools`/`--allowedTools`,
`--disallowed-tools`/`--disallowedTools`, `--agents`, `--agent`, the system-prompt flags,
`--safe-mode`, `--restricted`, `--bare`, `--inherit-permission-mode`, `--fork-session`, besides the
existing permission flags. File: `packages/agent-core/src/args.ts`. Test: `args.test.ts`.

## What held

- **Window:** `contextIsolation`, `sandbox`, `nodeIntegration: false` (also subframes),
  `webviewTag: false`, `app.enableSandbox()`, navigation, redirect and `window.open` guards on
  every webContents, permissions denied except `clipboard-sanitized-write`, strict production CSP
  (`script-src 'self'`, no eval). Fuses: RunAsNode, NODE_OPTIONS and `--inspect` off, asar
  integrity, load only from asar.
- **IPC:** the IPC sender frame check, the preload allow-list and Zod on every input.
- **`files.*` path guard:** `..`, junctions, case, NUL, the NTFS `::$INDEX_ALLOCATION` trick and
  `.GIT` all resolve to the real `.git` and are refused.
- **Markdown:** DOMPurify configs in `Focus/components/Markdown.tsx` and `Artifacts/Preview.tsx`.
  Links never navigate, and images are blocked by CSP.
- **Artifact previews:** `sandbox="allow-scripts"` with no `allow-same-origin` (opaque origin, no
  `window.oide`), and the renderer has no `message` listener.
- **Marketplace tarballs:** SRI before extract; symlinks, hard links, `..`, absolute and `:` paths
  refused at inspect and at extract; size and entry limits; manifest name and version must match
  the index; tool risk cross-checked against the index.
- **`installFromGit`:** `--` before the URL, `protocol.file.allow=never`, no submodules, minimal
  env.
- **Manifest paths:** `resolveInside` with a realpath check.
- **oIDE MCP server:** 127.0.0.1 only, exact Host check (DNS rebinding), Origin check, 32-byte
  per-agent secret compared with `timingSafeEqual`, body cap. Permission answers only for the exact
  pending id of that agent; pending prompts deny on quit and on agent removal.
- **Loopback proxy:** loopback socket, Host and Origin checks; drops `authorization`, `cookie` and
  the agent secret before forwarding; `redirect: 'manual'`.
- **OAuth:** PKCE, `state` checked, loopback redirect on 127.0.0.1, and a dynamically registered
  client is bound to its redirect URI.
- **Import scan:** reads files read-only, keeps only `mcpServers`/`servers`, drops the rest at
  once, never logs file content, and never sends env or header values over IPC.
- **Bypass:** refused at spawn, on mode change and in `buildLaunch` when Allow Bypass is off, and
  always refused for `project-folder` agents. A resume after Allow Bypass is turned off is refused
  at launch. `.oide/config.json` cannot set bypass unless it is allowed; `git.reconcile` downgrades
  to `auto`.
- **Trust:** `.oide/setup`, allow rules, extension enablement and project techniques all respect
  trust (but see SEC-02 and SEC-12). Only the renderer can flip trust; there is no project-side
  path.
- **Credentials and hard rules:**
  - no code touches `~/.claude/.credentials.json` or the keychain item;
  - agent env comes from an allow-list;
  - custom model keys never cross IPC (`hasKey` only);
  - no `api.anthropic.com` calls, and `testCustomModel` refuses Anthropic hosts;
  - telemetry defaults to `false` and nothing sends any.
- **Agent output:** stream-json lines are Zod-parsed, and unknown control requests are answered
  with an error, never auto-allowed.
