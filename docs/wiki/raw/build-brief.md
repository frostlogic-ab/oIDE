# oIDE architecture and build brief
2026-11-23 · @Georges
## Summary
oIDE is an Electron + TypeScript + React desktop app that runs many Claude Code agents in parallel, across many projects, in one window. Each agent is the user's own unmodified `claude` CLI, launched as a child process in its own git worktree and driven through its streaming JSON mode. The Mission Control canvas is the UI spec; this brief is the build spec Claude Code implements from.
Decisions this brief locks:
- Shell: Electron, one Chromium everywhere, Node in the main process.
- Agent runtime: one `claude -p --input-format stream-json --output-format stream-json` process per agent, supervised by a main-process service. No terminal-UI scraping, no API calls of our own.
- Isolation: one git worktree and branch per agent.
- State: SQLite per install, `.oide/` per project, OS keychain for any secret.
- Extensions: npm packages with a manifest, run in a separate extension host process, contributing MCP tools to agents and UI panels to the app.
- Order of build: a single working agent tile first, then the Wall, then review, then extensions (see Milestones).
How to read it: statements without a marker are decisions. (guess) marks an assumption about Claude Code behaviour or a design choice not yet confirmed; each one should be checked against the CLI version we pin before code depends on it. (open) marks a question for Georges.
Revised the same day to match Georges's design updates: subagents on the Wall and in Focus, the shared project scope, the new Source control screen with Review under it, and Add custom in the Marketplace.
## Constraints and non-goals
These rules come from Anthropic's terms for running Claude Code on a Pro or Max plan inside another product. Breaking any of them puts users' accounts at risk, so they are hard requirements, not preferences. Sources: Legal and compliance, Use the Agent SDK with your Claude plan.
| Rule | What it means in code |
| Drive the user's own, unmodified `claude` CLI | oIDE never bundles, patches or re-implements Claude Code. It finds the binary on PATH or at a user-set path and spawns it. |
| Sign-in only through Anthropic's flow | oIDE has no login screen. If the CLI is signed out, oIDE opens a terminal running `claude` so the user signs in there (or runs `/login`). |
| Never read, store or forward Claude credentials | No code touches `~/.claude/.credentials.json`, the macOS keychain item, or OAuth tokens. Env passed to agents is built from an allow-list, never by copying the user's whole environment into logs. |
| No direct calls to Anthropic's API on the user's plan | Every model call goes through the CLI process. oIDE makes zero HTTP requests to Anthropic itself. |
| No "Claude" in the product name or logo | Name is oIDE. UI copy may say "Claude Code CLI" to describe the dependency. |
| Respect plan limits | Show usage, queue agents beyond a user-set cap (Settings › Agents › Max agents running at once), never retry in a tight loop on rate-limit errors. |
Non-goals for v1:
- A full manual-editing IDE. Monaco is there for reading and small edits; debugging, refactoring tools and language features come from extensions.
- Support for other agent CLIs (Codex, Gemini, etc.). The driver interface leaves room for them, but v1 ships one driver.
- Cloud or multi-user features. oIDE is a local desktop app; sharing happens through git and `.oide/`.
- A hosted marketplace backend. v1 uses a static index in a GitHub repo.
(open) Georges should ask Anthropic to confirm that an open-source app driving the user's own CLI in stream-json mode, many sessions at once, fits the subscription terms before a public release.
## Stack
Electron with TypeScript everywhere, React in the renderer, and Node services in the main process. Electron wins over Tauri because it ships one Chromium on every OS (Tauri on Linux means WebKitGTK), and because the agent supervisor, terminals and extension host all need mature Node libraries. The cost is about 150 MB of install size and a heavier idle footprint.
| Layer | Choice | Why |
| Shell | Electron (current stable at project start, then follow every second major) | Same rendering everywhere; Node built in |
| Language | TypeScript, `strict`, ESM | One language across main, renderer, extensions |
| UI | React 19, Vite (via electron-vite), Tailwind CSS | Fast dev loop; Tailwind matches the canvas's token-driven look |
| UI state | Zustand stores fed by IPC event streams | Small, works well with high-frequency agent events |
| Lists | TanStack Virtual | Transcripts and the Wall can hold thousands of rows |
| Editor | Monaco | The Files screen and diff views; same engine as VSCode |
| Diff view | Monaco diff editor for split, a custom unified renderer for Review | Inline comment threads need a custom renderer |
| Terminal | xterm.js + node-pty | The Raw terminal tab and the sign-in terminal |
| Git | The system `git` CLI through a typed wrapper | Worktrees are best supported by git itself; no libgit2 edge cases |
| File watching | @parcel/watcher | Native, fast, cross-platform, one watcher per worktree |
| Storage | SQLite through better-sqlite3, Drizzle for schema and migrations | Synchronous, fast, single file; runs in the main process |
| Secrets | Electron `safeStorage` (OS keychain) | Only for third-party keys the user adds (custom model endpoints, extension secrets) |
| Validation | Zod schemas shared by main, renderer and extensions | Every IPC message and every CLI event is parsed, not trusted |
| Agent tools | `@modelcontextprotocol/sdk` | oIDE's own MCP server and extension MCP servers |
| Packaging | electron-builder + electron-updater | Installers and auto-update for all three OSes |
| Repo | pnpm workspaces + Turborepo | One repo for app, SDK, built-in extensions |
| Tests | Vitest (unit), Playwright for Electron (end to end), a fake `claude` binary for agent tests | Agent tests must not need a real plan |
| Lint and format | ESLint (typescript-eslint), Prettier | Standard |
The fake CLI is worth calling out. `tools/fake-claude` is a small Node script that reads stream-json on stdin and replays recorded event fixtures on stdout. Every supervisor, Wall and Review test runs against it, so CI never needs a Claude login.
## Process model and repo layout
The main process owns every long-lived resource: agent processes, worktrees, the database and the extension host. The renderer is a sandboxed UI that only sees typed events and sends typed commands, so a UI crash or reload never kills an agent.
<embed {"id": ".6196", "h": "6b1d299b", "caption": "process model \u00b7 renderer, main services, child processes", "ref": "node/c972f4d3-da11"}> 
The supervisor talks to each CLI over pipes. The CLI calls back into oIDE's own MCP server for permission prompts and oIDE tools. Extension MCP servers are listed in each agent's `--mcp-config`, so the CLI starts them itself.
- IPC contract. `packages/protocol` defines every command (renderer to main, request/response) and every event (main to renderer, streamed) as Zod schemas. Preload exposes exactly one object, `window.oide`, generated from that contract. No `ipcRenderer` leaks into React code.
- Event fan-out. Agent events are batched per animation frame (about 16 ms) before crossing IPC, so six chatty agents do not flood the renderer.
- Crash isolation. If the extension host crashes, the registry restarts it with backoff and marks its panels as reloading. If a CLI process dies, its tile shows the exit code and a Resume button.
- Multi-window. v1 is one window. The renderer stores are keyed by project and agent id, so a second window later just subscribes to a subset.
Repo layout (pnpm monorepo):
```
oide/
  apps/desktop/            Electron app: main/, preload/, renderer/
  packages/protocol/       Zod schemas: IPC, CLI events, manifest, .oide config
  packages/agent-core/     Supervisor, AgentDriver interface, stream-json parser
  packages/git/            Typed git CLI wrapper, worktree manager
  packages/store/          Drizzle schema, migrations, repositories
  packages/mcp-server/     oIDE's own MCP server (permissions, artifacts, review)
  packages/extension-api/  Public API for extension authors (published to npm)
  packages/extension-host/ Loader and sandbox for the utility process
  packages/ui/             Shared React components and design tokens
  extensions/              Built-in extensions: git, browser-preview, themes
  tools/fake-claude/       Scriptable fake CLI for tests
  tools/marketplace-index/ Script that builds and validates the index
  docs/                    Architecture notes and ADRs
```
## Agent supervisor and CLI integration
The supervisor turns one Spawn request into one long-lived `claude` process, normalizes its stream-json output into oIDE events, and turns user actions on a tile into stdin messages or MCP answers. It is the most important code in oIDE and the first thing to build.
### Driver interface
All CLI knowledge lives behind one interface, so a CLI change touches one package and a second driver (for example the Agent SDK pointed at the user's binary) can be swapped in later.
```
interface AgentDriver {
  start(spec: AgentSpec): Promise<AgentHandle>;   // spawn or resume
}
interface AgentHandle {
  id: string; sessionId: string;
  events: AsyncIterable<AgentEvent>;             // normalized, zod-parsed
  send(msg: UserMessage): void;                  // goal, reply, feedback, /compact
  interrupt(): Promise<void>;                    // Stop / Pause
  setMode(mode: PermissionMode): Promise<void>;  // Shift+Tab
  dispose(): Promise<void>;
}
```
### Launch
One process per agent, spawned with `child_process.spawn` (pipes, not a pty), `cwd` set to the agent's worktree:
```
claude -p --verbose \
  --input-format stream-json --output-format stream-json \
  --include-partial-messages \
  --session-id <uuid>            # new agent; --resume <id> after a restart
  --model <resolved model id or alias> \
  --permission-mode <mode> \
  --mcp-config <app-data>/agents/<id>/mcp.json \
  --permission-prompt-tool mcp__oide__permission_prompt \
  --append-system-prompt <system-prompt techniques + oIDE contract> \
  --agents <json>                # only for routed subagents
  --allowedTools <project rules> --disallowedTools <project rules> \
  <Settings > Claude Code > Extra CLI flags>
```
The environment is built from an allow-list (PATH, HOME, USERPROFILE, LANG, TMP, proxy and certificate variables), plus the variables of a custom model when one is picked. oIDE never copies or logs credential files or tokens. Each flag above must be checked against the pinned CLI version; the parser treats unknown event types as "log and ignore", never as a crash.
### How each Spawn and tile control maps to the CLI
| oIDE feature | Mechanism | Confidence |
| Goal + first-message techniques | First stream-json user message: goal, then each technique's text in Settings order | Firm |
| System-prompt techniques | `--append-system-prompt` | Firm |
| Mode: Manual, Edit automatically, Plan, Bypass | `--permission-mode` `default`, `acceptEdits`, `plan`, `bypassPermissions` | Firm |
| Mode: Auto (the default) | `--permission-mode auto` | (guess) name and availability depend on CLI version; fallback is `default` plus oIDE's own allow rules |
| Shift+Tab on a running agent | A stream-json control message to change mode | (guess); fallback is interrupt, then `--resume` with the new mode |
| Model per agent, version pinning | `--model` with an alias for "Latest" or the exact id for a pinned version | Firm |
| Effort per model slot | CLI setting or env var for effort | (guess) on the exact key; hide the control if the CLI lacks it |
| Strategy: one model | Nothing extra | Firm |
| Strategy: separate subagent model | Env var that sets the default subagent model | (guess) on the variable name |
| Strategy: routed by task size | `--agents` defines `simple-task`, `standard-task`, `complex-task` subagents, each with its model; the oIDE system prompt tells the orchestrator to rate each task and pick one | Firm for `--agents`; per-subagent effort is (guess) |
| Your models (local, compatible API, Bedrock, Vertex) | Per-agent env: `ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` | Firm; the key comes from oIDE's keychain store, not Claude's |
| Permission prompt on a tile (Y / Always / D) | The CLI calls `mcp__oide__permission_prompt`; the MCP handler blocks until the user answers, then returns allow (optionally with edited input) or deny | Firm |
| "Always in oide" | Answer allow, and save the rule (for example `Bash(npm test)`) to `.oide/permissions.json`; later spawns pass it in `--allowedTools` | Firm |
| Extension tools marked "asks first" | Never added to `--allowedTools`, so they always reach the prompt tool | Firm |
| Reply, inline review feedback, attach artifact | A stream-json user message; artifacts are referenced by path or by an oIDE MCP resource | Firm |
| `/compact` after the confirm dialog | Send `/compact` as a user message | (guess) that slash commands work in stream-json input; test early |
| Stop | Interrupt the turn; the process exits; the session stays resumable | Interrupt message is (guess); SIGINT is the fallback |
| Pause | Interrupt the current turn and hold new messages until Resume | Built on Stop |
| Resume after an app restart | Respawn with `--resume <session id>` read from the stored init event | Firm |
| Parallel attempts (N) | N agents with the same goal and a shared `attemptGroup` id, each in its own worktree; Review compares them | Firm |
### Status, tiles and the Plan tab
| Tile state | Derived from |
| Queued | Waiting for a free slot under "Max agents running at once" |
| Running | A user message was sent and no `result` event has arrived |
| Needs permission | A permission prompt is pending in the MCP server |
| Has a question | The turn ended (`result`) without the agent calling `oide.submit_for_review` |
| Ready for review | The agent called `oide.submit_for_review(summary, checks)` |
| Error / Paused by plan limit | Non-zero exit, or a rate-limit error; the tile shows the reset time and does not auto-retry |
The `oide.submit_for_review` tool is part of oIDE's system prompt contract. It is how Review gets the "Agent's summary" and "Checks the agent ran" panels as structured data rather than parsed prose. Tile activity lines come from `tool_use` and `tool_result` events (Read, Edit, Bash and so on), and "Thinking…" or "Writing …" from partial messages. Diff counts on a tile come from `git diff --numstat` in the worktree, debounced after each edit. The Plan tab renders the latest todo-list tool input as a checklist, and the plan text from plan mode when the agent exits it.
### Subagents
The Wall's subagent chips and Focus's agent tree, subagent cards, Subagents tab, timeline and per-subagent transcript all come from one `SubagentTracker` inside each agent's event reducer. A subagent is a task the lead agent hands to the CLI's subagent tool; oIDE never starts subagents itself.
| Shown in the design | Derived from | Confidence |
| A subagent exists, its name and task text | The lead's `tool_use` of the subagent (Task) tool: its description and prompt | Firm |
| Model, effort, "routed as simple / standard / complex" | The `subagent_type` the lead picked, matched to the `--agents` definitions oIDE generated from the focus preset | Firm for the tier and model; effort is (guess), as above |
| Its own transcript (Read, Bash, Write lines) | Stream events tagged with the parent tool-use id of that Task call | (guess) that every subagent event carries the parent id in stream-json; verify in M1 |
| Status: running, done, needs permission, queued | Running from first tagged event until the Task `tool_result`; needs permission when a pending prompt belongs to it; queued when the Task call exists but no tagged event has arrived yet | Queued and permission attribution are (guess) |
| Its report to the lead | The Task `tool_result`, shown in the lead's transcript as the design says | Firm |
| Tokens and its own context ring, "Subagents have used 38% of this agent's tokens" | Usage blocks on its tagged assistant messages, summed per subagent and compared with the lead's total | (guess) that subagent usage is reported per message |
| Timeline over the agent's run | Start and end timestamps of each subagent, stored with the events | Firm once the events above work |
| Stop subagent | (open) No known way to stop one subagent alone. Fallback: deny its next tool call through the permission tool with a "stopped by user" message, so it reports back early | (open) |
| Steering | Messages go to the lead agent only, as the design states; there is no channel into a subagent | Firm |
The status bar's "6 subagents active" and the chip summaries ("2 of 3 running", "1 needs you") are counts over all trackers. Subagent permission prompts surface on the lead's tile and on the subagent's card, but are answered once.
### Context ring and plan usage
- Context ring. After each assistant message, used context = input tokens + cache-read tokens + cache-creation tokens from the message's usage block, divided by the model's context window from a table in `packages/protocol`. (guess) that these fields are enough; verify against the CLI's own context display. Colour thresholds and the "suggest /compact" level come from Settings › Agents › Context. oIDE never compacts without the confirm dialog.
- Plan usage meters (Session 62%, Week 38%, reset times). (open) There is no known documented source for subscription usage percentages. Options, in order of preference: a documented CLI command or event that reports them; parsing the CLI's usage screen in a hidden pty (fragile, avoid); or showing only what oIDE can measure (tokens and turns per agent, and rate-limit events with their reset time). v1 ships the last option and hides the percentage meters until a supported source exists.
- Plan name in Settings. Read from the CLI if it reports it; otherwise show "Signed in" without the plan name. (guess)
### Sign-in and CLI health
On launch, oIDE runs `claude --version` to find the binary and check it is in the tested range. Sign-in state is learned from the first agent's init event or an auth error. When signed out, the status bar and Settings show "Sign in", which opens a Raw terminal running `claude` so the user signs in through Anthropic's own flow. (guess) A dedicated auth-status command, if the CLI has one, replaces this probe.
## Projects and git worktrees
A project is a git repository the user opens; every agent in it gets its own worktree and branch by default, so six agents never edit the same files on disk. The Spawn screen's "Work in" choice picks between a new worktree from `main`, a new worktree from the current branch, or the project folder directly.
- Create. `git worktree add -b oide/<agent-slug> <path> <base>`. Default path is `<app-data>/worktrees/<project-id>/<agent-slug>`, outside the repo so file watchers and build tools in the main checkout ignore it. Settings › Agents › Worktree location can move it (for example to `<repo>/../<repo>.worktrees/`).
- Setup. After creation, oIDE runs the project's optional `.oide/setup` command (for example `pnpm install`), shown as a step on the tile. (guess) Most JS projects need this, and copying `node_modules` is not reliable across OSes.
- Project folder directly. Allowed, but only one agent at a time may hold the main checkout, and Bypass mode is refused there (Settings says Bypass agents stay in a worktree).
- Diff. Review and tile counts use `git diff <merge-base>...HEAD` plus uncommitted changes in the worktree. Agents may commit as they work; oIDE never rewrites their history.
- Finish. Review offers "Open pull request" (through the Git extension, which uses the user's own `gh` login or a GitHub token they add) and "Merge worktree into main locally" (`git merge --no-ff` in the main checkout, stopping on conflicts and handing them to a new agent if the user wants).
- Clean up. After merge or discard, `git worktree remove` and branch delete run on the schedule set in Settings (After 7 days, Right away, Never). A startup sweep runs `git worktree prune` and lists orphaned worktrees for the user to remove.
- Files screen. The worktree switcher at the top (main, worktree shell-layout, …) changes which checkout Monaco reads. "An agent is changing this file" comes from mapping the agent's Edit and Write tool events to paths, plus a watcher on each worktree.
Windows needs care: long paths (enable `core.longpaths`), file locks from running dev servers during `worktree remove`, and case-insensitive paths on Windows and macOS.
### Project scope and Source control
The project scope switcher (All projects, or one project) is one value in a shared renderer store, persisted per window. The Wall, Files and Source control all read it, so picking a project on any of them scopes the other two, as the design notes.
The Source control screen is a per-project view over the worktree manager, with Review now reached from it. Each project card is backed by:
| Card part | Backed by |
| Repo path, branch, "2 behind origin", Push / Pull | `git status --porcelain=v2 --branch` in the main checkout, plus a background `git fetch` every 10 minutes (guess at the interval; make it a setting) using the user's own git credentials |
| Your changes on main, Commit… | Uncommitted files in the main checkout; Commit opens a small message dialog and runs `git commit` |
| Agent worktrees: branch, base, "from main · 2 behind", status, files and +/− | Worktree manager per agent: `git rev-list --left-right --count` against the base, diff stats, the agent's tile state |
| PR state (Ready to open, Draft PR #18) | The Git extension's `gh pr view --json` per branch, refreshed on fetch; hidden when `gh` is missing or signed out |
| Review button and Ready to review panel | Opens Review for that worktree; the panel lists agents that called `oide.submit_for_review` |
| Recent commits on main with who made them | `git log` with the `Oide-Agent:` trailer mapped to agent names ("You, from an agent", "Scaffold agent") |
| Heads-up: two worktrees change the same file | After each diff refresh, intersect the changed-file sets of every pair of live worktrees in a project. Overlaps show as a warning; `git merge-tree --write-tree` then tells whether they truly conflict |
| Ask an agent to reconcile | Spawns an agent on a new worktree from the first branch, with the overlap and both branches in its goal |
| "docs-site has 1 unpushed commit" | The ahead count from the status call above |
Fetch, pull and push are the only git commands oIDE runs against a remote, and only fetch runs without a click.
## Screen by screen
Every screen on the Mission Control canvas maps to the services above as follows. Anything a screen shows that has no reliable data source is flagged here and in Open questions.
| Screen | What it shows and does | Backed by |
| Wall (Main) | Project scope switcher and Open project; project sidebar with agent counts; filter chips All / Needs you / Running / Review; one tile per agent with status, context ring, activity lines, diff counts, inline permission prompt, inline reply box, Review diff and Open PR; subagent chips (letter = model) with a summary such as "2 of 3 running"; Artifacts and Marketplace teasers; N jumps to the next agent that needs you | Supervisor event stream per agent, reduced into a `TileState` store; subagent chips from the `SubagentTracker`; diff counts from the worktree manager; permission prompts from the oIDE MCP server; scope from the shared scope store |
| Focus | Other agents list with J / K / N / Esc; lead agent and its subagent tree; transcript with tool calls, inline diffs and subagent cards; selecting a subagent shows its task, model, effort, route, tokens, own context ring and transcript, and Stop subagent; pinned permission prompt (Y / Always / D); composer ("type / for commands") with Attach artifact; Pause, Stop, Raw terminal; inspector tabs Plan, Changes, Subagents (timeline over the run, share of tokens), Artifacts, Terminal | Full event log from SQLite (virtualized list) plus live tail; subagent views from the `SubagentTracker`; Plan from todo-list events; Changes from the worktree manager; Terminal is a node-pty shell in the worktree; `/` commands are sent as user messages |
| Spawn agent | Goal with context chips (artifact, file, URL); project; Work in; permission mode with Auto as default and Bypass when allowed; focus presets (Balanced = Opus leading and routing subagents by task size) and Advanced model settings with effort per slot; Advanced techniques; Parallel attempts 1–6; extension tools for this agent | Builds an `AgentSpec` (validated by Zod) that the supervisor turns into flags, env, `--agents` JSON, `--mcp-config` and the first message. Presets and techniques come from settings (global plus `.oide/`) |
| Source control | Shared project scope; per-project cards with sync state, your changes on main and Commit, agent worktrees with status and PR state, Review, recent commits; Ready to review panel; heads-up for overlapping worktrees with Ask an agent to reconcile; unpushed-commit notice with Push | Worktree manager, git status and log, overlap detector, Git extension for PRs (see Projects and git worktrees) |
| Review changes (under Source control) | Changed files with counts; unified or split diff; Viewed checkboxes; inline comments that go to the agent; agent's summary and checks; Send feedback, Open pull request, Merge locally | Worktree manager diff; review threads stored in SQLite; "Send feedback" bundles comments as one user message with file:line references; summary and checks from `oide.submit_for_review` |
| Files | Shared project scope; with All projects, one tree per project, each with its own branch or agent-worktree menu; Monaco editor; banner when an agent is editing the file; Ask an agent about this; file history with agent attribution; Mentioned in (artifacts) | Monaco over the chosen checkout per project; agent attribution from `Oide-Agent:` commit trailers (guess: agents follow it reliably enough); language servers come from extensions |
| Artifacts | Grid filtered by Designs / Docs / Whiteboards and project; detail with preview, Open, Give to an agent, Open in claude.ai, agents using it, version history; Import from claude.ai; New artifact | Local artifact store (see Artifacts integration). "Agents using it" comes from oIDE MCP tool calls. claude.ai sync is (open) |
| Marketplace | Categories; search and sort; extension list; detail with tools it gives agents and their risk (read only, asks first); install; enable per project; Add custom (MCP server URL with OAuth, import from other apps, local command or JSON, extension from folder or git with developer reload); per-tool on/off for custom tools | Extension registry, the static marketplace index, and the custom tools service (see Extension system and marketplace) |
| Settings | Claude Code (CLI path, version, account, defaults, Allow Bypass toggle, extra flags); Models (presets, default focus, per-slot effort, model versions, Your models with Test connection); Agents (max running, worktree location, cleanup, context thresholds, notifications); Techniques (built-in and own, first message or `--append-system-prompt`, scope global or `.oide/techniques.json`); Permissions (defaults, always-allowed rules) | Settings service: global values in SQLite, project values in `.oide/*.json`, model API keys in `safeStorage`. Model version lists come from the CLI if it can list them, otherwise from a table shipped with oIDE (guess) |
| Status bar | CLI connected; sessions, worktrees and active subagents; plan with Session and Week meters and reset time on hover; projects open | Supervisor and subagent counts; plan usage source is (open) |
| Command bar (Ctrl K) | Spawn an agent, jump to a session, run a command | Command registry that core and extensions both contribute to |
Keyboard shortcuts (J, K, N, Y, D, Esc, Ctrl K, Ctrl Enter, Shift Tab) live in one keymap service so extensions and users can rebind them. They are scoped to the focused view and never registered as global OS shortcuts.
## Data and storage
State lives in three places: one SQLite database per install for anything personal or high-volume, a `.oide/` folder per project for anything a team should share through git, and the OS keychain for third-party secrets.
| Where | What | Notes |
| `<app-data>/oide.db` (SQLite, WAL mode) | projects, agents, subagents (task, tier, model, start and end, tokens), sessions (CLI session id, spec, status), events (raw CLI JSON plus normalized type), usage samples, review threads, artifacts index, installed extensions, custom MCP servers saved to "My settings", global settings, UI scope | Raw events are kept so a newer parser can re-read old sessions; events older than 30 days are compacted to summaries (guess at a sensible default) |
| `<repo>/.oide/config.json` | Project settings that override global ones: default mode, models preset, setup command | Committed to git if the team wants |
| `<repo>/.oide/techniques.json` | Project techniques from Settings › Techniques | Same shape as global techniques |
| `<repo>/.oide/permissions.json` | "Always in oide" rules and allow / ask / block defaults | Passed to agents as `--allowedTools` / `--disallowedTools` |
| `<repo>/.oide/extensions.json` | Extensions enabled for this project, with version ranges | Lets a team agree on agent tools |
| `<repo>/.mcp.json` | Custom MCP servers saved as "Project .mcp.json" | Standard Claude Code format, read by the CLI natively; secrets only as `${VAR}` placeholders |
| `<repo>/.oide/artifacts/` | Local artifacts (see below) | Optional; the user chooses per artifact whether it lives in the repo or only in app data |
| OS keychain via `safeStorage` | API keys for custom model endpoints, extension secrets, env secrets of custom MCP servers, OAuth tokens for remote MCP servers | Never Claude credentials |
| `<app-data>/agents/<id>/` | Generated `mcp.json`, appended prompt, logs | Deleted with the agent |
`<app-data>` is Electron's `userData` path: `%APPDATA%\oIDE` on Windows, `~/Library/Application Support/oIDE` on macOS, `~/.config/oIDE` on Linux. Schema changes go through Drizzle migrations that run at startup, with a backup of the database before each migration. The `.oide/` files each carry a `version` field and a JSON Schema in `packages/protocol`, so editors can validate them.
## Extension system and marketplace
An extension is an npm package with an `oide` manifest. Its main job is to give agents new tools through MCP; its second job is to add UI (panels, commands, themes, artifact types). Built-in features such as Git and Browser preview are shipped as extensions too, so the API is used from day one.
### Manifest
```
{
  "name": "@oide-community/postgres-inspector",
  "version": "1.2.0",
  "oide": {
    "engine": "^1.0.0",
    "displayName": "Postgres inspector",
    "categories": ["agent-tools"],
    "activation": ["onAgentSpawn", "onCommand:postgres.connect"],
    "main": "dist/host.js",
    "mcpServers": {
      "postgres": {
        "command": "node", "args": ["dist/mcp.js"],
        "tools": {
          "db.schema":  { "risk": "read" },
          "db.query":   { "risk": "read" },
          "db.explain": { "risk": "read" }
        }
      }
    },
    "contributes": {
      "panels": [{ "id": "pg.schema", "title": "Schema", "entry": "dist/panel.html" }],
      "commands": [{ "id": "postgres.connect", "title": "Connect database" }],
      "settings": { "postgres.url": { "type": "string", "secret": true } }
    },
    "capabilities": { "network": ["localhost"], "spawn": true }
  }
}
```
### Contribution points (v1)
| Point | What it adds | Runs where |
| `mcpServers` | Agent tools, each with a risk label (`read` or `ask`) | A stdio process the CLI starts, listed in the agent's `--mcp-config` |
| `panels` | A view in Focus's inspector or a full screen | A sandboxed iframe in the renderer, talking to its host code through `postMessage` |
| `commands` | Entries in Ctrl K | Host code in the extension host |
| `settings` | Fields in Settings, with `secret` stored in the keychain | Settings service |
| `themes` | Colour tokens | Renderer |
| `techniques` | Extra techniques shown in Spawn | Settings service |
| `artifactTypes` | A viewer and editor for a new artifact kind | Panel iframe |
| `languages` | A language server for the Files editor | Child process started by the host |
| `deployTargets` | A Review action such as "Create preview deploy" | Host code |
The extension API (`@oide/extension-api`) is a small typed surface: register commands, read and write settings, list agents and subscribe to their events, open panels, read artifacts, and post a message to an agent. Extensions cannot read other extensions' secrets or the raw event log of agents in projects where they are not enabled.
### Risk labels and permissions
Tools labelled `read` are added to the agent's allowed tools when the extension is enabled for that project. Tools labelled `ask` are never pre-allowed, so they always show a permission prompt on the tile, which matches the Marketplace copy ("Tools marked asks first always show a permission prompt"). The label is the author's claim, so the install dialog shows the full tool list and the declared `capabilities`. (open) A Node extension host cannot truly enforce `capabilities` on every OS; v1 shows them for consent, and a later version can run extension code under stricter OS sandboxes.
### Marketplace
- v1 index. A public GitHub repo (`oide-marketplace`) holds `index.json`: one entry per extension with its npm name, versions, categories, repo URL and the npm tarball's `integrity` hash. A PR adds or updates an entry; CI validates the manifest against the schema and checks the tarball hash.
- Install. oIDE fetches the index (cached, refreshed daily), downloads the tarball from the npm registry, verifies the hash, extracts it to `<app-data>/extensions/<name>@<version>`, and runs no install scripts. Extensions must ship bundled `dist/` code.
- Updates. The Updates count in the Marketplace compares installed versions with the index. Updates that add new tools or capabilities need the user's consent again.
- Later. Move to a registry service compatible with the Open VSX model once there is traffic, and add signed publishing (npm provenance or Sigstore).
### Custom tools (Add custom)
Add custom lets the user bring any MCP server or oIDE extension that is not in the marketplace. All four routes end in the same record: a named server, its tools with a risk label each, which tools are on, which projects it is on for, and where it is saved. The dialog warns that custom tools are not reviewed.
| Route | What oIDE does |
| MCP server URL | Connects with Streamable HTTP (falling back to SSE), reads server info and `tools/list`, and shows "Reached · Streamable HTTP · server v2.3". If the server answers 401, oIDE follows the MCP authorization flow: protected-resource metadata, dynamic client registration, PKCE in the system browser with a loopback redirect. The token goes to the keychain. |
| Import from other apps | Scans known config files read-only: Claude Desktop's `claude_desktop_config.json`, Claude Code's user MCP settings and each open project's `.mcp.json`, and other editors' MCP settings. Lists what it found, marks entries already added, and copies only the chosen `mcpServers` entries. Secrets in `env` move to the keychain. Nothing in those apps changes. |
| Local command or JSON | A command line (`npx …`, `uvx …`, `docker run …`) with env variables, or pasted JSON in the standard `mcpServers` format. Test it starts the server once and lists its tools. |
| Extension from folder or git | Reads the manifest and shows tools and permissions before running anything. Developer mode watches the folder and restarts the extension's host code and MCP servers on change. Publish to marketplace opens a PR against the index repo (guess: through `gh`). |
- Risk labels. Taken from the server's tool annotations (`readOnlyHint` means read only, `destructiveHint` or no hint means asks first); the user can click to change one, as the design says. Read-only tools join `--allowedTools`; turned-off tools join `--disallowedTools`.
- Where it is saved. "My settings (all my projects)" stores it in oIDE's database. "Project .mcp.json (shared through git)" writes the standard `.mcp.json` in the repo, which Claude Code also reads natively, so the team gets it without oIDE. Secrets never go into `.mcp.json`; oIDE writes `${VAR}` placeholders and supplies the values as env at spawn (guess: relies on the CLI's env expansion in MCP config).
- Remote servers and tokens. OAuth tokens stay in oIDE. Each remote server is reached by agents through a loopback proxy in the main process (`http://127.0.0.1:<port>/mcp/<server>`, with a per-agent secret header) that adds the token and refreshes it. Tool names stay `mcp__<server>__<tool>`. These are tokens for third-party services the user signed in to, never Claude credentials.
- Claude Code's own MCP servers. The CLI already loads the user's own MCP servers and project `.mcp.json` by itself. oIDE does not pass `--strict-mcp-config`, so those keep working; Import exists to show and manage them in one place and to bring in Desktop and editor servers.
## Artifacts integration
Artifacts in v1 are local files that oIDE stores, previews and hands to agents; syncing with claude.ai artifacts is not buildable today because there is no known public API for reading or writing them. The Artifacts screen is designed so that a sync source can be added later without changing how agents use artifacts.
| Kind | v1 storage format | Viewer and editor |
| Design | A self-contained HTML file (or a folder with one entry HTML) | Sandboxed iframe preview; agents edit the HTML |
| Doc | Markdown with front matter | Rendered preview plus Monaco for editing |
| Whiteboard | Excalidraw JSON (guess: Excalidraw is MIT-licensed and embeddable; tldraw's licence needs checking for an open-source app) | Embedded whiteboard component |
- Where they live. `<repo>/.oide/artifacts/<slug>/` when shared with the team, or `<app-data>/artifacts/` when personal. Each has `artifact.json` (title, kind, project, version) and its content. Versions are git commits for repo artifacts and numbered snapshots for personal ones, which backs the History list.
- How agents use them. The oIDE MCP server exposes `artifacts.list`, `artifacts.read`, `artifacts.write` and `artifacts.create`. Every call is logged, which fills "Agents using it" (reads / writes) and lets a tile say "1 doc artifact". "Give to an agent" opens Spawn with the artifact as a context chip.
- claude.ai today. "Open in claude.ai" works as a plain link when the artifact came from there. "Import from claude.ai" in v1 means the user pastes a link or drops an exported file and oIDE stores a copy, marked as imported, not synced. (open) Live sync needs either a public artifacts API or an official connector; ask Anthropic, and keep the `ArtifactSource` interface (`list`, `fetch`, `push`) ready for it.
- Extensions. New kinds (diagrams, API specs, slide decks) come in through the `artifactTypes` contribution point.
## Security
oIDE runs agents that execute shell commands, so the main risks are a malicious repo or extension reaching the user's machine, and an agent going further than the user allowed. The rules below are requirements for every milestone, not a later hardening pass.
- Electron hardening. `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` in every window; a strict Content Security Policy with no remote scripts; `webSecurity` on; navigation and `window.open` blocked except to an allow-list opened in the system browser; Electron fuses set to disable `RunAsNode` and Node CLI options in production builds.
- IPC. Every command is Zod-validated in main; file paths from the renderer are resolved and checked to sit inside a known project or worktree.
- Claude credentials. oIDE never reads, stores or forwards them (see Constraints). A unit test greps the codebase for known credential paths and fails the build if any appear outside the docs.
- Bypass mode. Only visible when Settings › Allow Bypass permissions is on; always runs in a worktree; refused in the project folder; the tile carries a persistent warning badge.
- Permission answers. The MCP permission handler only accepts answers from the renderer for the exact pending request id, and times out to deny if the app quits.
- Workspace trust. Opening a repo for the first time asks whether to trust it. Untrusted projects ignore `.oide/setup`, `.oide/permissions.json` allow rules and project MCP servers until trusted, since a cloned repo could otherwise pre-approve dangerous commands.
- Extensions. No install scripts; tarball hash checked against the index; UI only in sandboxed iframes with a `postMessage` API; host code in a separate utility process; secrets scoped per extension; consent shown again when an update adds tools or capabilities.
- Custom model endpoints. Keys stored with `safeStorage`; shown masked; sent only as env to that agent's process.
- Telemetry. Off by default. Crash reports are opt-in and strip paths, prompts and code.
- Supply chain. Lockfile committed; Dependabot or Renovate; release builds made only in CI from tagged commits.
Custom tools add three more rules:
- Importing other apps' configs. Files are opened read-only, only the `mcpServers` key is parsed, and the rest of the file is discarded unlogged. Claude Code's user config can hold account details next to its MCP servers, so this rule protects the Constraints too.
- Remote MCP tokens. Held only in the main process and the keychain; the loopback proxy binds to 127.0.0.1, checks a per-agent secret, and refuses other origins.
- Unreviewed code. Custom servers and local extensions show a "not reviewed" badge everywhere they appear, and developer-mode reload only works for folders the user picked, never for anything installed from the index.
## Packaging, updates and CI
electron-builder produces installers for all three OSes from a GitHub Actions matrix, with one build job per OS because node-pty, better-sqlite3 and @parcel/watcher are native modules that must be built against Electron's Node ABI on each platform.
| OS | Artifacts | Signing | Notes |
| Windows 10/11 (x64, arm64) | NSIS installer, portable zip | Authenticode, for example Azure Trusted Signing (open: needs an account) | Unsigned builds trigger SmartScreen warnings |
| macOS 12+ (arm64, x64) | DMG, zip for updates | Developer ID, hardened runtime, notarization (open: needs an Apple Developer account) | Universal binary or two builds |
| Linux (x64, arm64) | AppImage, .deb, .rpm; Flatpak later | AppImage and repo signing with GPG | Flatpak's sandbox complicates spawning the user's `claude` and git; ship it after v1 |
- Auto-update. electron-updater reading GitHub Releases, with stable and beta channels. Updates are signature-checked; Linux .deb and .rpm users update through their package manager.
- CI on every PR. Typecheck, lint, Vitest, and Playwright end-to-end tests on all three OSes against `fake-claude`. A nightly job runs a small smoke suite against a real `claude` binary using a maintainer's own sign-in on a self-hosted runner (guess: whether that is allowed should be part of the Anthropic question).
- CLI compatibility. `packages/protocol` records the tested CLI version range. A weekly CI job installs the latest CLI, records fresh event fixtures from a scripted session, and diffs them against the parser's expectations.
- Licence. (open) MIT or Apache-2.0 for the app and extension API; Apache-2.0 gives an explicit patent grant.
## Milestones
Build one working agent first, then the Wall, then review, then the ecosystem. Each milestone ends with a gate that is a real user flow, not a code checklist, and the next milestone starts only when it passes. Durations are left out on purpose until Georges decides how many agents work on it in parallel.
<embed {"id": ".36166", "h": "12632fa5", "caption": "milestones M0 to M7 \u00b7 each ends with a gate", "ref": "node/51ea9aa4-5f35"}> 
M1 is the riskiest step and the most valuable, because it proves the CLI integration and answers open questions 2, 6, 7 and 8. M4 can run alongside M3 if two agents work in parallel.
Handing this to Claude Code. Create the repo with a `CLAUDE.md` that links this brief and states the hard rules from Constraints. Work one milestone at a time: an agent turns the milestone into issues, writes the Zod schemas and `fake-claude` fixtures first, then implements against them. Record each decision that departs from this brief as a short ADR in `docs/adr/`.
## Open questions and risks
The two biggest risks are outside the code: whether Anthropic is comfortable with an open-source app driving many subscription sessions, and how stable the CLI's stream-json format stays. Everything else has a safe default that M0 to M2 can build on.
| # | Question or risk | Why it matters | Default until answered |
| 1 | Does Anthropic accept oIDE driving the user's own CLI, many sessions at once, on a Pro or Max plan? | Their docs mark subscription use in other products as an enforced area; users' accounts are at stake | Build as designed; ask before any public release; add an API-key mode as a fallback |
| 2 | Is stream-json stable enough to build on, and which control messages (mode change, interrupt) are supported? | The supervisor depends on it | Pin a tested CLI range, keep all parsing in one package, run the weekly fixture diff |
| 3 | Raw CLI or the Agent SDK pointed at the user's binary? | The SDK gives typed events and permission callbacks for free, but its docs say SDK developers should use API keys | Raw CLI behind `AgentDriver`; revisit once question 1 is answered |
| 4 | Where do plan usage percentages and reset times come from? | The status bar meters in the design | Show tokens per agent and rate-limit reset times; hide percentage meters |
| 5 | Is there an API or connector for claude.ai artifacts? | "Import from" and "Open in claude.ai", "synced from claude.ai" | Local artifacts plus manual import |
| 6 | Exact names for Auto mode, effort level and subagent model settings in the CLI | Spawn and Settings controls | Detect from `claude --help` at startup and hide controls the CLI lacks |
| 7 | Does `/compact` work when sent through stream-json input? | Context ring's compact action | Test in M1; fallback is to tell the user to compact from the Raw terminal |
| 8 | Do subagent events, usage and permission prompts carry the parent Task id in stream-json? | Every subagent view in the Wall and Focus | Test in M1; if not, show subagents from the lead's Task calls and results only, without their own transcript or context ring |
| 9 | Can one subagent be stopped on its own? | Stop subagent in Focus | Deny its next tool call with a stop message; otherwise hide the button |
| 10 | Per-subagent effort in `--agents` definitions | Effort per routed tier in presets | Apply effort to the lead only and label tiers by model |
| 11 | Plan limits with 6+ agents and their subagents | Users on Pro will hit limits fast; subagents multiply usage | Default "Max agents running at once" to 3, queue the rest, show limit errors clearly, show subagent token share |
| 12 | Extension and custom-tool sandboxing | A Node host cannot enforce declared capabilities; custom tools are unreviewed | Consent dialog, no install scripts, hash check, "not reviewed" badge; stricter sandbox later |
| 13 | Remote MCP servers whose OAuth does not support dynamic client registration | Add custom by URL | Let the user paste a client id, or a token as a header secret |
| 14 | Code signing accounts and costs (Apple, Windows) | Unsigned builds scare users | Ship unsigned betas to early users; sign before 1.0 |
| 15 | Licence (MIT or Apache-2.0) and name check for "oIDE" | Needed before the repo goes public | Apache-2.0 (guess) |
| 16 | Whiteboard library licence (Excalidraw vs tldraw) | Embedding terms | Excalidraw |
Technical risks worth tracking from day one: memory with 6 Monaco instances and long transcripts (virtualize, lazy-mount Monaco), Windows worktree cleanup with locked files, and native module rebuilds on every Electron upgrade.