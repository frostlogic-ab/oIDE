## [2026-11-27] decision | Several Claude Code accounts, picked per agent

[ADR 0021](../../adr/0021-several-claude-code-accounts.md): oIDE can run agents on more than one
Claude plan. Each extra account is its own `CLAUDE_CONFIG_DIR`, which main makes under
`<userData>/claude-accounts/<id>/`; the default account is the CLI's own config. Settings › Claude Code
lists the accounts, and signing in opens the usual terminal running `claude` with that folder. Spawn
shows an Account select only with two or more accounts. `AgentSpec.accountId` is fixed for the
agent's life, and a removed account fails spawn and resume rather than falling back. The status bar
shows plan usage per account, from the CLI's `rate_limit_event`: a chip each with two accounts, and
one Accounts button with a popover beyond that. One account looks as before. The user always picks:
there is no automatic failover between accounts. Telemetry: `agent_spawned.other_account`. Still
open: checking the macOS keychain (open question 19). Pages: [claude-accounts](../pages/claude-accounts.md),
[screen-spawn](../pages/screen-spawn.md), [screen-settings](../pages/screen-settings.md),
[security](../pages/security.md), [telemetry](../pages/telemetry.md), [open-questions](../pages/open-questions.md).
