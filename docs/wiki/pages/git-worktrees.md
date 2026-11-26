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
| `remove(projectPath, path, { force, deleteBranch, retries=5, delayMs=300 })` | Without `force`, the checks `git worktree remove` makes first: a locked worktree, or one with modified or untracked files (`git status --porcelain --ignore-submodules=none`; ignored files such as `node_modules` do not count), is refused with a `GitError` and left untouched. Then oIDE deletes the folder itself with `removeTree` (`fs.rm`, never following junctions; the whole tree retried `retries` times, linear `delayMs`, on `EBUSY`/`EPERM`/`ENOTEMPTY`), unlocks a locked worktree when forced, and runs `git worktree prune`. Not `git worktree remove`: see below. Refuses the main checkout. `isLockError(err)` tells a held file (`EBUSY`, "being used by another process") from the rest. |
| `prune(projectPath)` | `git worktree prune -v` (startup sweep) |
| `orphans(projectPath, projectId, knownPaths)` | Worktrees under our two roots that no known agent owns, plus leftover folders git no longer lists (`registered: false`) |
| `runSetup(path, command, opts)` | Streams the setup command's output |
| `aheadBehind(cwd, branch, base)` | `rev-list --left-right --count base...branch` |
| `info({ projectId, path, branch, baseRef, agentId? })` | A protocol `WorktreeInfo` (ahead/behind, `DiffStat`, changed files; `orphaned` when the folder is gone) |

Path comparisons go through `pathKey()` / `samePath()` / `isInside()` (`paths.ts`), which case-fold
on Windows and macOS. git prints `C:/x` on Windows; entries are normalised to native paths.

### Why a worktree can't be deleted on Windows

A real incident (2026-11-25): discarding an agent left "Could not delete the worktree folder …
because a program is using a file in it", and the folder (68,687 entries from a `pnpm install`,
16,820 paths over 260 characters, 6,095 junctions) never went away. Four separate causes:

| Cause | What happened | What oIDE does now |
| --- | --- | --- |
| **Paths over 260 characters** | `git worktree remove --force --force` (git 2.51) fails with `Filename too long` unless `core.longpaths` is on. | The runner passes `-c core.longpaths=true` on Windows to every git call, and the folder is deleted by `fs.rm`, which handles long paths. |
| **pnpm junctions** | git fails with `Directory not empty` on `node_modules` junctions (longpaths does not help). Worse, **git follows a junction and deletes the files of the folder it points to**, even outside the worktree (a `link:` or `file:` dependency, a global store). | oIDE no longer deletes worktrees with `git worktree remove`: it runs git's safety checks itself, then `fs.rm` (removes a junction without following it), then `git worktree prune`. Tested with a junction to an outside folder that must survive. |
| **Misread errors and retries that compound** | Those git messages were treated as file locks and retried 5 times with backoff (~9 s) before falling back; and `fs.rm`'s own `maxRetries` retries per directory level, so one held folder deep in the tree made the delete hang for minutes. | Only `EBUSY` and "being used by another process" count as a lock (`isLockError`, `isLockedFileError`). `removeTree` retries the whole tree a few times with `maxRetries: 0` per try (a few seconds at most). |
| **Daemons that keep the folder as their current directory** | An agent ran `docker`; Docker Desktop (`com.docker.backend.exe`, `com.docker.build.exe`, `docker-sandbox.exe`, `wsl.exe`, `wslhost.exe`) started from the worktree and daemonized, so `taskkill /T` on the agent never reached it, and it held the worktree root open (`EBUSY` on `rmdir`). Restart Manager sees files, not folders, so it found nothing. | On a failed delete, `reliability/folder-holders.ts` lists the user's own processes with a handle on the folder (Windows: the system handle table through a fixed PowerShell script, folder passed in an env var, C# helper compiled through CodeDom rather than `Add-Type` so no module is autoloaded; macOS/Linux: `lsof +d`; 25 s timeout, of which the Windows handle scan itself takes at most 8 s) and the notice names them: "Docker Desktop (com.docker.backend.exe) still has this folder open. Quit it, and oIDE will finish removing the folder." oIDE never ends programs it did not start. After an agent stops or is archived, the same scan (Windows, best effort) warns in the agent's log when something still holds its worktree. |

The folder then waits in `<userData>/pending-cleanup.json` and is retried every 5 minutes while
oIDE runs (backoff per folder: 5, 10, 20 … minutes, at most 2 h) and at every start; "Finished
removing <name>" when it goes, and Settings › Diagnostics lists the folders with Retry now and Show
holders ([reliability](reliability.md#windows)).

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

- `mergeLocal(mainCheckout, branch, { message?, autoStash? })` → `{ ok, conflicts, sha?, error?,
  blockedBy?, autoStash? }`: `git merge --no-ff --no-edit`; on conflicts lists them (`--diff-filter=U`)
  and runs `merge --abort`, so the main checkout is never left mid-merge. When git refuses because
  uncommitted (or untracked) files in the main checkout would be overwritten
  (`parseBlockedByLocalChanges`, which reads both git refusals, tracked and untracked), it recovers on
  its own: it stashes **only those files** (`git stash push --include-untracked` with literal
  pathspecs, message `oide: local changes set aside to merge <branch>`), merges again, and re-applies
  the stash by its commit (`git stash apply <sha>`, then drops that entry only, never another stash).
  `autoStash { files, restored, stash? }` reports it. If re-applying clashes with what was merged,
  `git reset --merge` undoes the partial apply (unrelated local changes stay), the files are left as
  merged, and the stash is kept (`restored: false`, `stash` names it): no conflict markers in the main
  checkout and nothing lost. If the second merge fails (conflicts), it was aborted, so the stash goes
  back onto the unchanged checkout. `autoStash: false` keeps the old refusal (`blockedBy` + an error
  that says to commit or stash). `autoStashNote()` words the outcome for the UI.
- `predictMerge(mainCheckout, branch)` → `MergeForecast { supported, conflicts, files, binary,
  submodules, target: { branch?, sha }, branchSha, behind, ahead, error? }`: `git merge-tree
  --write-tree -z <HEAD> <branch>` without `--name-only`, parsed by `parseMergeTree` (stage entries
  give the paths and mode 160000 submodules; the stable message types `CONFLICT (binary)` and
  `CONFLICT (submodule…)` mark the rest), plus `rev-list --left-right --count`. A git too old for
  `--write-tree` (< 2.38) gives `supported: false` with the error instead of throwing. Used by the
  merge dialog ([screen-review](screen-review.md#merge-conflicts)); main caches it per commit pair.
- `predictConflicts(repo, a, b)` → `{ conflicts, files, tree }` via `git merge-tree --write-tree
  --name-only --no-messages -z` (exit 1 = conflicts). Only commits count, not uncommitted edits.
- `detectOverlaps(projectId, projectRepo, LiveWorktree[], { predict })` → `OverlapWarning[]`:
  pairwise intersection of changed files (`intersectChangedFiles`, case-folded on Windows/macOS),
  then `predictConflicts` on the two branches.
- `fetch(repo, { remote, prune, all })`, `pull(repo)` (`--ff-only`), `push(repo)` (sets upstream
  on first push). Also exported as `gitFetch/gitPull/gitPush` and `remote.*`. These are the only
  remote commands; only fetch runs without a click.
- PR lookups (the PR watcher and Source control's PR state) run only for projects with a git remote:
  main checks `git remote` once per project, caches it (refreshed on every fetch, and after 10
  minutes), and a local-only repo is skipped quietly; gh's "no git remotes found" corrects the cache
  instead of counting as a gh failure (no backoff, no warning).
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
