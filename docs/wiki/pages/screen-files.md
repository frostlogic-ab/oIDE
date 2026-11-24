# Screen: Files

Design: [../raw/design/Files.dc.html](../raw/design/Files.dc.html). Route `files { root?, path?, line? }`.
Code: `apps/desktop/src/renderer/src/screens/Files/`. Shares the git store with
[Source control](screen-source-control.md); Monaco setup is shared with [Review](screen-review.md).

## Layout

- Header: title + shared scope switcher.
- Left (270px, "File tree", `TreePanel.tsx`): per project in scope, a header row (expand toggle,
  name, number of agent worktrees, a 96px branch / worktree `<select>`: main + each worktree's short
  branch) and a `role="tree"`. With All projects the first project starts open; with one project
  in scope its tree is always open. Legend box at the bottom.
- Middle: open-file tabs (`role="tablist"`, accent top border, close ×, ● when unsaved; right side
  "Ln, Col · Language" and Save), the agent banner, the editor.
- Right ("File activity"): This file's history, Mentioned in, the language-servers note.

## Tree (`filesStore.ts`)

- Lazy: `files.tree { root, dir }` per folder on expand; root = `project.path` or `WorktreeInfo.path`,
  paths relative with `/`. Single-folder chains are compacted ("main/cli", "docs/rfc").
- Markers: files in any live worktree's `changedFiles` get a 7px dot per agent (green running,
  amber waiting on you, blue ready for review) with a tooltip. On first load of a checkout the
  folders containing those files are expanded.
- Keyboard: roving tabindex per tree, ↑/↓, Home/End, → expand / first child, ← collapse / parent,
  Enter/Space open or toggle. `aria-level`, `aria-expanded`, `aria-selected`.
- Rows are a fixed 23px pitch and windowed (only visible rows plus overscan are in the DOM).

## Editor (`EditorPane.tsx`, `monaco/setup.ts`)

- `monaco-editor` from the local package, lazy chunk (Monaco loads only when a file opens). Imports
  `monaco-editor/editor` (API), `features/register.all` (contributions, diff editor, codicons) and
  `languages/definitions/register.all` (Monarch tokenizers; JSON uses the JavaScript one). No TS/JSON
  language services. The editor worker is `?worker&inline` (blob URL, allowed by `worker-src blob:`,
  works under `file://`).
- Theme `oide-dark` from the tokens (ground background, `#5E6774` line numbers, `#1B2333`
  selection, keywords `#C4A7E7`, strings `#A8E0C6`, types `#9DBBFA`, comments `#7A8494`).
- At most one live editor; one model per tab with saved view state; models of closed tabs are disposed.
- Ctrl/Cmd+S or Save → `files.write`. Files over 5 MB open read only; binary files show a notice.
- Selection toolbar: "Ask an agent about this" (→ Spawn with a file context chip
  `{ kind: 'file', path, title: 'StatusBar.tsx:5-6' }`, also in the context menu) and "Send to <agent>"
  when an agent is editing the file (`agents.send` text with the path, lines and snippet).

## Banner and activity

- `files.editingAgents { path: <absolute path> }` → banner: "<agent> is changing this file in its
  worktree. You're viewing main, so your edits won't clash." with "See agent's version" (switches the
  project's checkout and reopens the file there) and "Open agent" (Focus). Viewing the agent's own
  worktree gives a different sentence and "See main version". Amber when the agent waits on you.
  Re-queried on `agents.summary`.
- History: editing agents ("editing now · worktree x"), then `files.history` commits ("You",
  "<trailer> agent"; the oldest reads "created").
- Mentioned in: `files.mentionedIn { root, path }` (protocol addition) → artifact links.

## Tests

`Files.test.tsx`: trees per project, revealed compacted folders, markers, lazy expansion via
click and ←/→, opening another project, switching to a worktree checkout; `visibleRows` /
`ancestorDirs` model.

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
