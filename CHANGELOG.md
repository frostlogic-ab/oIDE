# Changelog

All notable changes to oIDE are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Pre-1.0 minor versions may break things.
The detailed build history lives in [docs/wiki/log.md](docs/wiki/log.md).

## [Unreleased]

### Added

- Auto-update through electron-updater on GitHub Releases, with stable and beta channels and a
  Settings › Updates section (channel, check now, current version, last check). Updates never install
  without consent and are off in development builds.
- Release CI: tag-driven Windows, macOS and Linux builds to a draft GitHub Release, with signing and
  notarization steps that run only when the signing secrets exist.
- Nightly real-CLI smoke job (opt-in, self-hosted runner) and a weekly CLI compatibility job that
  records fresh fixtures and opens an issue on drift; Dependabot and CodeQL.
- Documentation site (VitePress) with a user guide and an extension author guide.
- Open-source project files: Code of Conduct (Contributor Covenant 2.1), issue and pull request
  templates, this changelog, generated `THIRD_PARTY_NOTICES.md` (shipped in packaged builds, checked in
  CI with `pnpm licenses:check`) and an original app icon.

## [0.1.0] - 2026-11-24

First internal build. Not signed, not published.

### Added

- **Foundations**: pnpm monorepo, hardened Electron shell (context isolation, sandbox, no Node in the
  renderer, strict CSP, blocked navigation, Electron fuses), Zod-validated IPC contract in
  `@oide/protocol`, `node:sqlite` store with migrations and backups, CI on Windows, macOS and Linux,
  unsigned installers (NSIS, zip, dmg, AppImage, deb, rpm).
- **Agents**: the user's own Claude Code CLI driven over stream-json (`ClaudeCliDriver`), parser,
  supervisor with a queue and "Max running", subagent tracking through `parent_tool_use_id`, interrupt
  and permission-mode control requests, `/compact`, resume after restart, plan usage from rate-limit
  events. Verified against real CLI 2.1.325; tests run against `tools/fake-claude`.
- **oIDE MCP server**: permission prompt tool, `submit_for_review`, and `artifacts.*` tools.
- **Screens**: Wall (tiles, inline permission prompts, J/K/N), Spawn (presets, routed subagents,
  techniques, up to six attempts), Focus (transcript, subagent tree, composer, inspector), Source
  control, Review (inline comments back to the agent, PRs via `gh`, local merge), Files (Monaco with
  agent attribution), Artifacts (local designs, docs, whiteboards with history), Marketplace and Settings.
- **Git**: one worktree and `oide/<slug>` branch per agent, overlap detection, merge-tree conflict
  prediction, worktree cleanup and orphan detection.
- **Extensions**: `@oide/extension-api`, manifest schema, extension host in utility processes, MCP tools
  with `read` / `ask` risk labels, installer with integrity check and no install scripts, Add custom (MCP
  URL with OAuth, import from other apps, local command, folder or git), marketplace index tooling and
  the built-in git, browser-preview and themes extensions.
- **Settings and trust**: all Settings sections, custom model endpoints with keys in the OS keychain,
  model version pinning, project `.oide/` files, workspace trust and Bypass guard rails.
- **Product wiki** in `docs/wiki/` and ADRs 0001 to 0004.

### Security

- Adversarial security, brief-conformance and design-conformance reviews before release
  ([review-security](docs/wiki/pages/review-security.md)). Fixed the extension and custom-tool
  findings (native confirmations, origin-bound credentials, per-agent proxy secrets, project-scoped
  artifact reads); core findings are being fixed.

### Known issues

- Merging a worktree locally ignores uncommitted worktree changes (review blocker B1).
- Extension UI contribution points (panels, themes, techniques, languages, deploy targets, artifact
  types) are not wired yet.
- Builds are unsigned: Windows SmartScreen warns, and macOS needs a right-click › Open.

[Unreleased]: https://github.com/oide-dev/oide/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/oide-dev/oide/releases/tag/v0.1.0
