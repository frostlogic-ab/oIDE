# Security model

oIDE runs agents that execute shell commands on your machine. The main risks are a malicious
repository or extension reaching your machine, and an agent going further than you allowed. This
page describes what oIDE does today. To report a vulnerability, see the
[security policy](https://github.com/frostlogic-ab/oIDE/blob/main/SECURITY.md).

## Your Claude account

These rules are part of every change to oIDE, and a test fails the build if code touches Claude
credential paths:

- oIDE starts **your own, unmodified** `claude` CLI. It never bundles, patches or re-implements it.
- Sign-in happens **only** in Anthropic's own flow, in a terminal running `claude`. oIDE has no login
  screen.
- oIDE **never reads, stores, logs or forwards** your Claude credentials. Agents get an environment
  built from an allow-list, not oIDE's full environment.
- oIDE makes **no direct calls** to Anthropic's API on your plan. Every model call goes through the
  CLI. ("Test connection" for a custom model refuses Anthropic and claude.ai hosts.)
- oIDE **respects plan limits**: a queue beyond Max running and no automatic retries on rate limits.

## The window

- The interface runs with context isolation, the Chromium sandbox and no Node.js access. A strict
  Content Security Policy allows no inline or remote scripts.
- The window cannot navigate away from the app or open new windows. Allowed https links open in your
  system browser.
- The interface talks to the rest of the app through one narrow bridge; every message is validated
  against a schema. File paths from the interface must sit inside a known project, worktree or
  artifact folder.
- Packaged builds set Electron fuses: no "run as Node", no `NODE_OPTIONS`, no `--inspect`, and the app
  refuses a tampered `app.asar`.

## Permission prompts

The CLI asks oIDE through oIDE's own MCP server, which listens only on 127.0.0.1, with a separate URL
and a random secret per agent. An answer is accepted only for the exact pending request; quitting
oIDE denies everything pending.

## Workspace trust

The first time you open a repository, oIDE asks whether to trust it. A cloned repository could
otherwise pre-approve dangerous commands. Until you trust it:

- its `.oide/config.json` setup command never runs, and it cannot set the default mode;
- allow rules in `.oide/permissions.json` are ignored (ask and deny rules still apply);
- project MCP servers in `.mcp.json` are skipped;
- `.oide/extensions.json` cannot turn extensions on;
- project techniques start off and stay in the first message.

## Bypass mode

Only offered when **Settings > Allow Bypass permissions** is on, always in a worktree, refused in the
project folder, and the tile carries a persistent red badge.

## Secrets

API keys for custom models, extension secrets, env values of custom MCP servers and OAuth tokens for
remote MCP servers are stored with the OS keychain (Electron `safeStorage`). If secure storage is not
available, oIDE refuses to store them rather than storing them in plain text. Keys never come back to
the interface, and reach only the agent process that needs them. Remote MCP tokens stay in oIDE: agents
reach those servers through a loopback proxy that adds the token, and an agent can only reach the
servers in its own configuration. These are tokens for third-party services you signed in to, never
Claude credentials.

## Extensions and custom tools

- Marketplace installs: the tarball's integrity hash is checked against the index before anything is
  unpacked, the archive is checked for unsafe paths and links, the manifest must match the index,
  and **install scripts never run**.
- Updates that add tools or capabilities need your consent again.
- Extension host code runs in a separate process per extension, with an allow-listed environment and
  secrets scoped to that extension. **This is separation, not a sandbox**: host code runs as you, with
  full access to files, network and programs. Declared capabilities are shown for consent but are
  not enforced yet.
- Extension panels and artifact viewers run in sandboxed frames (`allow-scripts` only, an opaque
  origin) served from the extension's own folder with a policy that forbids network requests. They
  talk to their host code only through `postMessage`, which oIDE checks against the manifest.
- Extensions from a folder or git URL, and custom MCP servers, carry a **not reviewed** badge. oIDE
  asks before it clones a git URL, before it first runs a folder or git extension (listing exactly
  what will run), and before it starts or saves a custom command. Their tools always ask first.

## Artifact previews

Design artifacts render in a sandboxed frame with an opaque origin and a policy that forbids all
network access. Doc artifacts are sanitized before rendering.

## Telemetry

Usage analytics and crash and error reports are **opt-in** (off until you agree) and are sent by
oIDE's main process to its Umami server through a network session that can reach that host only. The
app window loads no analytics script and still has no network access. Nothing sent contains code,
prompts, paths, project or branch names, or Claude account information; error messages are scrubbed
and stacks keep oIDE's own code locations only. `DO_NOT_TRACK=1` or `OIDE_TELEMETRY=0` turns it off
entirely. See [Privacy and telemetry](privacy.md).

Local crash reports are a separate opt-in: they stay on your computer with paths, prompts and code
removed; you can copy one into a bug report yourself.

## Supply chain

The lockfile is committed, dependencies are watched by Dependabot, and release builds are made only
in CI from tagged commits.

Internals: [security](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/security.md),
[review-security](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/review-security.md),
[constraints](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/constraints.md).
