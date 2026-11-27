# Screen: Files

Design: [../raw/design/Files.dc.html](../raw/design/Files.dc.html). Route `files { root?, path?, line? }`.
Code: `apps/desktop/src/renderer/src/screens/Files/`. Shares the git store with
[Source control](screen-source-control.md); Monaco setup is shared with [Review](screen-review.md).

## Layout

- Header: title + shared scope switcher; on the right a "Search" button (`aria-pressed`, Ctrl/Cmd+Shift+F
  hint) that toggles the Search panel, and a "Terminal" button (`aria-pressed`, Ctrl+` on every
  platform, keymap action `files.terminal`) that shows or hides the terminal panel.
- Left (270px, "File tree", `TreePanel.tsx`): a toolbar ("FILES" label; 28px icon buttons Search in
  files, Run a script (only when scripts were found, see [Run scripts](#run-scripts-and-terminals)),
  Reveal active file, Expand loaded folders, an "Expand to depth" 1/2/3 menu, Collapse all
  folders; they act on every open tree), then per project in scope a header row (expand toggle, name,
  number of agent worktrees, a 96px branch / worktree `<select>`: main + each worktree's short
  branch, and with All projects a "Folder actions for <project>" menu: Collapse all, Expand loaded
  folders, Expand to depth 1/2/3, Reveal active file, Open terminal here) and a `role="tree"`. With All projects the
  first project starts open; with one project in scope its tree is always open. Legend box at the
  bottom; its × ("Close the legend") hides it for good (`settings.update({ ui: { filesLegendHidden: true } })`,
  hidden at once, a toast if saving fails) and the tree takes the room. When Search is open the column is the 300px Search panel instead.
- Middle: open-file tabs (`role="tablist"`, accent top border, close ×, ● when unsaved; right side
  the language-server status and problem counts, "Ln, Col · Language" and Save; for a changed file a "Changes view" File / Unified / Split toggle and
  "vs last commit" / "vs base branch"; for a Markdown file a "Markdown view" Preview / Edit toggle
  before them), the agent banner, the editor, and under it the terminal panel when shown (`TerminalDock.tsx`).
- Tab labels (`tabLabels.ts`): a tab shows only the file name; its tooltip is the full absolute path.
  When several open tabs share a name, each gets a dim hint after it, as in VS Code: the project
  (`·checkout` when not main) if they sit in different places, and the shortest trailing part of the
  folder that tells them apart (`…/web/src`, `/` for the root).
- Tab menu: right-click a tab (or Menu key / Shift+F10 on it) for Close, Close all to the right
  (disabled on the last tab) and Close all. Middle click closes a tab. Closing several tabs asks
  once when any has unsaved changes; `useFiles.closeTabs` keeps the active tab if it stays, else
  picks the kept tab nearest its place (Close all to the right makes the clicked tab active).
- Right ("File activity"): Problems (the open file's diagnostics, when it has any), This file's history,
  Mentioned in, the language-servers note.

## Tree (`filesStore.ts`)

- Lazy: `files.tree { root, dir }` per folder on expand; root = `project.path` or `WorktreeInfo.path`,
  paths relative with `/`. Single-folder chains are compacted ("main/cli", "docs/rfc").
- Markers: files in any live worktree's `changedFiles` get a 7px dot per agent (green running,
  amber waiting on you, blue ready for review) with a tooltip. On first load of a checkout the
  folders containing those files are expanded.
- Keyboard: roving tabindex per tree, ↑/↓, Home/End, → expand / first child, ← collapse / parent,
  Enter/Space open or toggle, `*` expands every sibling folder (tree convention), `-` collapses the
  folder (on a file or closed folder: its parent, and moves there). `aria-level`, `aria-expanded`,
  `aria-selected`.
- Expand / collapse (store): `collapseAll(root)`, `expandLoaded(root)` (every folder whose listing is
  loaded), `expandToDepth(root, n)` (loads level by level, at most 300 folders), `revealPath(root,
  path)` (expands the ancestors and sets `revealTarget`; the tree scrolls to the row and makes it the
  tab stop once it is rendered). Reveal active file also opens the project and switches it to the
  tab's checkout.
- Look follows the VS Code explorer: flush full-width 22px rows (13px text, no gap, square corners),
  10px indent per level, a rotating chevron for folders, a 16px file-type icon for files
  (`fileIcons.tsx`: Seti-like coloured glyph per exact name, `tsconfig*`/`eslint.config*`-style
  name, or extension; SVG or a short mono badge, never emoji; decorative, `aria-hidden`), and 1px
  indent guides per ancestor level; the guide of the folder holding the focused row (or of the
  focused open folder) is brighter. Project headers are uppercase 11px bold section headers with the
  same chevron. Row tooltip is the relative path.
- Rows are a fixed 22px pitch and windowed (only visible rows plus overscan are in the DOM).

## Git colours (`changesStore.ts`)

Like the VS Code explorer's git decorations, each shown checkout marks what it changed:

- What counts as changed (`files.changes { root }` → `@oide/git` `checkoutChanges`): in the
  project's main checkout, uncommitted work against HEAD (as VS Code); in an agent worktree,
  everything the branch changed since its base (`git diff <merge-base>` plus untracked files, the
  same set Review shows), committed or not. Untracked files are listed one by one; at most 5000.
- Changed files (modified, added, untracked) are green (`text-ok`) with VS Code's letter at the
  row's end (M, A, U; `!` amber for a conflict). Folders holding changes are tinted with the
  strongest status under them (no letter). Deleted files, and folders that only held deleted
  files, show as rows that are not on disk: red (`text-bad`) and struck through, letter D. They come
  from `visibleRows(root, state, ghosts)`, sorted in with the listing; a deleted folder opens from
  the changes, never from the disk. Tooltip "path • Modified"; screen readers hear ", modified" /
  ", contains changes". The legend under the tree explains M and D.
- Language-server problems (see [Language servers](#language-servers)) win over the git colour of
  the name, as in VS Code: a file with errors is red (`text-bad`), with only warnings amber
  (`text-warn`), with the number of errors and warnings before the git letter; folders above it are
  tinted with the worst level. Screen readers hear ", 2 errors, 1 warning" / ", contains errors";
  the tooltip adds the summary.
- Refreshed on `git.changed` for the project (debounced 250 ms; the checkout watchers and every tree
  action emit it) and when the window gets focus.
- Right-click a changed file or a folder holding changes: **Discard changes** (VS Code's undo
  arrow). A deleted row's menu is only Discard changes (restore) and Copy path. A confirm says what
  happens: "goes back to the last committed version" (main) / "the version this branch started
  from" (worktree), "is new, so it will be deleted" (title "Delete X?"), or "will be restored"
  (title "Restore X?"), plus unsaved edits that would be lost. Then `files.discardChanges { root,
  paths }` (`discardCheckoutChanges`: `git restore --source=<HEAD or merge-base> --staged --worktree`
  for tracked paths, which also removes files missing from the source; `git clean -f` for untracked
  ones; only paths it reports as changed are touched; literal pathspecs; `..`, absolute paths and
  `.git` refused). Open tabs of the files reload from disk (`onTabsReloaded`), tabs of deleted new
  files close, the folders and colours refresh. It does not go through the trash. Telemetry:
  `file_changes_discarded { files, checkout }`.

## Managing files (`TreeActions.tsx`, `treeOps.ts`)

- Right-click a row (or the ContextMenu key / Shift+F10 on a focused row) for the `ContextMenu`:
  New file…, New folder…, Cut, Copy, Paste, Copy path, Copy relative path, Reveal in File Explorer /
  Finder (`shell.revealPath`), Rename…, Delete. Right-click a project header for the root's New file,
  New folder, Paste, Copy path and Reveal; the per-project folder menu also has New file / New folder.
- New file / New folder: an inline name field at the top of the target folder (the folder itself,
  or a file's folder; it expands). Type the name with its extension (`/` makes missing folders:
  `utils/helpers.ts`). Enter creates (`files.create`), Esc cancels, leaving the field commits a
  valid name. A new file opens in the editor. Problems show under the field as you type
  (`validateName`: empty, leading/trailing spaces, `..`, `.git`, Windows-reserved names and
  characters, a name already in the folder, case-insensitive); a refusal from main keeps the field open.
- Rename (F2): the same field on the row, the stem selected ("index" of "index.ts"); a compacted
  chain renames its last folder. `files.rename`. Open tabs under the old path follow it with their
  unsaved edits (`onTabsMoved` re-keys the editor models; the language follows the new name), and so
  do recents and open folders.
- Cut / Copy / Paste (Ctrl/Cmd+X, C, V on a row; the clipboard is oIDE's own, in `filesStore`):
  Paste goes into the row's folder in any project or worktree (`files.copy`). A copy whose name is
  taken becomes "name copy.ext", "name copy 2.ext"; a cut row is dimmed, a move refuses a taken name
  and its tabs follow it. Copy path / relative path use the system clipboard.
- Delete (Delete, Cmd+Backspace on macOS): a confirm ("Delete X?", the folder note, unsaved edits
  in its open tabs are lost) then `files.delete` moves it to the Recycle Bin / Trash
  (`shell.trashItem`); its tabs close.
- Main (`handlers/files.ts`): project and worktree roots only (never artifact folders), the
  parent folder goes through the path guard and the entry itself is not resolved, so renaming or
  deleting a symlink acts on the link; `.git` is refused; a folder cannot go into itself; moves to
  another disk copy then delete. Each success refreshes the quick-open index and the git status.
  Telemetry: `file_managed { action, crossCheckout }`.

## Run scripts and terminals

- Detection (main, `services/scripts.ts`, `scripts.list { root }`): reads only the checkout's top
  folder, never runs anything. package.json `scripts` → `<pm> run <name>` (pm from `packageManager`,
  else `pnpm-lock.yaml` / `yarn.lock` / `bun.lock(b)`, else npm; on Windows `npm.cmd` / `pnpm.cmd` /
  `yarn.cmd` when on PATH, because PowerShell's default execution policy refuses `npm.ps1`);
  deno.json(c) `tasks`; composer.json `scripts`; Makefile targets (not `.PHONY`, variables, pattern
  or file targets); justfile recipes; fixed verbs for Cargo.toml, go.mod, *.sln / *.csproj,
  gradle(w), pom.xml and Django's manage.py. Names that are not plain words (spaces, shell
  metacharacters) are skipped. At most 100 per source; manifests over 1 MB are ignored.
- Run (`scriptsStore.ts`, toolbar play button, shown only when scripts were found): like the other
  toolbar buttons it acts on the open trees, a portalled menu of each open checkout's scripts
  (prefixed "project ›" when more than one open tree has scripts; the hint is the package manager or the source file; the
  tooltip is the command). Lists refresh when the window regains focus or the button is pointed at
  (at most every 4 s). Picking one opens a new terminal tab that runs it: `terminal.runScript { cwd,
  scriptId }`. Main finds the script again by id in that checkout and types its command into a new
  **interactive** shell (`TerminalService.create({ input })`, written after the shell's first
  output), so the shell stays open after the script ends and ↑ re-runs it, as in VS Code. The
  renderer never sends a command line (SEC-05). Telemetry: `script_run { runner }`.
- Terminal panel (`TerminalDock.tsx` → `components/terminal/TerminalTabs.tsx`): one tab per session
  (play icon for scripts, "project › Terminal N" for shells, "exited N" / "failed" once over), a
  close × per tab that kills its process (Delete on a focused tab), ←/→/Home/End between tabs,
  "New terminal" (in the active file's checkout, else the first project's), and Hide (terminals keep
  running). Top edge drags (and ↑/↓ on the focused separator) between 120px and 70% of the window;
  closing the last tab hides the panel; showing it with none open starts a shell.
- Sessions (`stores/terminals.ts`) are grouped (`files`, `agent:<id>` for Focus) and outlive their
  view: each keeps its own xterm (`TerminalView.tsx` moves the xterm element into whichever host
  shows it), so a dev server keeps running across screens. Terminals of an agent that is archived or
  removed, and Files terminals inside its worktree, are closed so Windows can delete the folder.

## Editor (`EditorPane.tsx`, `monaco/setup.ts`)

- `monaco-editor` from the local package, lazy chunk (Monaco loads only when a file opens). Imports
  `monaco-editor/editor` (API), `features/register.all` (contributions, diff editor, codicons) and
  `languages/definitions/register.all` (Monarch tokenizers; JSON uses the JavaScript one). No
  built-in TS/JSON language services (workers): language features come from language servers, see
  [Language servers](#language-servers). The editor worker is `?worker&inline` (blob URL, allowed by `worker-src blob:`,
  works under `file://`).
- Theme `oide-dark` from the tokens (ground background, `#5E6774` line numbers, `#1B2333`
  selection, keywords `#C4A7E7`, strings `#A8E0C6`, types `#9DBBFA`, comments `#7A8494`).
- Minimap on the right of the Files editor (`FILE_MINIMAP` in `monaco/setup.ts`): the whole file in
  miniature with the slider always shown over the lines in view; click to jump, drag the slider to
  scroll. Themed from the tokens (editor ground, soft `#9AA3AE` slider, accent selection, amber find
  matches). Diff editors and artifact source editors keep `BASE_OPTIONS`' minimap off.
- At most one live editor; one model per tab with saved view state; models of closed tabs are disposed.
- Ctrl/Cmd+S or Save → `files.write`. Files over 5 MB open read only; binary files show a notice.
- Cut / Copy / Paste work from the keyboard and Monaco's context menu (Paste reads the system
  clipboard, which main allows for the app page only; see [security](security.md)).
- Markdown preview (`MarkdownPreview.tsx`, `markdownLinks.ts`, `lib/markdown.ts`): `.md`,
  `.markdown`, `.mdown`, `.mkd` and `.mkdn` files (not `.mdx`, whose JSX the sanitiser would drop) open
  on their rendered page. **Edit** shows the Monaco source on the left half and the live page on the
  right (re-rendered 150 ms after the last keystroke; the page scrolls with the source,
  proportionally); **Preview** hides the source again. Toggle with the tab bar's "Markdown view"
  buttons (`aria-pressed`) or Ctrl/Cmd+Shift+V (`files.togglePreview` in the Files scope, rebindable;
  ignored inside a terminal, where it pastes). The choice is per tab in `filesStore.mdView`, follows a
  rename, and is forgotten when the tab closes, so a file always reopens in the preview. Jumping to a
  line (search result, quick open `file.md:12`, Review "Open in editor") switches the tab to Edit. In
  the preview the tab bar hides Ln/Col; Save still works for unsaved edits.
  Rendering: `renderMarkdown` (shared with doc artifacts): GFM through its own `Marked` instance,
  front matter stripped, DOMPurify (no `<style>`, `<form>`, `<input>`, `<iframe>`, `style`
  attributes); GFM task items draw a box (`oide-md-task`) as `<input>` is dropped. Styles are scoped
  to `.oide-md-file` (`MarkdownPreview.css`), not the shared `.oide-md`. Links never navigate the
  window: https opens the system browser, `#heading` scrolls to the heading with that GitHub-style
  slug, a relative or `/`-rooted link opens that file of the same checkout in a tab (links that climb
  out of the checkout and other schemes do nothing). Relative images do not load (the page has no
  file URL).
- Changes view (`diffView.ts`, `EditorPane.tsx`): a file the tree colours as modified, renamed or
  conflicted (`useChanges` for the tab's checkout, kept loaded by the screen even when the tree shows
  another checkout) opens on its changes in Monaco's diff editor, against the same version as the
  colours: the last commit in the main checkout, the merge-base with the base branch in an agent
  worktree. `files.original { root, path, oldPath? }` reads it (`originalContent` in `@oide/git`:
  `git cat-file blob <HEAD or merge-base>:<path>`, no filters or textconv; `missing` for a new path,
  `binary` for binary or over 5 MB, which falls back to the plain editor with a note). The right side
  is the tab's own model, so it stays editable: unsaved edits, the ● dot, Ctrl/Cmd+S, Ln/Col and
  "Ask an agent about this" (context menu) work as in the plain editor; the left side is read only.
  The tab bar's "Changes view" buttons (`aria-pressed`): **File** (the plain editor), **Unified**
  (one column, removed lines above added ones) and **Split** (side by side;
  `useInlineViewWhenSpaceIsLimited` off, so a narrow pane keeps the pick). The choice is per tab in
  `filesStore.diffView` (follows a rename, forgotten on close); picking a layout also makes it the
  default for the next changed file (`filesStore.diffLayout`, saved in `localStorage`
  `oide.files.diffLayout`, Unified at first). A changed Markdown file opens on its changes too; its
  Preview / Edit buttons (or Ctrl/Cmd+Shift+V) leave them, so its Changes view has no File button.
  The original is read again when the checkout's changes reload (`git.changed`, window focus), so a
  commit moves the left side; a file that no longer differs shows the plain editor. New (added,
  untracked) files open in the plain editor: every line would be an addition. Telemetry:
  `files_diff_view { view }` on a switch.
- Selection toolbar: "Ask an agent about this" (→ Spawn with a file context chip
  `{ kind: 'file', path, title: 'StatusBar.tsx:5-6' }`, also in the context menu) and "Send to <agent>"
  when an agent is editing the file (`agents.send` text with the path, lines and snippet).

## Language servers

ADR [0019](../../adr/0019-language-servers-in-main-with-a-monaco-bridge.md). Main:
`services/lsp/` (`language-servers.ts`, `jsonrpc.ts`, `convert.ts`), `handlers/lsp.ts`. Renderer:
`monaco/lsp.ts` (bridge), `lspStore.ts` (status and problems outside Monaco), `LspStatus.tsx`.

- Servers come from `contributes.languages` of extensions that are on for the project; the built-in
  **Languages** extension (`@oide/ext-languages`, see [extensions](extensions.md#built-in-extensions))
  covers TypeScript/JavaScript, Python, Rust, Go, C/C++, CSS, HTML, JSON, YAML and Bash with the
  servers installed on PATH (or in the checkout's `node_modules/.bin`). The first matching
  contribution (by extension, or whole file name) wins.
- One server per (language, checkout): the main checkout and each agent worktree get their own,
  rooted at that folder. It starts on the first open tab of its language and stops 3 minutes after
  its last tab closes, when the project is untrusted or removed, when the extension goes off, when
  the worktree is deleted (before the folder is removed), and on quit (`shutdown` + `exit`, then the
  process tree is killed). At most 8 run at once. A crash restarts it (1 s → 30 s backoff) with its
  open documents; after five crashes in three minutes it stays failed.
- Only trusted projects (servers run repository code). Untrusted: the tab bar says "Language server
  off" with the reason in its tooltip.
- Sync: binding a tab's model sends `lsp.open { root, path, version, text }` (the model's version
  id, full text; files over 4 MB and read-only tabs are not sent); edits send `lsp.change` 200 ms
  after the last keystroke, and every feature request flushes a pending change first; closing the
  tab sends `lsp.close`. Rename follows the tab (close + open under the new path). Saving sends
  `didSave` from main's `files.write`.
- Features (Monaco providers registered for every language; they answer only for Files tabs, so
  Review's diff editor is untouched): hover; completions as you type (trigger characters `.` `:`
  `<` `"` `'` `/` `@` `#` `$` `>` `-`), with documentation fetched on focus
  (`lsp.resolveCompletion`, by the item's index in main's last result); signature help on `(` and
  `,`; Go to Definition (F12, Ctrl/Cmd+click), Go to Type Definition, Go to Implementations; Find All
  References / Peek (Shift+F12); highlights of the symbol under the cursor; Go to Symbol
  (Ctrl/Cmd+Shift+O) and the outline; Format Document (Shift+Alt+F). A definition in another file
  opens it as a tab at that place in the same checkout (`registerEditorOpener` → `onOpenLocation`);
  a peek of other files reads them into helper models (at most 20 per peek, 40 kept) that a tab
  opened on the file later adopts with the content on disk. Locations outside the checkout (a
  library in the server's own install folder) are dropped by main.
- Diagnostics: `lsp.diagnostics { root, path, version?, diagnostics }` (at most 500 per file) become
  Monaco markers (squiggles, the overview ruler, F8 / Shift+F8), the tree colours above and the
  Problems list in File activity (errors first, then warnings, infos, hints; at most 100 shown; a
  click puts the cursor on it). A stopped server clears what it published.
- Tab bar (`LspStatus.tsx`): problem counts (error and warning icons; click = next problem, F8) and
  the server: a dot (green running, grey starting, amber not installed, red failed, dim when off)
  and its name; the tooltip explains the state. Its menu has Restart language server (or Try again)
  and, when the command was not found, Copy install command.
- Telemetry: `language_server_started { language, outcome }` per start attempt.

## Search

`SearchPanel.tsx`, `searchStore.ts`, `searchModel.ts`, `ReplaceDialog.tsx`; main:
`services/file-search.ts`. Opened by the header button, the toolbar's search icon, Ctrl/Cmd+Shift+F
(`files.search` in the Files keymap scope; rebindable) or the "Search in files" command.

- Form: "SEARCH" label and close; a replace toggle (chevron, `aria-expanded`); the query field with
  Match case (Aa), Match whole word (ab) and Use regular expression (.*) toggles (`aria-pressed`);
  the Replace field with Replace all; "Search in" (the current project's checkout, or all projects in
  scope) when more than one project is in scope; "Files to include and exclude" (comma-separated
  globs: a name without `/` matches at any depth, `src/**` is relative to the root, a folder covers its
  contents, `{a,b}` and `[...]` work). Invalid regexes are reported inline and not searched.
- Searches as you type (250 ms) and on Enter (which drops the pending debounce, so a search never runs twice); Esc cancels a running search. `files.searchContent`
  returns at once; batches arrive as `files.searchResults { searchId }` (25 files or 80 ms), the last
  with `done`, `truncated` and stats. The status line reads "Searching…" with Cancel, "N results in
  M files", "No results." or the first-2000 note.
- Results are grouped by file (name, folder, project when searching several, count badge, collapse)
  with one 23px row per match: line number and a mono preview cut around the match, the match on
  `review-line`. Clicking a match opens the file in its checkout and selects the match in Monaco.
- Replace: with the replace field open, each match row shows the old text struck through on
  `bad-line` and the new text on `ok-line`; per-match "Replace" and per-file "Replace all in <file>"
  buttons appear on hover or focus. Every replace (one match, one file or Replace all) opens a confirm:
  per file a checkbox, "<agent> is changing this file" when `files.editingAgents` says so, and the old
  and new text of each matched line (`data-kind` del/add rows in the Review colours). Confirm sends only
  the checked files' listed matches to `files.replace`; files changed since the search come back
  `stale` and are left alone (warning toast), then the search runs again. Regex replacements expand
  `$1`, `$<name>`, `$&` and `$$`.
- Main: `git grep -l -z -I` (`-F` text, `-P` regex, `-i`, `-w`; `-e <pattern> --`) lists candidate
  tracked files per checkout, and the checkout's untracked (not ignored) files from the index are
  scanned in main (`git grep --untracked` walks the whole tree and was 4x slower); each is read in main (path guard, 5 MB cap, binary check), matched with
  the same JavaScript regex replace uses (`buildSearchRegExp` in `packages/protocol/src/search.ts`) and
  hashed (sha256). Outside git, or when git has no PCRE for a regex, the checkout's file index is
  scanned instead. At most 4 searches run; a new one with the same id cancels the old. Security
  details: [security](security.md#search-and-replace-files).

## Quick open

Ctrl/Cmd+K finds files by name across the projects in scope; see
[desktop-shell](desktop-shell.md#command-bar). Enter sets `filesStore.pending`; the Files screen opens
the file in that checkout (selecting it in the project's menu), reveals it in the tree and, for
`name:42`, puts the cursor on that line. Opened files are remembered (`recent`, 50, localStorage) and
rank first.

## Performance

Measured on Windows 11 with a synthetic 100k-file git repo (`packages/p*/src/mod*/file*.ts`), through
`services/file-search.ts`:

| Step | Time |
| --- | --- |
| Index build (`ls-files --cached` + `status -uall`, in parallel) | 0.63-0.70 s (was 11-15 s with `ls-files --others` + `--deleted`) |
| Quick-open query (`file4242`, `mod77`, `f`, `src mod1 index`) | 50-105 ms |
| Search a rare string (1 hit) | 2.0 s total, about what `git grep` itself takes (2.1 s) |
| Search a common string (`export`, capped at 2000) | first batch 89 ms, done in 0.8 s |

The index is built once per checkout and refreshed in the background after watcher changes, so
quick open never waits for git after the first query. `git status` runs with `--no-optional-locks`
so it never holds the index lock an agent's git needs.

## Banner and activity

- `files.editingAgents { path: <absolute path> }` → banner: "<agent> is changing this file in its
  worktree. You're viewing main, so your edits won't clash." with "See agent's version" (switches the
  project's checkout and reopens the file there) and "Open agent" (Focus). Viewing the agent's own
  worktree gives a different sentence and "See main version". Amber when the agent waits on you.
  Re-queried on `agents.summary`.
- History: editing agents ("editing now · worktree x"), then `files.history` commits ("You",
  "<trailer> agent"; the oldest reads "created").
- Mentioned in: `files.mentionedIn { root, path }` (protocol addition) → artifact links.

## Unsaved edits and load errors
- Each tab's unsaved state lives in the `useFiles` store (`dirty`, `setDirty`), and `EditorPane` reports
  it again from its models when it mounts and when it shows a tab. The tab dot, the Save button and the
  close warning survive leaving Files and coming back. Closing a tab, including the last one, disposes
  its model, so reopening the file reads it fresh from disk.
- A folder that fails to load shows its error with a Retry button, on the root row and on each failing
  sub-folder row (Enter on a failed folder row retries too). Retry forces `loadDir(root, dir, true)`
  instead of leaving the tree broken until restart.

## Tests

`Files.test.tsx`: trees per project, revealed compacted folders, markers, lazy expansion via
click and ←/→, opening another project, switching to a worktree checkout; toolbar Collapse all /
Expand loaded / Expand to depth, the per-project menu (absent with one project in scope), `*` and `-`,
Reveal active file, quick-open requests; the Markdown view toggle (preview by default, button and
Ctrl+Shift+V, forgotten on close, Edit when jumping to a line, linked files open; no toggle for other
files); the Changes view (changed files open unified, Split / File per tab, the last layout for the
next changed file, none for unchanged files, Markdown leaves it through Preview); search (sections, highlight, regex error, open at a match)
and replace (one match through the preview, stale refusal after an outside change); `visibleRows` /
`ancestorDirs` model. `markdownLinks.test.ts` (Markdown extensions, link resolution, checkout
escape, heading slugs) and `MarkdownPreview.test.tsx` (sanitising, task boxes, link routing).
`packages/protocol/src/search.test.ts` (ranking, regex, replace, globs),
`apps/desktop/src/main/services/file-search.test.ts` (index, 100k-path query, git grep argument
safety, regex vs text, untracked / ignored / binary, cap, cancel, non-git scan, replace safety),
`test/integration/files-search.test.ts` (IPC validation and path guard),
`lib/quickOpen.test.ts` and `components/frame/CommandBar.test.tsx` (sections, `>`, `:line`),
`Lsp.test.tsx` (problem counts per file and folder, server state fan-out, tree colours and counts, the
Problems list, the status control's states and menu), the main-side LSP tests in
`apps/desktop/src/main/services/lsp/*.test.ts` (framing, conversion and path mapping, the service
against the fixture server `fixtures/fake-lsp.mjs`), `test/integration/lsp.test.ts` (IPC validation
and path guard), `e2e/files-lsp.spec.ts` (the built app starts a `typescript-language-server` shim
that runs the fixture: running status, problem counts, red tree row, Problems list, hover), and
`e2e/files-search.spec.ts` (Ctrl+K opens a file; Ctrl+Shift+F finds and replaces one match),
`e2e/files-diff.spec.ts` (a changed file opens on its unified diff, Split shows both sides, the
right side saves, File shows the plain editor; an unchanged file has no Changes view).
Git colours: `changesStore.test.ts` (folder tints, deleted entries per folder, ghost rows in
`visibleRows`), `TreeActions.test.tsx` (green M / U, red struck-through D, Discard changes on a
modified, a new and a deleted file), `packages/git/test/changes.test.ts` (against HEAD and against a
base branch with real repos, before the first commit, discard of each kind; `originalContent`
against HEAD and the merge-base, binary, missing, before the first commit).

## Deviations

- Banner copy uses the agent's title ("Build the window shell layout is changing…") instead of the
  canvas's short name.
- Tabs get a close button and the tab bar shows Ln/Col and Save (the canvas puts Ln/Col in the app
  status bar, which belongs to the shell).
- Folders sort before files, so `docs/rfc` lists above `src` in the oide tree.
- Editor: JetBrains Mono ligatures on (`fontLigatures`), and TypeScript / JavaScript use a derived
  Monarch tokenizer (`withFunctionNames` in `monaco/setup.ts`) that tints a name followed by `(` as
  `identifier.function` (`#9DBBFA`), like the canvas. Line numbers are `#7A8494` (5.0:1), not the
  canvas's `#5E6774` (3.3:1).
