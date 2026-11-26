# Release pipeline

How a merged pull request becomes a published oIDE release with installers for every platform.
Nobody tags, bumps versions or edits `CHANGELOG.md` by hand. Repository:
[frostlogic-ab/oIDE](https://github.com/frostlogic-ab/oIDE); downloads:
[GitHub Releases](https://github.com/frostlogic-ab/oIDE/releases). Installer targets, signing and
auto-update: [packaging](packaging.md).

## The flow

```
 PR (Conventional Commit title)            .github/workflows/pr-title.yml checks the title
        │ squash-merge
        ▼
 main ──► release-please.yml ──► opens / updates the release PR  "chore: release X.Y.Z"
                                  (package.json + apps/desktop/package.json version, CHANGELOG.md)
        │ maintainer merges the release PR
        ▼
 main ──► release-please.yml ──► DRAFT GitHub Release vX.Y.Z + tag vX.Y.Z
                              └─► calls release.yml with tag vX.Y.Z
                                   verify    tag == app version; typecheck, lint, test, licences
                                   build     Windows, macOS, Linux in parallel; electron-builder
                                             uploads installers + latest*.yml / beta*.yml to the draft
                                   finalize  SHA256SUMS (+ GPG .asc), then publish the release
```

1. **Merge pull requests.** Every PR is squash-merged into `main`; its title becomes the commit
   message, so it must follow [Conventional Commits](https://www.conventionalcommits.org/) (below).
2. **release-please opens a release PR.** On every push to `main`,
   [release-please](https://github.com/googleapis/release-please) (`release-please.yml`) reads the
   commits since the last release. If any of them is releasable (`feat`, `fix`, `perf`, `security`,
   `deps`, `revert` or a breaking change), it opens or updates one PR titled `chore: release X.Y.Z`.
   That PR bumps `version` in the root `package.json` and `apps/desktop/package.json` (the version
   electron-builder ships and the updater compares), updates `.release-please-manifest.json` and adds
   a section to `CHANGELOG.md`. Later merges update the same PR, so it always shows what the next
   release would contain.
3. **Merge the release PR to ship.** release-please then creates a **draft** GitHub Release `vX.Y.Z`
   with the changelog section as its notes, and the tag `vX.Y.Z` on the merge commit
   (`force-tag-creation`, because GitHub does not create tags for drafts and release-please needs
   the tag to find the previous release). In the same run the `release` job calls `release.yml`:
   - **verify** checks out the tag, fails unless the tag is `v` + `apps/desktop/package.json`
     version, and runs typecheck, lint, test and the licence check.
   - **build** runs on `ubuntu-latest`, `windows-latest` and `macos-latest`. electron-builder
     (`--publish always`, `releaseType=draft`) finds the draft release by its tag and uploads the
     installers (Windows NSIS + zip, macOS dmg + zip, Linux AppImage + deb + rpm, x64 and arm64) and
     the update files. Signing per platform only when its secrets exist ([packaging](packaging.md)).
   - **finalize** adds `SHA256SUMS` (and detached GPG signatures when `GPG_PRIVATE_KEY` is set), then
     **publishes** the release: marked *latest* for a plain version, *pre-release* for a version like
     `0.3.0-beta.1`.

Until finalize, the release is a draft: electron-updater and the site's download buttons
(`/releases/latest`) cannot see it, so no user ever gets a release with missing files. If any
platform fails, the release stays a draft; fix the cause and use **Re-run failed jobs** on the run.

## Versions

| Commit on main | Before 1.0 (now) | From 1.0 |
| --- | --- | --- |
| `fix: …`, `perf: …`, `security: …`, `deps: …` | patch (0.2.0 → 0.2.1) | patch |
| `feat: …` | minor (0.2.0 → 0.3.0) | minor |
| `feat!: …` or a `BREAKING CHANGE:` footer | minor (`bump-minor-pre-major`) | major |
| `docs`, `chore`, `ci`, `test`, `refactor`, `build`, `style` | no release (hidden in the changelog) | no release |

- Force a version with a `Release-As: 1.0.0` line in the body of a commit on `main` (for example in
  the squash-merge message). Use it for 1.0 and for betas: `Release-As: 0.3.0-beta.1` gives a
  pre-release on the beta update channel (`beta*.yml`, [packaging](packaging.md#auto-update-m7)).
  The next normal release after a beta needs `Release-As` too (e.g. `0.3.0`), otherwise the default
  strategy bumps past it.
- Changelog sections (`release-please-config.json` → `changelog-sections`): Added (`feat`), Fixed
  (`fix`), Performance, Security, Reverted, Dependencies. Breaking changes get their own section.
- The manifest started at `0.1.0` (the internal build). The hand-written notes for the work after
  0.1.0 stay in `CHANGELOG.md` under "0.1.x" below the first automated entry.

## Writing pull request titles

`type(optional scope): summary`, lower-case type, imperative summary. `pr-title.yml` rejects
anything else (it reads the title through the API into a shell variable; nothing from the PR is
expanded into the script, see SEC-34 in [packaging](packaging.md#ci-and-release-workflows)).

```
feat(wall): filter tiles by status
fix: keep uncommitted worktree changes on local merge
feat!: drop the legacy .oide/config.json format
docs: describe the release pipeline
chore(deps): bump electron to 45.5
```

Agents working inside oIDE commit freely on their `oide/<slug>` branches; only the squash-merged
PR title reaches `main`. A branch merged locally (Review › Merge) keeps its own commit messages, and
release-please only counts the ones that follow the convention, so ship user-visible work through a
GitHub pull request.

## Files

| File | Role |
| --- | --- |
| `release-please-config.json` | Root package `.`, `release-type: node`, `draft` + `force-tag-creation`, `bump-minor-pre-major`, changelog sections, `extra-files` → `apps/desktop/package.json` `$.version` |
| `.release-please-manifest.json` | Last released version (release-please updates it in the release PR) |
| `.github/workflows/release-please.yml` | Push to `main`: release PR or draft release; calls `release.yml` when a release was created |
| `.github/workflows/release.yml` | Reusable (`workflow_call` with `tag`) and manual (`workflow_dispatch`): verify, build per OS, finalize and publish |
| `.github/workflows/pr-title.yml` | Conventional Commit check on PR titles |
| `CHANGELOG.md` | Written by release-please; do not edit by hand |

`release.yml` has no `push: tags` trigger: release-please calls it directly. A tag created with
`GITHUB_TOKEN` would not start a workflow anyway, and one created with a personal token would start
a second build racing the first.

## One-time repository setup

1. **Settings › General › Pull Requests:** allow squash merging with "Default to pull request
   title" (optionally turn off merge commits and rebase merging).
2. **Settings › Actions › General › Workflow permissions:** tick "Allow GitHub Actions to create and
   approve pull requests" (release-please opens the release PR).
3. **Optional `RELEASE_PLEASE_TOKEN` secret.** PRs opened with the default `GITHUB_TOKEN` do not
   trigger other workflows, so the release PR shows no CI or PR-title checks. If branch protection
   requires checks, add a fine-grained token or GitHub App token with Contents, Pull requests and
   Issues read/write; the workflow uses it when present. (The release build re-runs every check
   before anything is published either way.)
4. **Branch protection on `main`** (recommended): require the CI and PR title checks.
5. **Pages:** Settings › Pages › Source "GitHub Actions" for the docs site
   (`docs.yml`, `https://frostlogic-ab.github.io/oIDE/`, base `/oIDE/`, [docs-site](docs-site.md)).
6. **Signing (optional):** the secrets and variables listed in the header of `release.yml`.

Repository variables the release reads (all optional):

| Variable | Default | Effect |
| --- | --- | --- |
| `OIDE_PUBLISH_OWNER` / `OIDE_PUBLISH_REPO` | the repository running the workflow (`frostlogic-ab` / `oIDE`) | Release feed compiled into the app (updater) and the upload target |
| `OIDE_RELEASE_KEEP_DRAFT` | unset | `true` leaves finished releases as drafts for a maintainer to publish by hand |

## Manual runs and recovery

- **A build failed:** the release is still a draft. Fix the cause on `main` if needed, then
  **Re-run failed jobs** (same tag), or run **Actions › Release › Run workflow** with the tag.
- **Rebuild a published release:** turn it back into a draft in GitHub Releases first
  (electron-builder does not upload into a published release), then run the Release workflow with
  the tag.
- **Try the installers without releasing:** run the Release workflow with an empty tag; the
  installers are attached to the run as artifacts (14 days) and nothing is published.
- **Local build:** `pnpm --filter @oide/desktop dist` (unsigned, no publish), see
  [packaging](packaging.md#local-commands).
