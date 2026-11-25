# Agent supervisor (`packages/agent-core`)

Turns one Spawn request into long-lived `claude` processes, normalizes their stream-json into
`AgentEvent`s, reduces them into the Wall's `AgentSummary`, and maps tile controls to the CLI.
CLI facts it relies on: [cli-integration](cli-integration.md). Subagent views: [subagents](subagents.md).
Permission prompts and review: [mcp-server](mcp-server.md). Tests: [testing](testing.md).

## Modules

| File | What it does |
| --- | --- |
| `parser.ts` | `parseLine(line, log?) → { json, events: AgentEventDraft[], control?, controlRequest? }`. Loose Zod schemas of the verified raw shapes; unknown types → `unknown` event + log; never throws. `parseTranscript(text)` for fixtures. |
| `messages.ts` | `toStreamJson(UserMessage)`: text, `/command` (plain string content), review feedback (bundled `path:line: comment` list plus "call submit_for_review again"), artifact (MCP id + path). |
| `args.ts` | `buildLaunch(spec, ctx) → LaunchPlan { command, args, env, firstMessage, mcpConfig, agentsJson, appendSystemPrompt, model, mode, warnings }`. Env allow-list, custom model env, routed `--agents`, techniques, allowed/disallowed tools, extra flags (`shellSplit`, reserved flags removed), the oIDE system-prompt contract. |
| `cli.ts` | `detectCli(path?) → CliInfo` (`--version`, `--help` → `features`), `findOnPath` (PATHEXT, prefers `.exe`), `resolveSpawn` (`.cmd` through `cmd.exe /d /s /c` with escaped args). |
| `driver.ts` | `ClaudeCliDriver implements AgentDriver`; `AgentHandle` with `events`, `send`, `interrupt` (control request, SIGINT fallback), `setMode` (control request), `dispose` (end stdin, then `taskkill /T /F` or process-group kill). `rawJsonOf(event)` gives the stdout line. |
| `reducer.ts` | `AgentReducer.apply(event) → { summary, changed, subagents }`, `createSummary`, `describeToolUse`. |
| `subagents.ts` | `SubagentTracker` (see [subagents](subagents.md)). |
| `ports.ts` | Interfaces other packages implement (below). |
| `supervisor.ts` | `Supervisor`. |

## Driver interface (as in the brief, plus extras)

```ts
interface AgentDriver { start(spec: AgentSpec, options?: DriverStartOptions): Promise<AgentHandle> }
interface AgentHandle {
  id: string; sessionId: string;
  events: AsyncIterable<AgentEvent>;
  send(msg: UserMessage): void; interrupt(): Promise<void>;
  setMode(mode: PermissionMode): Promise<void>; dispose(): Promise<void>;
  readonly pid?: number; readonly alive: boolean; readonly exited: Promise<ExitInfo>; stderrTail(): string[];
}
```

`DriverStartOptions` carries `{ agentId, sessionId, cwd, launch: LaunchPlan, nextSeq?, onRawLine?, resolveArtifact? }`.
The supervisor shares one `nextSeq` per agent so its own events (status, permission, review, subagent)
interleave with CLI events in one monotonic sequence.

## Supervisor API

```ts
const sup = new Supervisor({ worktrees, sink, settings, secrets?, broker, driver?, log? });
sup.on('event' | 'summary' | 'removed', fn) → unsubscribe
await sup.spawn(spec)            // N attempts (spec.attempts) sharing attemptGroup; each starts 'queued'
sup.send(agentId, userMessage)   // held while paused/queued; respawns a dead process with --resume
await sup.answerPermission(agentId, answer)  // exact pending id only; "Always" → settings.addAllowRule
await sup.setMode(agentId, mode) // control request, fallback interrupt + --resume; calls run in order per agent; the spec follows the CLI's own mode changes
await sup.stop / pause / resume(agentId); sup.compact(agentId); await sup.remove(agentId, { deleteWorktree })
sup.stopSubagent(agentId, subagentId)
sup.restore([{ spec, summary, lastSeq }])    // after an app restart
sup.list(), get(id), spec(id), subagentTranscript(id, subId), subagentTokenShare(id), runningCount()
await sup.shutdown()
```

Injected interfaces (`ports.ts`):

- `WorktreeProvider { create({agentId, slug, spec}) → {path, branch?, baseRef?}; runSetup?(…) → {ok, output?}; remove?(…) }` (packages/git).
- `EventSink { append(event, raw?); appendRaw?(agentId, line); saveSummary?(summary, spec); removeAgent?(id) }` (packages/store).
- `SettingsProvider { get(); cli(); techniques?(projectId); project?(projectId) → {path, trusted, rules}; extensionTools?(spec); extraMcpServers?(spec); customModel?(id); addAllowRule?(projectId, rule); resolveArtifact? }`.
- `SecretProvider { customModelKey(id) }` (keychain; never Claude credentials).
- `PermissionBroker { registerAgent(agentId, handlers, extraServers?, {projectId}?) → {mcpConfigPath}; unregisterAgent(id); answer(requestId, answer) → boolean }`. `OideMcpServer` from packages/mcp-server satisfies it as-is.

## Lifecycle and queue

- `spawn` creates `queued` agents. `pump()` starts agents while `runningCount() < settings.agents.maxRunning`.
  A slot is held by an agent that is launching or whose live process is `starting`, `running` or
  `needs-permission`. Idle agents (`has-question`, `ready-for-review`) do not hold a slot, so a
  user reply to an idle agent is delivered at once even when the cap is reached.
- Launch: worktree (`WorktreeProvider.create`, then `runSetup` as a "Setup" step), register with the
  broker (writes `mcp.json`), `buildLaunch`, `driver.start` (sends the first message), status `running`.
- The first launch uses `--session-id <uuid>` (generated at spawn, shown on the tile at once). Every later
  launch of the same agent uses `--resume <sessionId>` (stop → resume, crash → resume, mode fallback, restart).
- Rate limit: status `rate-limited` with `rateLimitResetAt`; the supervisor never retries by itself.
- Crash: non-zero exit → `error` with `exitCode` and the last stderr line; Resume respawns with `--resume`.
- Pause: interrupt the turn, status `paused`, hold messages; resume flushes them (or respawns if needed).
- Restore: live statuses become `stopped` (their process is gone) with `summary.interrupted`
  (`restart`, `crash` or `mcp-down`, from `RestoreEntry.interruption`), cleared once it runs again;
  queued agents re-enter the queue; archived summaries are skipped.
- Archive: `archive(agentId, { reason, mergeCommit?, deleteWorktree? })` denies pending prompts, ends
  the process, optionally removes the worktree, stamps `summary.archived`, saves it and drops the
  agent (event `archived`). `unarchive({ spec, summary, lastSeq, resumeBlocked? })` brings it back
  stopped. `resume`/`send` throw `LaunchError` while `summary.resumeBlocked` is set (worktree gone).
  See [screen-wall](screen-wall.md#archived-agents).
- `setPr(agentId, pr)` (main's gh lookups) and `summary.costUsd` (the CLI's per-process cumulative
  `total_cost_usd`, summed across processes by the reducer).

## Status derivation (reducer)

| Status | Rule |
| --- | --- |
| queued / starting / paused / stopped | Set by the supervisor (`status` events). |
| running | A user message was sent (`status running`), or `init` while starting; still `running` after a `result` when `backgroundTasks > 0` (async subagents). |
| needs-permission | A `permission-request` is pending; back to running on `permission-resolved` for that id. |
| has-question | `result` and no `submit_for_review` since the last user message. |
| ready-for-review | `review-submitted` since the last user message (kept through `/compact`). |
| rate-limited | `rate-limit` event (rejected `rate_limit_event`, assistant `error:"rate_limit"`, or `api_error_status` 429). |
| error | Non-zero exit, auth error (`error` code `auth`, API 401), `model_not_found`, or a launch failure. |

Activity lines (last 6): "Read src/x.ts", "Edit …", "Write …", "Run npm test", "Search …", "Delegate: …",
"Submit for review", `server: tool` for MCP tools, and the ephemeral "Thinking…" / "Writing…" from partials.
Context ring: `input + cacheRead + cacheCreation` of the latest lead `usage` (one API request's whole
prompt: system prompt, tools, CLAUDE.md and messages; output is not counted until the next request), over
the lead model's window. Subagent messages (tagged `parent_tool_use_id`) never touch the lead's ring; each
subagent gets its own `contextUsed` and `contextWindow` from its own tagged messages. This equals the CLI's
own `/context` total exactly (tests in `packages/agent-core/src/context.test.ts` against real fixtures).
Window: a `ContextWindowBook` shared by the supervisor learns `result.contextWindows[model]` (the lead
model's entry, `[1m]` stripped) and `/context`'s `raw_max_tokens`; before any report it falls back to
`contextWindowFor(model)` (1M for the 5.5 models and aliases, 200k for unverified ones). A restored summary
seeds the book with a stored window larger than the table's. `/compact` sets `contextUsed` to `post_tokens`;
a `context-usage` event (from `/context`) sets both values. `contextBaseline` is the first lead request;
the ring tooltip reads "N of W tokens (P%) · includes system prompt and tools" and, when the baseline is at
least 50k or 10% of the window, says the session started there before any work.

Bug fixed 2026-11-25 ("75% on a simple prompt", ring at 92%): the table said 200k for every model, and the
CLI only reports the real window at the end of a turn. A user's first turn on `claude-opus-5-5` ran for many
minutes: its first request was 84.8k (42% against 200k; the CLI says 8% of 1M) and it grew to 150k (75%,
really 15%) and 184k (92%, really 18%) before any result arrived. Token counting itself was right. Todos come from `TodoWrite` input, plan text from `ExitPlanMode` input.

## Protocol additions (additive)

`AgentSummary.planText`, `.backgroundTasks`, `.planUsage`; `PermissionRequest.toolUseId`; `result` event
`contextWindow`, `localCommand`, `apiErrorStatus`; `error` event `code`; new events `mode-changed`,
`compact`, `subagent-task`, `background-tasks`, `plan-usage`; `result.contextWindows`, `context-usage`,
`AgentSummary.contextBaseline`, `SubagentInfo.contextWindow` (context ring accuracy).

## Known gaps

- A permission prompt from a subagent that arrives before its `tool_use` line is attributed to the lead.
- The env var for the "separate subagent model" strategy (`CLAUDE_CODE_SUBAGENT_MODEL`) was not verified in a session.
- `signedIn` stays `unknown` until an init or an auth error; there is no auth probe (by design).
