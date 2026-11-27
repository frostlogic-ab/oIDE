# ADR 0021: Several Claude Code accounts, one CLAUDE_CONFIG_DIR each

- Status: accepted
- Date: 2026-11-27
- Departs from: build brief, which assumes a single sign-in ("Sign-in only through Anthropic's own flow"; the status bar has one plan meter, ADR 0007)

## Context
People have more than one Claude plan: a work Team or Enterprise seat and a personal Pro or Max
plan, or one plan per client. They want work repositories to run on the work plan and side projects
on their own, from one oIDE window. The Claude Code CLI keeps everything for a sign-in (credentials,
`settings.json`, session transcripts) under `CLAUDE_CONFIG_DIR`, `~/.claude` by default. Pointing the
CLI at another folder gives an independent sign-in. `CLAUDE_CONFIG_DIR` was already on the agent env
allow-list.

## Decision
- **Accounts are folders, not credentials.** Settings › Claude Code › Accounts lists the CLI's own
  config ("Default", renamable) and up to 16 extra accounts (`settings.accounts`). Main makes each
  account's id (`acc-` + random hex) and derives its folder, `<userData>/claude-accounts/<id>/`. No
  path crosses IPC. oIDE never reads, copies or deletes anything the CLI writes there (hard rule 3).
  Removing an account only forgets it. The folder, with the CLI's sign-in, stays on disk, and the
  dialog suggests `/logout` first.
- **Sign-in is Anthropic's own flow.** "Sign in" opens the existing sign-in terminal running `claude`
  with that account's `CLAUDE_CONFIG_DIR` (`accounts.openSignIn`), as for the default account (rule 2).
- **An agent's account is fixed.** `AgentSpec.accountId` (unset = default). `buildLaunch` sets
  `CLAUDE_CONFIG_DIR` from it, after extension env, so nothing else can pick another sign-in. The
  supervisor refuses to spawn or resume an agent whose account was removed, rather than falling back
  to the default sign-in. Resuming needs the same account, because the session lives in its folder.
- **Spawn shows the picker only with two or more accounts**, and not for a custom model, which does
  not run on a Claude plan. The first pick is `accounts.spawnDefault` (or the default account). Each
  option shows its sign-in state and the CLI's last plan usage.
- **Plan usage per account.** Main (`AccountsService`) keeps, per account and plan window, the
  utilization and reset time from the CLI's `rate_limit_event` (ADR 0007), when it saw them, the
  rate-limit reset, and sign-in state learned from `init` and auth errors. It persists them
  (`ui_state` `accounts:usage`) and pushes `accounts.usage`. Tokens today per account come from
  `usage_samples` joined to the agent's spec. With one account the status bar is unchanged. With two
  it shows a chip per account. With more it shows one "Accounts" button with a popover. A value
  whose window has reset is hidden, never shown as current.
- **The user chooses (rule 6).** oIDE never moves an agent to another account, never picks the
  least-used account by itself, and never retries a rate-limited agent elsewhere. "Max running"
  stays global.

## Consequences
- An account with no agent running shows the last value it reported, with its age, or nothing.
  oIDE has no other source: no API call (rule 4), no probe prompt, no scraping `/usage`.
- User-level Claude Code config (`settings.json`, `CLAUDE.md`, user agents, commands, plugins, MCP
  servers) is per account too, because it lives in the same folder. Project `.claude/` is unaffected.
- On macOS the CLI keeps credentials in the keychain, not in the folder. Whether each
  `CLAUDE_CONFIG_DIR` gets its own keychain entry is not verified yet. It must be checked on macOS
  for each tested CLI version (open question 19). If it does not, signing in to one account would sign
  out the others, and the feature would have to be marked as Windows and Linux only.
- Telemetry: `agent_spawned.other_account` (boolean). Never labels, ids or paths.
- Not done yet: a per-project default account (it would be personal, so it would go in the local store,
  not `.oide/config.json`), an account badge on tiles, and a per-account split on the Usage screen.
