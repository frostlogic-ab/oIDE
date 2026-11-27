# Claude Code accounts

Run agents on more than one Claude plan from one oIDE window, for example a work Team seat and a
personal Max plan. Decision: [ADR 0021](../../adr/0021-several-claude-code-accounts.md).

## How it works

An account is a `CLAUDE_CONFIG_DIR`. The CLI keeps its sign-in, its user settings and its session
transcripts there. oIDE only chooses the folder and never reads what the CLI writes in it
([constraints](constraints.md), rule 3).

| Account | Folder | Where it is set |
| --- | --- | --- |
| Default (the CLI's own) | whatever the user's env says (`~/.claude` unless `CLAUDE_CONFIG_DIR` is set) | nothing: `allowListEnv` passes the user's value through |
| Extra (`acc-<hex>`) | `<userData>/claude-accounts/<id>/` | `AccountsService.configDir(id)` in main, made from the id; no path crosses IPC |

- **Settings:** `settings.accounts` = `{ defaultLabel, list: [{ id, label }], spawnDefault? }`
  ([protocol](protocol.md), `packages/protocol/src/accounts.ts`). At most 16 extra accounts.
- **Spec:** `AgentSpec.accountId` (unset = default). It is fixed for the agent's life: its session
  is in that account's folder, so a resume must use the same one.
- **Launch:** `SettingsProvider.accountConfigDir(id)` → `LaunchContext.claudeConfigDir` →
  `buildLaunch` sets `env.CLAUDE_CONFIG_DIR` after extension env, so an extension cannot pick another
  sign-in ([agent-supervisor](agent-supervisor.md)). A removed account fails spawn and resume with a
  clear error and never falls back to the default sign-in.
- **Sign-in:** `accounts.openSignIn { id }` opens the same sign-in terminal as `cli.openSignIn`,
  running the user's `claude`, with `CLAUDE_CONFIG_DIR` in the terminal env. The user signs in there
  through Anthropic's own flow.
- **Remove:** `accounts.remove` forgets the account. It is refused while agents on the Wall use it.
  The folder stays on disk, because oIDE never deletes credentials. The dialog suggests `/logout` in
  its terminal first.

## Usage and sign-in per account

`AccountsService` (`apps/desktop/src/main/services/accounts.ts`) is fed from the agents service's
event sink with the agent's account:

| Event | Effect |
| --- | --- |
| `init` | signed in: yes |
| `error` with `code: 'auth'` | signed in: no |
| `plan-usage` | replaces that window's `{ status, utilization?, resetsAt?, seenAt }`; an `allowed*` status clears the rate limit |
| `rate-limit` | `rateLimitedUntil` = the CLI's reset time |
| `usage` | refreshes tokens today (throttled to one push per 2 s) |

State is persisted in `ui_state` under `accounts:usage`. It is pushed as `accounts.usage` and can be
read with the `accounts.usage` command. Tokens today per account come from
`UsageRepo.totalsByAccount` (`usage_samples` joined to `agents.spec.accountId`). The default
account's sign-in still also updates `CliInfo.signedIn` (the status bar's "Sign in to Claude Code
CLI"). Agents on extra accounts no longer change it.

Numbers come only from the CLI's `rate_limit_event` ([ADR 0007](../../adr/0007-plan-usage-meters-from-rate-limit-events.md)).
An account with no agent running keeps its last values, shown with their age, and a window whose
reset time has passed is hidden (`liveWindows`). oIDE has no other source: no API call, no probe prompt.

## UI

- **Settings › Claude Code › Accounts** ([screen-settings](screen-settings.md)), in
  `screens/Settings/AccountsList.tsx`. Each row has the name (renamed on blur), sign-in state, a
  "Default for new agents" radio, Sign in (or Sign in again) and Remove (extra accounts only).
  "+ Add account" asks for a name, then opens the sign-in terminal.
- **Spawn** ([screen-spawn](screen-spawn.md)): an **Account** select below Project and Work in. It
  shows only with two or more accounts and not when the lead is a custom model. Options read
  `Work · Session 42%`, `Client (not signed in)` (disabled) or `Personal · rate limited`
  (`accountOptions` in `spawnModel.ts`). The first pick is `spawnDefault` while it exists.
- **Status bar** (`components/frame/AccountsUsage.tsx`):
  - One account: unchanged, the single plan meter and the rate-limit notice.
  - Two accounts: a chip each, with the label, a meter of the window closest to its limit and the
    percentage. A rate-limited account shows an amber "resets 14:00". An account with no data
    shows "—". The tooltip lists every live window with its age, and tokens today.
  - Three or more: one **Accounts** button showing the closest account to a limit, which opens a
    popover with a row per account (windows, reset times, tokens today, sign-in) and "Manage accounts".

## Rules

- The user picks the account. oIDE never moves an agent to another account, never picks the
  least-used account by itself, and never retries a rate-limited agent elsewhere ([constraints](constraints.md), rule 6).
- "Max running" stays global, across accounts.
- Telemetry: `agent_spawned.other_account` only ([telemetry](telemetry.md)). Labels, ids and folders are never sent.

## Not done yet

- A per-project default account. It would be personal, so it would go in the local store, not
  `.oide/config.json`.
- An account badge on Wall tiles and in Focus.
- A per-account split on the Usage screen ([screen-usage](screen-usage.md)).
- Checking on macOS that each folder gets its own keychain entry ([open-questions](open-questions.md), question 19).
