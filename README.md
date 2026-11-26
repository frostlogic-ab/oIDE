<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-wordmark.svg">
    <img alt="oIDE" src="docs/brand/logo-wordmark-light.svg" width="280">
  </picture>
</p>

# oIDE

**Mission Control for coding agents.** oIDE is an open-source desktop app (Electron + TypeScript +
React) that runs many Claude Code agents in parallel, across many projects, in one window.

Each agent is *your own, unmodified* `claude` CLI, launched as a child process in its own git worktree
and driven through its streaming JSON mode. oIDE never sees your Claude credentials and never calls
Anthropic's API itself: every model call goes through the CLI you installed and signed in to.

> oIDE is an independent project. It is not made, endorsed or supported by Anthropic.
> "Claude" and "Claude Code" are trademarks of Anthropic.

## What it does

- **The Wall**: one tile per agent with status, context ring, live activity, diff counts, inline
  permission prompts (Y / Always / D) and replies. Press **N** to jump to the next agent that needs you.
- **Focus**: one agent's full transcript, its subagent tree with per-subagent transcripts, a pinned
  permission prompt, a composer with `/` commands, and an inspector (Plan, Changes, Subagents, Artifacts, Terminal).
- **Spawn**: goal + context chips, project, worktree, permission mode, focus presets (e.g. Balanced:
  Opus leads and routes subagents by task size), techniques, extension tools, up to six parallel attempts.
- **Source control and Review**: every agent works on its own `oide/<slug>` branch in a worktree.
  Review its diff, leave inline comments that go back to the agent, then open a PR or merge locally.
  oIDE warns when two worktrees touch the same file.
- **Files, Artifacts, Marketplace, Settings**: a Monaco file view with agent attribution, local
  design / doc / whiteboard artifacts agents can read and write, MCP-tool extensions with risk labels,
  and settings stored per install or shared per project in `.oide/`.

## Privacy

Your code, prompts and paths stay on your computer. oIDE can send **anonymous usage analytics and
crash reports, opt-in only**: the first launch asks, both switches are off until you agree, and
Settings â€º Privacy turns them off at any time. Nothing sent contains code, prompts, file names or
paths, project or branch names, or Claude account information. `DO_NOT_TRACK=1` or `OIDE_TELEMETRY=0`
disables it; forks can point it at their own Umami or build without it. Details: [PRIVACY.md](PRIVACY.md).

## Requirements

- The [Claude Code CLI](https://docs.claude.com/en/docs/claude-code) installed and signed in (`claude`).
- git 2.38+ (for `git merge-tree --write-tree`). Optional: GitHub CLI `gh` for pull requests.
- Windows 10/11, macOS 12+, or Linux (x64/arm64).

## Develop

```sh
pnpm install
pnpm dev          # run the app with hot reload
pnpm test         # unit tests (agents run against tools/fake-claude, no login needed)
pnpm typecheck
pnpm lint
pnpm e2e          # Playwright end-to-end against the built app
pnpm --filter @oide/desktop dist   # build installers for this OS
```

User guide and extension author guide: the docs site in [docs/site/](docs/site/) (`pnpm docs:dev`),
published at https://getoide.com/. Repo layout, conventions and hard rules: [CLAUDE.md](CLAUDE.md). Product documentation lives in the
wiki at [docs/wiki/index.md](docs/wiki/index.md); decisions in [docs/adr/](docs/adr/).

## Status

Pre-1.0. See [docs/wiki/pages/milestones.md](docs/wiki/pages/milestones.md). Before a public 1.0 the
project needs Anthropic's confirmation that driving the user's own CLI this way fits the subscription
terms (see [open questions](docs/wiki/pages/open-questions.md)).

## License

[MIT](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (`pnpm licenses:notices`).
Please follow the [Code of Conduct](CODE_OF_CONDUCT.md); changes are listed in [CHANGELOG.md](CHANGELOG.md).
