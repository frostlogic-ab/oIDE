# Changelog

All notable changes to oIDE are recorded here. The project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); pre-1.0 minor versions may break things.
The detailed build history lives in [docs/wiki/log.md](docs/wiki/log.md).

New entries are written by [release-please](https://github.com/googleapis/release-please) from the
Conventional Commit titles of merged pull requests, in the release pull request it keeps open on
`main`. Do not add entries by hand; give your pull request a good title instead. The pipeline is
described in [docs/wiki/pages/release-pipeline.md](docs/wiki/pages/release-pipeline.md).

## [0.2.0](https://github.com/frostlogic-ab/oIDE/compare/v0.1.0...v0.2.0) (2026-11-26)


### Added

* **agent-core:** agents sync their branch with the base at start and before review ([2cdb54f](https://github.com/frostlogic-ab/oIDE/commit/2cdb54f1f6963bf102fb23d307a3c8402bd23dc4))
* archive instead of PR when nothing to push ([a039289](https://github.com/frostlogic-ab/oIDE/commit/a039289c52aa7baafc09a71b7c66fe98a0e7375c))
* follow project conventions when creating PRs ([d69ad56](https://github.com/frostlogic-ab/oIDE/commit/d69ad56442769bf94319dfb44277982a78e53ad5))
* **git:** implement auto-stash functionality during merges ([1801249](https://github.com/frostlogic-ab/oIDE/commit/18012491580eb404ca2acc3916e927e1d354acac))
* open pull requests that follow the project's own conventions ([e9fd936](https://github.com/frostlogic-ab/oIDE/commit/e9fd936e0cd510e926d52f139105281c531eadde))
* **review:** push follow-up work to an open pull request ([99d0957](https://github.com/frostlogic-ab/oIDE/commit/99d0957fe7b4cbcbd6f084daa974a915a983b78a))
* **review:** push follow-up work to an open pull request ([077e55a](https://github.com/frostlogic-ab/oIDE/commit/077e55afb0b2813d391481b0358ff208dec97a4a))


### Fixed

* **agent-core:** status-only follow-ups return to Ready for review ([183de3c](https://github.com/frostlogic-ab/oIDE/commit/183de3ce107361a3a2907307595b2dca6de1d2c2))
* **agent-core:** status-only follow-ups return to Ready for review ([f0adb5a](https://github.com/frostlogic-ab/oIDE/commit/f0adb5a6fdc7173e44a796d7553f2ac5b3ef30fa))
* **diagnostics:** never put a raw userData path in the report; fix e2e races ([ef85bbe](https://github.com/frostlogic-ab/oIDE/commit/ef85bbe187ca2c439ada1f2c94ebbe0f24ad564b))
* **files:** Enter no longer runs the same search twice; fix editor test race ([e031715](https://github.com/frostlogic-ab/oIDE/commit/e031715408b5276304cf399c40ba9518898f6010))
* fix CSP eval error in artifact preview ([9db87d6](https://github.com/frostlogic-ab/oIDE/commit/9db87d6ddc7fa7164c9460ed13e5af4af61609b2))
* let artifact previews run claude.ai Design exports (allow eval in artifact CSP) ([63df1f7](https://github.com/frostlogic-ab/oIDE/commit/63df1f7c1b48a204de37c8f133b63c455b9c7764))
* make CI green on main (SEC-34 check, Windows holder scan, diagnostics redaction, test races) ([c073c04](https://github.com/frostlogic-ab/oIDE/commit/c073c04676626271ac14d8b74490e792da23e0bc))
* **reliability:** stop the Windows holder scan from autoloading modules ([277bb5c](https://github.com/frostlogic-ab/oIDE/commit/277bb5ceb7d1840b53248486de9105b4177b2ebf))


### Security

* custom model env allow-list with value checks, unspoofable confirmations ([896ca5d](https://github.com/frostlogic-ab/oIDE/commit/896ca5d025354361611aa81319531e5564e42ff3))
* restrict custom model env, bind keys to env, dedicated CLI picker ([ea5cbd9](https://github.com/frostlogic-ab/oIDE/commit/ea5cbd998bd5a6221eb9e3fc08cc8f50190fcbad))

## 0.1.x (after 0.1.0, before automated releases)

Hand-written notes for the work that landed between the internal 0.1.0 build and the first release
cut by release-please. It ships in that first release.

### Added

- Opt-in usage analytics and crash and error reports (Umami), sent from the main process only: a
  first-run question, two switches in Settings › Privacy (both off by default), `DO_NOT_TRACK` and
  `OIDE_TELEMETRY=0` respected, no code, prompts, paths or project information ever sent. See
  [PRIVACY.md](PRIVACY.md).
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
- Artifact editors: embedded Excalidraw for whiteboards (supersedes ADR 0005), Monaco for docs and
  designs, compare any two versions, rename and delete, and conflict handling when an agent saves
  while you have unsaved edits.
- Extension UI contribution points wired: panels (sandboxed `oide-ext://` frames), commands,
  Settings › Extensions, themes, techniques, deploy targets and artifact types (ADRs 0008, 0009;
  `languages` is deferred).
- Toasts, a live status bar, a shortcuts editor, `/` slash commands and the Review comment side
  (ADRs 0006 and 0007, store migration 2).
- Reliability: per-service crash isolation, rotating redacted logs, Settings › Diagnostics, ordered
  shutdown and Windows process-tree cleanup.
- Milestone gate tests for M2 to M6 (`test/gates/`) and an end-to-end gate spec.

### Security

- All core findings of the 2026-11-24 review are fixed (SEC-01 to SEC-31; one accepted risk), including
  a custom model env allow-list with value checks and confirmations a renderer cannot spoof.
- Local merge now keeps uncommitted worktree changes (review blocker B1).

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
  artifact reads); core findings were still open in this build (fixed since, see 0.1.x).

### Known issues

- Merging a worktree locally ignored uncommitted worktree changes (review blocker B1; fixed since).
- Extension UI contribution points (panels, themes, techniques, languages, deploy targets, artifact
  types) were not wired yet (wired since, except `languages`).
- Builds are unsigned: Windows SmartScreen warns, and macOS needs a right-click › Open.

[0.1.0]: https://github.com/frostlogic-ab/oIDE/releases/tag/v0.1.0
