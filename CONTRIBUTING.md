# Contributing to oIDE

Thanks for helping. Please read [CLAUDE.md](CLAUDE.md) first: it holds the hard rules every change
must keep (no Claude credentials, no direct Anthropic API calls, the user's own unmodified CLI only).

1. Fork and branch from `main`.
2. `pnpm install`, then `pnpm typecheck && pnpm lint && pnpm test` before you push.
3. New behaviour comes with tests. Agent behaviour is tested against `tools/fake-claude`; add a
   fixture under `tools/fake-claude/fixtures/` when you need a new CLI scenario.
4. Update the wiki page that describes what you changed (`docs/wiki/pages/`), add it to
   `docs/wiki/index.md` if it is new, and add a log entry with `pnpm wiki:log new <op> "<title>"` (one file in `docs/wiki/log/`;
   never append to `docs/wiki/log.md`). Run `pnpm wiki:lint`.
5. A change that departs from the build brief needs a short ADR in `docs/adr/`.
6. Consider analytics: does the change need a new or updated telemetry event, error report or
   performance measure? Events go only through `packages/protocol/src/telemetry.ts` and must follow
   the privacy rules in [docs/wiki/pages/telemetry.md](docs/wiki/pages/telemetry.md).
7. Open a pull request describing the user-visible change and how you tested it. Its **title must
   follow [Conventional Commits](https://www.conventionalcommits.org/)** (`feat: …`, `fix: …`,
   `docs: …`, `feat!: …` for a breaking change): pull requests are squash-merged, the title becomes
   the commit on `main`, and release-please builds the version bump and `CHANGELOG.md` from it. The
   `PR title` check enforces this. Do not edit `CHANGELOG.md` or version numbers by hand; see
   [docs/wiki/pages/release-pipeline.md](docs/wiki/pages/release-pipeline.md).

Extensions are published through the marketplace index; see `tools/marketplace-index/README.md`.
