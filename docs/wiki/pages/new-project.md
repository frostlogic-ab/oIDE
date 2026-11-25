# New project

How a project starts. One dialog, **New project**, replaces the bare folder picker that "Open project"
used to be. Code: renderer `components/NewProjectDialog.tsx` (state in `stores/newProject.ts`,
mounted once in `App.tsx`), main `services/projects.ts` (`ProjectsService`), git
`packages/git/src/clone.ts` and `GhCli.listRepos` (`gh.ts`), shared validation
`packages/protocol/src/newProject.ts`. Every way in: the Projects sidebar +
([screen-wall](screen-wall.md)), the Wall's "Start a project" empty state (one button per tab),
Source control's empty state ([screen-source-control](screen-source-control.md)), the Spawn notice
([screen-spawn](screen-spawn.md)), and the command bar (Open project folder…, Clone repository…,
New repository…; see [desktop-shell](desktop-shell.md)).

## Tabs

| Tab | What the user does | Command(s) | Result |
| --- | --- | --- | --- |
| Open folder | Picks a folder (`dialog.pickFolder`, so main accepts the path) | `projects.open { path }`; on `not_a_repo` the dialog offers **Initialize git** → `projects.initFolder { path, commitFiles }` | A repository opens as before (its top level, trust prompt). A plain folder gets `git init` and a first commit: its files (`git add -A`, so `.gitignore` applies) or an empty commit. A broken `.git` is never touched (`conflict`). |
| Clone repository | Types a URL, `owner/repo`, or a github.com page link (`normalizeCloneInput`), or picks one of their GitHub repositories; chooses a location; folder name defaults to the repo name (`repoNameFromUrl`) | `projects.githubRepos`, `projects.clone { url, parent, name, source }`, `projects.cancelClone` | `git clone --progress --no-recurse-submodules -- <url> <parent>/<name>`; progress streams as `projects.cloneProgress { phase, percent? }` (at most ~10/s); then the trust prompt (someone else's code). Cancel → null, and the folder is gone. |
| New repository | Name, location, "Add a README.md" | `projects.create { parent, name, readme }` | `<parent>/<name>` created (an empty existing folder is reused), `git init`, README (or nothing) and a first commit, opened **trusted** (the user just made it). |

Every new checkout gets a first commit because agents branch their worktrees from `HEAD`
([git-worktrees](git-worktrees.md)); an unborn branch has nothing to branch from. The branch is `main`
unless the user's `init.defaultBranch` says otherwise. The commit is the user's own identity: with no
`user.name` / `user.email` configured, main refuses before creating anything (`unavailable`, reason
`no_identity`) and the dialog shows the `git config --global` commands. oIDE never invents an identity.

The location is remembered in `localStorage` (`oide.newProject.parent`), else it defaults to the folder
that holds the first open project. Main only accepts a location picked this session or the folder that
holds an open project, so after a restart the remembered location may be refused (`forbidden_path`):
the dialog then asks for it with the folder picker and retries.

## Rules (security)

- **SEC-08 extended.** `projects.initFolder` takes only a path picked this session (or a known
  project). `projects.create` / `projects.clone` take a `parent` that was picked or holds an open
  project, and a `name` that is one plain folder name (`folderNameProblem`: no separators, no `.`/`..`,
  no trailing dot or space, no Windows device names, no `-` start, and never `.git` in any spelling,
  including `GIT~1`). The target must not exist or be empty.
- **Clone URLs** (`cloneUrlProblem`, enforced by the `CloneUrl` schema in the IPC contract): https,
  http, git, ssh and `user@host:path` only. Refused: remote helpers (`ext::`, `fd::`, any `x::`), anything
  starting with `-`, whitespace or backslashes, `file://` and local paths (a compromised renderer must not
  copy an arbitrary local repository into a folder it can then read; local repositories use Open folder),
  and ssh users or hosts starting with `-`. The git runner also passes `protocol.ext.allow=never`.
- **No prompts, the user's credentials.** The clone runs with the runner's no-prompt env
  (`GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`): stored credentials, SSH keys and `gh auth setup-git`
  work; anything that would prompt fails fast with an explanation (`cloneFailureOf` → auth, not_found,
  network, exists, other; `cloneFailureMessage`). oIDE never asks for or stores a password.
- **Untrusted while cloning.** The clone runs `trust: 'untrusted'` (hooks off) and does not recurse
  submodules; the new project then asks for trust like any open, so its `.oide/setup`, permissions and
  MCP servers stay off until the user trusts it ([security](security.md)).
- **Cleanup.** A failed or cancelled clone or create removes the folder it made (`removeTree`), or for an
  empty folder that was already there, only what was put in it. One clone runs at a time (`conflict`).
- **GitHub list** comes from the user's own `gh repo list` (never its token); the clone URL follows
  `gh config get git_protocol` (https by default, ssh when set). Without `gh` or a login the dialog shows
  a one-line hint instead of the list.

## Telemetry

`project_added { method, source? }` and `project_add_failed { method, reason }`, observed in main from
the four commands ([telemetry](telemetry.md)). Never a path, URL, host or name.

## Tests

`packages/protocol/src/newProject.test.ts` (names, URLs, shorthand, contract),
`packages/git/test/clone.test.ts` (progress parser, failure kinds, a real local clone, `parseRepoList`),
`test/integration/new-project.test.ts` (the commands through the IPC router: picked locations, identity,
`.gitignore`, cleanup, trust, refused URLs, the GitHub list), `components/NewProjectDialog.test.tsx`
(the dialog), and the telemetry observer tests.
