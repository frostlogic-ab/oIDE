# oIDE: instructions for Claude Code

oIDE is an open-source (MIT) Electron + TypeScript + React desktop app that runs many Claude Code
agents in parallel, across many projects, in one window. Each agent is the user's own, unmodified
`claude` CLI, spawned as a child process in its own git worktree and driven through stream-json.

- Build spec: [docs/wiki/raw/build-brief.md](docs/wiki/raw/build-brief.md) (immutable source).
- UI spec: the Mission Control design screens in [docs/wiki/raw/design/](docs/wiki/raw/design/) (immutable source).
- Product knowledge: the wiki at [docs/wiki/index.md](docs/wiki/index.md). Read it before working; keep it current.

## Hard rules (from Anthropic's terms; never break these)

1. Drive the user's own, unmodified `claude` CLI. Never bundle, patch or re-implement Claude Code.
2. Sign-in only through Anthropic's own flow: open a terminal running `claude` (or `/login`). No login screen.
3. Never read, store, log or forward Claude credentials: no code may touch `~/.claude/.credentials.json`,
   the macOS keychain item for Claude Code, or OAuth tokens. Agent env is built from an allow-list.
   A unit test (`test/no-credentials.test.ts`) fails the build if credential paths appear outside docs.
4. No direct HTTP calls to Anthropic's API on the user's plan. Every model call goes through the CLI.
5. No "Claude" in the product name or logo. The product is **oIDE**. Copy may say "Claude Code CLI".
6. Respect plan limits: queue agents beyond Settings > Agents > Max running (default 3); never retry
   in a tight loop on rate-limit errors.

## Security rules (every milestone)

- Every BrowserWindow: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, strict CSP,
  `webSecurity` on, navigation and `window.open` blocked (allow-listed URLs open in the system browser).
- Every IPC command is Zod-validated in main against `packages/protocol/src/ipc.ts`. File paths from the
  renderer are resolved and checked to sit inside a known project, worktree or artifact folder.
- Permission answers are accepted only for the exact pending request id; pending prompts deny on quit.
- Untrusted projects ignore `.oide/setup`, `.oide/permissions.json` allow rules and project MCP servers.
- Bypass mode only when Settings > Allow Bypass is on, always in a worktree, never in the project folder.
- Extensions: no install scripts, tarball integrity checked, UI in sandboxed iframes, host code in a
  separate utility process, secrets scoped per extension.

## Analytics and telemetry (every task)

Telemetry is opt-in Umami, sent from main only ([ADR 0011](docs/adr/0011-telemetry.md)). For every change,
ask whether it needs a new or updated event, error report or performance measure, and add it if it
answers a product question.
- Events go only through the catalogue in `packages/protocol/src/telemetry.ts` (enums, booleans,
  bounded numbers, buckets; never free text). Prefer observing in main (`main/telemetry/observers.ts`).
- Never send paths, project/repo/branch names, agent titles or goals, prompts, model output, tool
  inputs, commit messages, artifact contents, extension settings, env values, visited URLs, Claude
  account data, or custom/local extension ids. No remote scripts in windows; no session recording.
- Nothing before consent; off means off at once. Tests and e2e never reach the network.
- Update [docs/wiki/pages/telemetry.md](docs/wiki/pages/telemetry.md) in the same change.

## Repo layout

```
apps/desktop/            Electron app: src/main, src/preload, src/renderer (electron-vite)
packages/protocol/       Zod schemas: IPC contract, CLI events, manifest, .oide config  (shared contract)
packages/agent-core/     Supervisor, AgentDriver, stream-json parser, SubagentTracker
packages/git/            Typed git CLI wrapper, worktree manager, overlap detector
packages/store/          node:sqlite store, migrations, repositories, settings, artifacts store
packages/mcp-server/     oIDE's own MCP server (permission prompt, submit_for_review, artifacts)
packages/extension-api/  Public API for extension authors (to be published to npm; scope open, see open question 15)
packages/extension-host/ Extension loader, registry, installer, custom tools, utility process
packages/ui/             Shared React components, icons and design tokens
extensions/              Built-in extensions (git, browser-preview, themes)
tools/fake-claude/       Scriptable fake CLI that replays stream-json fixtures (tests never need a login)
tools/marketplace-index/ Builds and validates the static marketplace index
docs/wiki/               The product wiki (see below); docs/adr/ holds ADRs
```

## Conventions

- TypeScript `strict`, ESM. Internal packages export `src/index.ts` directly (ADR 0002); relative
  imports use the `.js` suffix. Shared types come from `@oide/protocol`; do not redefine them.
- Storage is `node:sqlite` (ADR 0001). Terminals use `@lydell/node-pty` (ADR 0003).
- Parse, don't trust: every IPC message and every CLI line goes through a Zod schema. Unknown CLI
  event types are logged and ignored, never thrown.
- Tests: Vitest (`pnpm test`), co-located `*.test.ts`. Agent tests run against `tools/fake-claude`.
  E2E: Playwright for Electron (`pnpm e2e`).
- Commands: `pnpm install`, `pnpm dev`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm e2e`.
- Any decision that departs from the build brief gets a short ADR in `docs/adr/NNNN-title.md`.
- Commits made by agents carry an `Oide-Agent: <name>` trailer when made from inside oIDE.

## Design rules (from the Mission Control canvas)

Dark UI. Ground `#0E1013`, chrome `#0B0D10`, panel `#111418`, card `#15181D`, selected `#1E2430`,
borders `#232830` / `#262B33` / `#343A44`. Text `#E6E8EB` / `#C9CED6` / `#9AA3AE` / `#6B7584`.
Accent `#7AA2F7` (user-selectable: `#7FC8A9`, `#C4A7E7`, `#F2C078`), link `#9DBBFA`.
Status: running green `#7FC8A9`, needs-you amber `#F2C078`, review blue `#9DBBFA`, error red `#F08A8A`.
Inter for UI (13px base, 11-12.5px secondary), JetBrains Mono for code/paths. Radii 6/8/10/12px.
Header 44px, left rail 56px, status bar 26px. Inline stroke SVG icons (1.7 stroke), never emoji.
Real `<button>`/`<a>`/`<input>` with labels; `aria-label` on icon-only buttons; 4.5:1 text contrast.
Full token list: [docs/wiki/pages/design-system.md](docs/wiki/pages/design-system.md).

## The wiki (Karpathy-style LLM wiki)

`docs/wiki/` is a persistent, compounding knowledge base that the agents maintain:

- `raw/`: immutable sources (build brief, design screens, CLI help output). Never edit; add new sources.
- `pages/`: one markdown page per topic (a package, a screen, a concept, a decision). Agents own these.
- `index.md`: catalog of every page with a one-line summary. Update it when you add a page.
- `log/`: the chronological log, **one file per entry** so parallel PRs never conflict. One entry per
  ingest, decision, milestone or lint pass: `pnpm wiki:log new <op> "<title>"` creates
  `log/YYYY-MM-DD-<slug>.md` headed `## [YYYY-MM-DD] <op> | <title>` (op is `ingest`, `build`,
  `decision`, `review`, `lint` or `query`); fill in the body. Never edit or append to `log.md`: it is
  the frozen archive up to 2026-11-27. `pnpm wiki:log` prints the whole log in order.

Workflow: **ingest** (read a source, write or update the pages it touches, add cross-links
`[[page-name]]`-style as relative markdown links, log it), **query** (answer from the wiki; file
useful answers back as pages), **lint** (`pnpm wiki:lint`: broken links, orphan pages, pages missing
from the index, malformed log entries, anything appended to `log.md`). When you change code, update the page that describes it in the same change.
