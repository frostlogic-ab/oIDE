## Summary

<!-- What changes for the user, and why. Link the issue it closes (Closes #123). -->

## How I tested it

<!-- Unit tests, fake-claude fixtures, e2e, manual steps (OS, CLI version). -->

## Checklist

- [ ] `pnpm typecheck`, `pnpm lint` and `pnpm test` pass locally
- [ ] New behaviour has tests (agent behaviour against `tools/fake-claude`)
- [ ] The wiki page describing this area is updated (`docs/wiki/pages/`), and `docs/wiki/index.md` if a page was added
- [ ] A log entry is added as its own file in `docs/wiki/log/` (`pnpm wiki:log new`); `pnpm wiki:lint` passes
- [ ] The hard rules in `CLAUDE.md` still hold: the user's own unmodified CLI, no Claude credentials read/stored/logged, no direct Anthropic API calls, no "Claude" in the product name or logo
- [ ] Security rules hold (Zod-validated IPC, path checks, sandboxed windows and iframes)
- [ ] A departure from the build brief has a short ADR in `docs/adr/`
- [ ] User-visible changes are listed under `[Unreleased]` in `CHANGELOG.md`
