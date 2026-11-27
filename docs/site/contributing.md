# Contributing

Thanks for helping. oIDE is an Electron + TypeScript + React monorepo. The full rules are in
[CONTRIBUTING.md](https://github.com/frostlogic-ab/oIDE/blob/main/CONTRIBUTING.md) and
[CLAUDE.md](https://github.com/frostlogic-ab/oIDE/blob/main/CLAUDE.md); this page is the short version.

## Hard rules

Every change must keep these. They protect users' Claude accounts:

1. Drive the user's own, unmodified `claude` CLI. Never bundle, patch or re-implement Claude Code.
2. Sign-in only through Anthropic's own flow (a terminal running `claude`). No login screen.
3. Never read, store, log or forward Claude credentials. Agent environments are built from an
   allow-list. `test/no-credentials.test.ts` fails the build if credential paths appear in code.
4. No direct HTTP calls to Anthropic's API on the user's plan.
5. No "Claude" in the product name or logo.
6. Respect plan limits: queue beyond Max running; never retry rate-limit errors in a tight loop.

## Set up

```sh
git clone https://github.com/frostlogic-ab/oIDE.git
cd oide
pnpm install
pnpm dev          # the app with hot reload
```

Node 22 or newer, pnpm 9, git 2.38 or newer. You do not need a Claude login to develop: tests drive
agents with `tools/fake-claude`, a scriptable fake CLI that replays recorded stream-json.

| Command | What |
| --- | --- |
| `pnpm typecheck` | TypeScript, every package |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest unit and integration tests |
| `pnpm e2e` | Playwright end-to-end tests against the built app |
| `pnpm wiki:lint` | Broken links and orphan pages in the wiki |
| `pnpm docs:dev` | This documentation site |
| `pnpm --filter @oide/desktop dist` | An unsigned installer for your OS |

On Windows, run Vitest from PowerShell or `cmd` with an upper-case drive letter in the working
directory (`C:\...`); a lower-case `c:\` or a Git Bash `/c/...` path makes every suite fail.

## Repo layout

```
apps/desktop/            Electron app: src/main, src/preload, src/renderer
packages/protocol/       Zod schemas: IPC contract, CLI events, manifest, .oide config
packages/agent-core/     Supervisor, CLI driver, stream-json parser, subagent tracker
packages/git/            git CLI wrapper, worktree manager, overlap detector
packages/store/          node:sqlite store, migrations, settings, artifacts
packages/mcp-server/     oIDE's own MCP server (permission prompt, submit_for_review, artifacts)
packages/extension-api/  Public API for extension authors
packages/extension-host/ Extension loader, registry, installer, custom tools, host process
packages/ui/             Shared React components, icons and design tokens
extensions/              Built-in extensions (git, browser-preview, themes)
tools/fake-claude/       Fake CLI for tests
tools/marketplace-index/ Marketplace index builder and validator
docs/wiki/               The product wiki (internals); docs/adr/ holds decisions
docs/site/               This site
```

## Conventions

- TypeScript `strict`, ES modules. Shared types come from `@oide/protocol`; do not redefine them.
- Parse, don't trust: every IPC message and every CLI line goes through a Zod schema. Unknown CLI
  events are logged and ignored, never thrown.
- Security rules apply to every change: hardened windows, Zod-validated IPC, paths checked against
  known roots, permission answers only for the exact pending request, workspace trust.
- Tests are co-located `*.test.ts`. New behaviour comes with tests; add a fake-claude fixture when you
  need a new CLI scenario.
- Dark UI built from the design tokens; real buttons, links and inputs with labels; 4.5:1 contrast.
- A decision that departs from the build brief gets a short ADR in `docs/adr/`.

## The wiki

`docs/wiki/` is the project's knowledge base: one page per package, screen or concept. When you change
code, update the page that describes it, add new pages to `docs/wiki/index.md`, and add a log entry
as its own file in `docs/wiki/log/` (`pnpm wiki:log new <op> "<title>"`). Start at the [wiki index](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/index.md).

## Pull requests

1. Fork and branch from `main`.
2. Run `pnpm typecheck && pnpm lint && pnpm test` before you push.
3. Describe the user-visible change and how you tested it.
4. Give the pull request a [Conventional Commits](https://www.conventionalcommits.org/) title:
   `feat: …` for a feature, `fix: …` for a bug fix, `feat!: …` for a breaking change, `docs: …`,
   `chore: …`, `ci: …` and the like for changes that do not need a release. Pull requests are
   squash-merged and the title becomes the commit message.

### How releases happen

Nobody tags releases by hand. After each merge to `main`,
[release-please](https://github.com/googleapis/release-please) keeps one release pull request open
(`chore: release X.Y.Z`) with the next version and the changelog built from the pull request
titles. A maintainer merges it when it is time to ship; CI then builds the Windows, macOS and Linux
installers and publishes them on [GitHub Releases](https://github.com/frostlogic-ab/oIDE/releases).
Details: [release-pipeline](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/release-pipeline.md)
in the wiki.

By contributing you agree that your contribution is licensed under the
[MIT licence](https://github.com/frostlogic-ab/oIDE/blob/main/LICENSE). Be kind; the project follows the
Contributor Covenant code of conduct.

## Extensions

Writing an extension does not need a change to oIDE: see the [extension author guide](/extensions/).
