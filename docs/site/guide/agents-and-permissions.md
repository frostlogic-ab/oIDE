# Agents and permissions

## What an agent is

An agent is one `claude` CLI process that oIDE starts for you, in its own git worktree, driven
through the CLI's streaming JSON mode (`--input-format stream-json --output-format stream-json`).
It is your own installed CLI, unmodified, using your own sign-in. oIDE reads the events it prints
(text, tool calls, usage, subagents) and sends it your messages.

Each agent has a CLI session id. The first launch uses `--session-id`; every later launch (Resume
after Stop, after a crash, after restarting oIDE) uses `--resume`, so the conversation continues.

## Lifecycle

| Status | Meaning |
| --- | --- |
| Queued | Waiting for a free slot (Settings > Agents > Max running, default 3) |
| Starting / Running | Working |
| Needs permission | Waiting for you to answer a permission prompt |
| Has a question | The turn ended without submitting for review: it is waiting for your reply |
| Ready for review | The agent called `submit_for_review` with a summary and the checks it ran |
| Paused / Stopped | You paused or stopped it; Resume continues the session |
| Paused by plan limit | The CLI reported a rate limit; oIDE shows the reset time and does not retry |
| Error | The process exited with an error; Resume restarts it with `--resume` |

Idle agents (has a question, ready for review) do not hold a running slot, so replying to them
works even when the cap is reached.

## Permission modes

| Mode | CLI value | Behaviour |
| --- | --- | --- |
| Manual | `default` | Asks before edits and commands |
| Edit automatically | `acceptEdits` | Edits files without asking; still asks for commands |
| Plan | `plan` | Plans first, no changes |
| Auto | `auto` | The CLI's auto mode (default in oIDE) |
| Bypass | `bypassPermissions` | No prompts at all. Only when **Settings > Allow Bypass** is on, always in a worktree, never in your project folder. The tile carries a red warning badge. |

Change an agent's mode from its Focus header or with Shift+Tab. oIDE sends the change to the
running CLI; if the CLI cannot take it live, oIDE interrupts and resumes the session in the new mode.

## How prompts reach you

oIDE passes the CLI `--permission-prompt-tool mcp__oide__permission_prompt`, a tool on oIDE's own
MCP server (bound to 127.0.0.1, with a per-agent secret). When the CLI wants to run something that
is not pre-allowed, it calls that tool and waits. oIDE shows the request on the tile and in Focus:
which agent or subagent asks, and exactly what (the command, the file, the URL).

- **Allow once**: this call only.
- **Always in &lt;project&gt;**: saves a rule such as `Bash(npm test)` to the project's
  `.oide/permissions.json`, so future agents in this project are not asked again. Agents already
  running in the project stop asking for it too, from that moment (prompts already waiting for the
  same rule are allowed at once). The button is greyed out when no rule can be saved: a command with
  `:`, `*`, `,`, quotes or parentheses, a tool marked "asks first" or covered by an ask rule, and
  edits to `.oide/`, `.claude/` or `.mcp.json`, which always ask.
- **Deny**: the CLI is told no and continues.

An answer is accepted only for the exact pending request. When oIDE quits, every pending prompt is
denied.

## Rules and defaults

Rules use the CLI's own syntax (`Edit`, `Bash(npm test)`, `mcp__server__tool`) and are passed as
`--allowedTools` and `--disallowedTools`:

| Where | What |
| --- | --- |
| Settings > Permissions > Defaults | Edit files, shell commands, network: allow, ask or block |
| Settings > Permissions > Rules for a project | Always allowed / always denied, stored in `<repo>/.oide/permissions.json` |
| Extensions | Tools labelled "read only" are pre-allowed in projects where the extension is on; "asks first" tools never are |

Untrusted projects keep their deny and ask rules, but their allow rules are ignored.

## Subagents

oIDE never starts subagents itself; the lead agent does, through the CLI's Agent tool. With a
**routed** strategy (the Balanced preset), oIDE gives the CLI subagent definitions (`--agents`) for
simple, standard and complex tasks, each with its own model and effort, and the lead picks one per
task. oIDE shows each subagent's status, transcript, tokens and context ring, and which subagent a
permission prompt comes from.

## Plan limits

oIDE respects your plan's limits: it queues agents beyond Max running, shows rate-limit errors
clearly with the reset time, never retries in a loop, and shows how much of an agent's tokens its
subagents used. Usage percentages appear only when the CLI reports them.

## Project settings in `.oide/`

| File | What |
| --- | --- |
| `.oide/config.json` | Default mode, preset, and a `setup` command run in each new worktree (trusted projects only) |
| `.oide/permissions.json` | Allow / ask / deny rules |
| `.oide/techniques.json` | Project techniques |
| `.oide/extensions.json` | Extensions the team wants on, with version ranges |
| `.mcp.json` | Standard Claude Code MCP servers file, read by the CLI itself |

Commit these to share an agent setup with your team.

Internals: [agent-supervisor](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/agent-supervisor.md),
[cli-integration](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/cli-integration.md),
[subagents](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/subagents.md),
[mcp-server](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/mcp-server.md).
