# Publication readiness review (2026-11-25)

An adversarial pass over the tree and the full git history (43 commits, one branch, no remote yet)
before oIDE is published as open source under MIT. Scope: secrets and personal data, licensing,
trademark and affiliation, accuracy of the public docs, and repo hygiene. Code findings are reported,
not fixed; doc and data findings were fixed in the same commit as this page. The code issues were fixed on 2026-11-25 ("Publication fixes" in [the log](../log.md)); each is marked **Fixed (2026-11-25)** below. Related reviews:
[security](review-security.md), [conformance](review-conformance.md), [design](review-design.md).

## Verdict

No secret, key or token is in the tree or the history, so **no history rewrite is needed for
secrets**. Publishing is blocked by owner decisions, not by code: Anthropic's answer to
[open question 1](open-questions.md), claiming the `oide-dev` GitHub org before the name is public, and
choosing an npm scope. See the [checklist](#pre-publish-checklist-owner-only).

## 1. Secrets and personal data

Method: `git log -p --all --text` (5.7 MB) and `git grep` over tracked files, searching for token
shapes (`sk-ant-`, `sk-`, `ghp_`/`gho_`/`github_pat_`, `xox?-`, `AKIA`, `AIza`, JWTs, `npm_`, PEM
private keys), `.env` and credential file names, absolute home paths (`C:\Users\…`, `/Users/…`,
`/home/…`, temp and scratchpad paths), e-mail addresses, the owner's name, the company name, claude.ai
links, and org or account ids. Icons (`apps/desktop/build/icon.*`, `icons/*.png`) were scanned for
embedded text chunks (none: they are rendered from `icon.svg` by `tools/icons/build-icons.mjs`).

| Finding | Where | Severity | Action |
| --- | --- | --- | --- |
| Every token-shaped string is a test fixture (`sk-ant-api03-abcdefghijklmnop`, `ghp_abc…`, `AKIAABCDEFGHIJKLMNOP`, …) used by redactor and credential tests | `apps/desktop/src/main/reliability/*.test.ts`, `packages/*/test`, `test/security` | none | none |
| Owner's full name and personal Gmail address are the author and committer of all 43 commits | commit metadata only (not in any file) | owner decision | See checklist item 3. Cheap to change now: nothing has been pushed. |
| Absolute local path with the Windows user name and the session scratchpad id | `pages/review-design.md` (evidence folder), `pages/review-conformance.md` (`claude.exe` path) | low | **Fixed** in the tree (`<scratchpad>\…`, `%USERPROFILE%\…`). The old text stays in history (commits b57046e and later): a user name and a temp folder name, not a secret; no rewrite recommended. |
| Owner's first name in the build brief (`@Georges`, "(open) marks a question for Georges", "Georges should ask Anthropic…") | `docs/wiki/raw/build-brief.md` (immutable source) | low | Owner decision (item 8). In wiki pages it now reads "the maintainer". |
| Recorded CLI fixtures | `tools/fake-claude/fixtures/*.jsonl` | low | Mostly sanitised: `cwd`/`original_cwd` are `C:\work\repo`, `apiKeySource: "none"`, session ids are synthetic (`2222…`, `3333…`), no account, org, e-mail or plan fields, no MCP servers or plugins of the owner. **But** the compaction message in `real-basic-multiturn.jsonl` (line 55) kept the CLI's transcript path in its slug form, `C--Users-dev-AppData-Local-Temp-claude-<session id>-<session uuid>-scratchpad-repo`: the user name was replaced, the temp folder ids were not. **Fixed** in the tree (`C--work-repo`; all tests pass). The old string stays in history (e147b82): temp folder ids only, no rewrite needed. **Code issue:** the sanitizer in `tools/fake-claude/record.mjs` replaces the cwd literally (`\`, `\\`, `/` forms) but not the CLI's slugified project-folder form (`[:\\/.]` → `-`), so the weekly compat job could record this again. **Fixed (2026-11-25):** the recorder now scrubs every spelling of the home, cwd and temp folders (native, forward-slash, JSON-escaped, `\/`-escaped, lowercase drive, `/c/Users/…`, `/mnt/c/…`, `/private` temp, the slugified project-folder form), any other `Users`/`home` and temp folder, the user name as a word, e-mails (also `%40`), account/org/user ids (prefixed ids and `account`/`organization`/`user` `*Uuid`/`*Id`/`*Name`/`*Email` fields) and uuids; crafted-input tests in `tools/fake-claude/test/record.test.ts`. The same message quotes the CLI's commit-attribution reminder; harmless. |
| CLI help output (Anthropic's text), committed twice, byte-identical | `docs/wiki/raw/claude-cli-help-2.1.325.txt`, `tools/fake-claude/fixtures/help-2.1.325.txt` | low (copyright) | Kept for flag detection tests. Short functional text; the owner may prefer to keep only the fixture copy. |
| Build-brief embed markers carry claude.ai Docs node refs (`node/c972f4d3-da11`, `node/51ea9aa4-5f35`) | `docs/wiki/raw/build-brief.md` lines 53, 312 | very low | Truncated internal ids of the owner's private doc; not resolvable by anyone else and not a link. The two diagrams they stood for are missing from the public copy. |
| No claude.ai artifact or share links from the owner's account anywhere | n/a | none | `https://claude.ai/public/artifacts/abc…` and `x.claude.site` appear only as test inputs. |
| No company name, internal URL, machine name or third-party e-mail (outside licence texts in `THIRD_PARTY_NOTICES.md`) | n/a | none | none |

**Raw brief and design sources.** `docs/wiki/raw/build-brief.md` and `docs/wiki/raw/design/*.dc.html`
are exports of the owner's own private claude.ai documents. Neither contains a link back to them, an
account id or private data beyond the first name above. They do contain the frank planning text that
an outsider will read (for example, the brief's risk section on whether Anthropic accepts driving
subscription sessions). That is consistent with the README and the FAQ, so it is not embarrassing,
but it is the owner's call to publish it. The design files are the owner's own work and can be
published under MIT. They are not standalone pages: each loads a missing `./support.js` and holds
`{{accent}}`-style template slots, and each loads Inter and JetBrains Mono from Google Fonts when
opened. Recommendation: keep both (CLAUDE.md and many wiki pages cite them as the spec). Optionally
add a one-line README in `raw/design/` that says they are design-canvas exports, not runnable pages.

## 2. Licensing

- `LICENSE`: MIT, "Copyright (c) 2026 oIDE contributors". Valid. Optional: name the owner as the
  initial holder ("2026 <name> and oIDE contributors").
- Every `package.json` (root, `apps/desktop`, 9 packages, 3 extensions, 2 tools) declares `"license": "MIT"`.
  All are `private: true` except `@oide/extension-api` (`publishConfig.access: public`). The
  electron-builder `copyright` line matches.
- **`THIRD_PARTY_NOTICES.md` was stale.** Excalidraw (26389c6) and its tree (mermaid, radix, chevrotain,
  d3 types, …) were not listed, so `pnpm licenses:check` failed, and with it the `ci.yml` and
  `release.yml` jobs. **Fixed:** regenerated with `pnpm licenses:notices` (273 → 368 packages, all
  MIT-compatible; `--check` passes).
- **Code issue (notices generator, `tools/licenses/notices.mjs`).** The build copies Excalidraw's
  fonts (`dist/prod/fonts`, 14 MB: Assistant, Cascadia, Comic Shanns, Excalifont, Liberation, Lilita,
  Nunito, Virgil, Xiaolai, the CJK font) into `out/excalidraw-assets/fonts/` (`apps/desktop/excalidraw-assets.ts`).
  Their licences (OFL-1.1 for most, MIT for Comic Shanns) are not listed, and the published Excalidraw
  package has no LICENSE file, so its MIT copyright line is missing too ("No licence file is
  included"). Fix in the generator: add a fixed "Fonts bundled by Excalidraw" section with each
  family's licence and copyright, and embed Excalidraw's upstream MIT text. Do not hand-edit the file:
  `--check` compares it byte for byte. **Fixed (2026-11-25):** `tools/licenses/fonts.mjs` records all 12
  shipped font families (the 9 Excalidraw folders, Inter, JetBrains Mono, Monaco's Codicons), verified
  against the shipped files' WOFF2 name tables and upstream licence files; the notices have a "Bundled
  fonts" section with copyrights and the OFL / GPL texts, and Excalidraw's section carries its upstream
  MIT text. `licenses:check` fails for an unrecorded font folder, a disagreeing embedded licence, and
  (after a build) any font in `out/renderer` without a record. **Owner note:** Liberation Sans 1.05
  (Excalidraw's "Helvetica" fallback) is GPL-2.0 with the font exception, not MIT-compatible in the
  strict sense; it ships as a separate unmodified file with its licence and source pointer, recorded as
  an explicit exception. Removing the file instead means Excalidraw falls back to a CSP-blocked CDN
  request for that family.
- Inter and JetBrains Mono ship through `@fontsource/*` (OFL-1.1, full text in the notices). The app
  icon is original (`apps/desktop/build/icon.svg`, generated rasters). No Anthropic logo or asset is in
  the repo.
- No copied third-party source without attribution was found. The Code of Conduct is Contributor
  Covenant 2.1 and credits it. The ICO and ICNS writers are hand-written.

## 3. Trademark and affiliation

- The product name is oIDE everywhere (`productName`, `appId dev.oide.app`, `executableName oide`). No
  package or display name contains "Claude". `@oide/fake-claude` is a private test tool and describes
  what it fakes.
- Disclaimer present: README ("not made, endorsed or supported by Anthropic"; trademarks line), docs
  site home page, FAQ, and the site footer (`docs/site/.vitepress/config.ts`).
- **npm scope.** `@oide` on npm belongs to an unrelated maintainer ([open question 15](open-questions.md)).
  The docs told extension authors to run `npm install --save-dev @oide/extension-api`, which would
  install whatever that maintainer publishes. **Fixed:** `docs/site/extensions/api.md`,
  `docs/site/extensions/index.md`, `packages/extension-api/README.md` and `tools/marketplace-index/README.md`
  now say that the package is not on npm, warn against installing the `@oide` name, and give the
  interim options. No packages were renamed. The decision stays open (proposal: `@oide-dev`, which was
  free on 2026-11-24). No CI workflow publishes to npm.
- **Code issue.** `tools/marketplace-index/bundled/index.json` lists the built-ins with tarball URLs
  under `registry.npmjs.org/@oide/ext-*`. Installs are pinned by `integrity` (sha512, checked in
  `packages/extension-host/src/installer.ts`), so a foreign package cannot be substituted. But the URLs
  can never resolve to the project's packages. Regenerate them once the scope is chosen. **Fixed
  (2026-11-25):** built-ins are `source: builtin` with `oide-builtin:<name>@<version>` pseudo URLs (no npm
  URL); the installer refuses them, skips them in update checks, and a remote index cannot override a
  built-in name ([marketplace](marketplace.md#distribution-defaults)).
- **Code issue, highest priority.** `DEFAULT_INDEX_URL` (`packages/extension-host/src/installer.ts`)
  points at `raw.githubusercontent.com/oide-dev/oide-marketplace/main/index.json`, and the README,
  issue templates, docs base URL, `electron-builder.yml publish.owner` and the updater all assume the
  GitHub org `oide-dev`. Nobody has claimed it. Anyone who registers it after the repo goes public
  controls the index the app fetches and the update feed. The owner must claim it first (checklist item 2).
  **Fixed (2026-11-25), defaults made safe:** names live in `packages/protocol/src/distribution.ts`. The
  app fetches no remote index unless Settings › Extensions › Marketplace index URL is set (empty by
  default; a remote URL needs a native confirmation in main). `electron-builder.yml` has `publish: null`;
  the updater runs only when the build was given `OIDE_PUBLISH_OWNER` / `OIDE_PUBLISH_REPO` (repository
  variables read by `release.yml`), otherwise it is off and no release is uploaded
  ([packaging](packaging.md#auto-update-m7)). Remaining `oide-dev` links (README, issue templates,
  docs base URL, the Marketplace "Publish" link) are links, not fetches.
  The external-link allow-list also includes `oide.dev` (`apps/desktop/src/main/security/external.ts`);
  register the domain or drop it.

## 4. Accuracy of the public docs

Spot-checked against the merged code (HEAD 1d415c0). `pnpm docs:build` and `pnpm wiki:lint` pass.

Fixed:

- `CHANGELOG.md`: Unreleased now lists the Excalidraw/Monaco editors, the extension UI wiring, the UX
  wave, the reliability work and the gate tests, and records that every security finding is fixed. The
  0.1.0 known issues (B1 merge loses uncommitted work; UI contributions not wired) are marked as fixed
  since.
- `README.md`: the docs site is "to be published" at `oide-dev.github.io/oide` (it does not exist yet).
  `CLAUDE.md`: `extension-api` is "to be published", with the scope open.
- `docs/adr/0005`: marked as superseded by the embedded Excalidraw editor.
- Docs site: the extension status table, `api.md` (panels now open in Focus's inspector), `manifest.md`
  and `contributions.md` (panels in `oide-ext://` sandboxed frames, settings, themes, techniques, deploy
  targets, artifact types; `languages` deferred by ADR 0008), the Artifacts screen (Excalidraw, Monaco,
  compare, conflicts, rename and delete), Settings (Extensions and Diagnostics sections, shortcuts editor),
  Review and worktrees (local merge commits uncommitted changes first), Spawn and Focus (extension
  techniques and panel tabs), the security model and the FAQ. Publishing and marketplace pages note
  that the marketplace repo does not exist yet, so the app uses its bundled index.
- Wiki: `milestones.md` (M5 wiring, M6 editors, M7 npm scope), `open-questions.md` (Q1 owner and
  blocking, Q12/Q13 implemented defaults with the SEC-14 caveat, Q14, Q15, Q16 decided), `index.md`
  (ADRs 0005–0009), `desktop-shell.md` (`dev:web` is a desktop-package script).

Checked and correct: README commands and requirements (git ≥ 2.38 for `merge-tree --write-tree`), the
`dist`/`e2e` scripts, CONTRIBUTING steps, SECURITY scope, the CLAUDE.md hard rules (`test/no-credentials.test.ts`
exists; `maxRunning` default 3; `Oide-Agent` trailer), and the testing, storage (2 migrations),
packaging and constraints pages.

**Code issue.** Settings › Privacy shows "Share anonymous usage statistics". It is off by default, but no
code reads it and nothing is collected. Remove it, or label it "not implemented", so it does not
suggest telemetry that does not exist. **Fixed (2026-11-25):** the switch is gone; Privacy says "oIDE
has no telemetry". `ui.telemetry` stays in the schema, marked deprecated and unread, so old settings
parse; a test checks nothing reads it. **Superseded (2026-11-25, [ADR 0011](../../adr/0011-telemetry.md)):**
the product owner asked for analytics. Telemetry is now opt-in (Settings › Privacy › Share anonymous
usage analytics / Send crash and error reports, both off by default, a first-run question), sent from
main to Umami; see [telemetry](telemetry.md). `ui.telemetry` is still never read and is not consent.

## 5. Repo hygiene

- `.gitignore` covers `node_modules/`, `dist/`, `out/`, `release/`, `coverage/`, `*.log`, `.turbo/`,
  `.env*`, `test-results/`, `playwright-report/`, `.vite/`, `.claude/`, the VitePress cache and
  `.compat/`. **Added:** `.idea/`, `.vscode/`, `.eslintcache`, `*.tgz`. No tracked file matches an
  ignore rule. `.claude/` was never committed. No `.env`, key, certificate or database file was ever
  in history.
- Size: no tracked file and no blob in history is over 1 MB. The largest are `THIRD_PARTY_NOTICES.md`
  (776 KB after regeneration), `pnpm-lock.yaml` (284 KB) and `icon.icns` (72 KB). Prebuilt
  `dist/` of the built-in extensions and test fixtures are committed on purpose (no build step).
- No `console.log`/`debugger`/`.only` left in shipped sources. The only TODO is a mock diff line.
- GitHub files: bug and feature issue forms, `config.yml` (blank issues off; security advisory and docs
  links), the PR template, Dependabot, CodeQL. Workflows call scripts that exist: `typecheck`, `lint`,
  `test`, `wiki:lint`, `licenses:check`, `docs:build`, desktop `build`, Playwright. `ci.yml` and
  `release.yml` would have failed on the stale notices; fixed above.

## Pre-publish checklist (owner only)

1. **Ask Anthropic** ([open question 1](open-questions.md), and Q17 for CI using a maintainer
   sign-in) whether an open-source app that drives the user's own CLI in stream-json mode, many sessions
   at once, fits the Pro/Max terms. The brief makes this a condition for any public release.
2. **Claim the GitHub org `oide-dev`** now, before the name is public. Create `oide-dev/oide` (and
   later `oide-dev/oide-marketplace`). Enable private vulnerability reporting (SECURITY.md and the issue
   template rely on it), GitHub Pages (Actions source) for `docs.yml`, Dependabot and CodeQL, and branch
   protection on `main`. Decide about the `oide.dev` domain.
   **Update 2026-11-26:** the app repository is [frostlogic-ab/oIDE](https://github.com/frostlogic-ab/oIDE);
   the site, docs and package metadata link there, and the release feed defaults to it (no variables
   needed). Its one-time settings are in [release-pipeline](release-pipeline.md#one-time-repository-setup).
   `oide-dev/oide-marketplace` is still unclaimed, so the marketplace default stays off.
3. **Commit identity.** All 43 commits carry a personal Gmail address. Before the first push, either
   keep it, or rewrite author and committer to the GitHub noreply address
   (`git filter-repo --mailmap`, or a fresh squashed initial commit). After pushing, this cannot be undone.
4. **Choose the npm scope** for `@oide/extension-api` (proposal `@oide-dev`, open question 15). Claim
   it on npm, rename the package, update the docs and `bundled/index.json`, and publish with
   `--provenance` from CI with an `NPM_TOKEN` secret. Until then nothing is published.
5. **Signing** (open question 14): add the Azure Trusted Signing or `WIN_CSC_*` secrets, the Apple
   Developer ID, notarization secrets and `MAC_SIGNING_IDENTITY`, and optionally `GPG_PRIVATE_KEY` /
   `GPG_PASSPHRASE` (all listed in `.github/workflows/release.yml`). Without them releases are unsigned.
6. **Code of Conduct contact**: replace the "until a dedicated contact address is published" text in
   `CODE_OF_CONDUCT.md` with a real address (a project alias, not a personal inbox).
7. **Trademark search**: a USPTO/EUIPO search for "OIDE" before 1.0 (open question 15). Optionally put
   the owner's name in the `LICENSE` holder line.
8. **Raw sources**: decide whether to publish `docs/wiki/raw/build-brief.md` and `raw/design/` as they
   are (recommended: yes). If yes, consider replacing "@Georges" with "the maintainer" in the brief.
   This is the one edit to an immutable source; record it in the log.
9. **Done (2026-11-25).** ~~Have the code issues above fixed~~ before 1.0: Excalidraw font notices in the generator, the
   recorder's slugified-cwd sanitising, `bundled/index.json` tarball URLs after the scope decision,
   and the dead usage-statistics switch. After claiming the names, set the repository variables
   `OIDE_PUBLISH_OWNER` / `OIDE_PUBLISH_REPO` and, if wanted, the marketplace index default
   (see [packaging](packaging.md) and [marketplace](marketplace.md#distribution-defaults)).
