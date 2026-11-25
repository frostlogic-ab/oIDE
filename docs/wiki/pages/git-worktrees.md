# Git worktrees (`packages/git`)

Typed wrapper over the system `git` (and optionally `gh`) that backs Source control, Review, the
tile diff counts and the Files history. Source: [../raw/build-brief.md](../raw/build-brief.md),
"Projects and git worktrees" and "Project scope and Source control". Related:
[storage.md](storage.md) (where agents and their worktree paths are recorded),
security (trust and bypass rules; `security.md` once written), [architecture.md](architecture.md).

## Runner (`git.ts`)

- `new Git({ cwd, gitBinary?, timeoutMs?, env? })`; `run(args, { okExitCodes, input, env, timeoutMs })`,
  `out()`, `test()`, `revParse()`, `currentBranch()`, `branchExists()`, `at(cwd)`.
- Always `execFile` with an argument array, never a shell. Every call gets `-c core.quotepath=false
  -c color.ui=false`, plus `-c core.longpaths=true` on Windows.
- Env: the user's environment unchanged (their credential helper, SSH agent, config) plus
  `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, empty `GIT_ASKPASS`/`SSH_ASKPASS`, and English
  messages. git never waits for a human.
- Failures reject with `GitError { args, exitCode, stderr, stdout, timedOut }`.
- Functions accept `Repo = string | Git`.
- `stream(args, { onStdout, signal, okExitCodes, cwd, env })` spawns the same hardened git (same
  binary, env, config overrides and diff flags) and streams stdout without a size cap; aborting the
  signal kills the process tree (`taskkill /T` on Windows, where `git.exe` is a launcher). Used by
  Files › Search (`git grep -l`, see [screen-files](screen-files.md#search)).
- `runShellCommand(cwd, command, { onOutput, signal, timeoutMs })` runs a user command line (the
  `.oide/setup` command) through the platform shell explicitly (`cmd.exe /d /s /c`, `/bin/sh -c`).
  **The caller checks workspace trust**; untrusted projects must not reach it.

## Worktrees (`worktrees.ts`)

`new WorktreeManager({ appDataDir, location?: 'app-data' | 'sibling', gitBinary?, timeoutMs? })`

| Method | What it does |
| --- | --- |
| `create({ projectPath, projectId, agentSlug, base, location? })` | `git worktree add -b oide/<slug> <path> <base>`. `base`: `'main'` (default branch: `origin/HEAD`, else `main`, `master`, `init.defaultBranch`; local if present, else `origin/<name>`), `'current'` (main checkout's branch, or HEAD sha when detached) or any ref. Slug is `slugify()`d and made unique (`-2`, `-3`) against branches, folders and registered worktrees. Returns `{ path, branch, slug, baseRef, baseSha }`; store `baseRef` for later diffs. Refuses repos without commits and unsafe project ids. |
| `root(projectId, projectPath, location)` | `<app-data>/worktrees/<project-id>` or `<repo>/../<repo>.worktrees` |
| `list(projectPath)` | `git worktree list --porcelain -z` → `WorktreeEntry[]` (first is the main checkout) |
| `remove(projectPath, path, { force, deleteBranch, retries=5, delayMs=300 })` | `git worktree remove`, retried with exponential backoff on Windows lock errors (EBUSY, access denied, directory not empty). With `force`: `--force --force`, and as last resort deletes the folder and prunes. Refuses the main checkout. A dirty worktree without `force` throws. |
| `prune(projectPath)` | `git worktree prune -v` (startup sweep) |
| `orphans(projectPath, projectId, knownPaths)` | Worktrees under our two roots that no known agent owns, plus leftover folders git no longer lists (`registered: false`) |
| `runSetup(path, command, opts)` | Streams the setup command's output |
| `aheadBehind(cwd, branch, base)` | `rev-list --left-right --count base...branch` |
| `info({ projectId, path, branch, baseRef, agentId? })` | A protocol `WorktreeInfo` (ahead/behind, `DiffStat`, changed files; `orphaned` when the folder is gone) |

Path comparisons go through `pathKey()` / `samePath()` / `isInside()` (`paths.ts`), which case-fold
on Windows and macOS. git prints `C:/x` on Windows; entries are normalised to native paths.

## Status, diffs, log (`status.ts`, `diff.ts`, `patch.ts`, `log.ts`)

- `status(repo)` parses `git status --porcelain=v2 --branch -z --untracked-files=all` (with
  `GIT_OPTIONAL_LOCKS=0` so background polling never takes `index.lock` from an agent);
  `syncState(repo, { lastFetchAt })` → protocol `SyncState`.
- Diffs compare **the merge-base with the base ref against the working tree**, which equals
  `git diff <merge-base>...HEAD` plus uncommitted changes with each file counted once; untracked,
  non-ignored files are added (text files get a synthesized `@@ -0,0 +1,N @@` patch; NUL bytes or
  > 2 MB → binary). `includeUncommitted: false` restricts to commits.
  - `diffStat(worktree, base)` → `DiffStat`; `numstat()`; `changedFiles()`; `fileDiffs()` → `FileDiff[]`
    (`patch` is the hunk text from the first `@@`).
  - Diff flags override user config: `--no-ext-diff --no-textconv --no-color --src-prefix=a/ --dst-prefix=b/ -M`.
- `parseUnifiedDiff(text)` is a tolerant parser (renames, copies, new/deleted, mode-only, both binary
  forms, quoted/octal-escaped paths, CRLF, `\ No newline`); hunk bodies are consumed by their line
  counts so content that looks like a header is safe. `parseHunks(patch)` gives numbered lines for
  the Review UI.
- `log(repo, ref='HEAD', limit=20)` and `fileHistory(repo, path)` → `CommitInfo[]` with `agent` from
  the `Oide-Agent:` trailer (`%(trailers:key=Oide-Agent,valueonly)`), `message` = subject,
  `body` = the rest, `ts` in ms.

## Merge, overlaps, remote, PRs, commit

- `mergeLocal(mainCheckout, branch, { message? })` → `{ ok, conflicts, sha?, error? }`:
  `git merge --no-ff --no-edit`; on conflicts lists them (`--diff-filter=U`) and runs `merge --abort`,
  so the main checkout is never left mid-merge.
- `predictConflicts(repo, a, b)` → `{ conflicts, files, tree }` via `git merge-tree --write-tree
  --name-only --no-messages -z` (exit 1 = conflicts). Only commits count, not uncommitted edits.
- `detectOverlaps(projectId, projectRepo, LiveWorktree[], { predict })` → `OverlapWarning[]`:
  pairwise intersection of changed files (`intersectChangedFiles`, case-folded on Windows/macOS),
  then `predictConflicts` on the two branches.
- `fetch(repo, { remote, prune, all })`, `pull(repo)` (`--ff-only`), `push(repo)` (sets upstream
  on first push). Also exported as `gitFetch/gitPull/gitPush` and `remote.*`. These are the only
  remote commands; only fetch runs without a click.
- `new GhCli({ ghBinary? })`: `available()` (installed and `gh auth status` ok, cached),
  `prView(cwd, branch)` → `{ state: open|draft|closed|merged, number, url }` or `undefined`,
  `prCreate(cwd, { title, body, base, head, draft })`. Everything is `undefined` when gh is missing
  or signed out, so the UI hides PR state.
- `commit(repo, { message, files?, agent?, trailers? })` → `CommitInfo`. With `files`: `add -A` +
  `commit --only` for exactly those paths (deletions included, literal pathspecs). `agent` adds the
  `Oide-Agent:` trailer. Hooks and signing follow the user's config.

## Testing

`packages/git/test/*.test.ts` build real temp repos (`git init`, commits, clones, a bare origin,
worktrees, conflicting branches) with an isolated empty global git config. On Windows, run Vitest
from PowerShell or from Git Bash after `cd "C:/…"`: launched from a Git Bash `/c/…` working
directory, Vitest 5 fails every suite with "failed to find the current suite".

## Gaps

- No file watcher here (Files "an agent is changing this file" lives in the app).
- Conflict prediction ignores uncommitted edits; the overlap warning itself does include them.
- `gh` is the only PR backend; a GitHub-token route would go in the Git extension.
