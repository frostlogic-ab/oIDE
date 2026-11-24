# Contributing to oIDE

Thanks for helping. Please read [CLAUDE.md](CLAUDE.md) first: it holds the hard rules every change
must keep (no Claude credentials, no direct Anthropic API calls, the user's own unmodified CLI only).

1. Fork and branch from `main`.
2. `pnpm install`, then `pnpm typecheck && pnpm lint && pnpm test` before you push.
3. New behaviour comes with tests. Agent behaviour is tested against `tools/fake-claude`; add a
   fixture under `tools/fake-claude/fixtures/` when you need a new CLI scenario.
4. Update the wiki page that describes what you changed (`docs/wiki/pages/`), add it to
   `docs/wiki/index.md` if it is new, and append an entry to `docs/wiki/log.md`. Run `pnpm wiki:lint`.
5. A change that departs from the build brief needs a short ADR in `docs/adr/`.
6. Open a pull request describing the user-visible change and how you tested it.

Extensions are published through the marketplace index; see `tools/marketplace-index/README.md`.
