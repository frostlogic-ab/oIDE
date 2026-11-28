# Artifacts screen

The library of local designs, docs and whiteboards that you and your agents read and write. An
artifact is a folder of files (one entry file opens first); a claude.ai link becomes an artifact
through an agent that retrieves its files ([ADR 0014](../../adr/0014-multi-file-artifacts-retrieved-by-agents.md)).
Design: [../raw/design/Artifacts.dc.html](../raw/design/Artifacts.dc.html). Store and on-disk
layout: [artifacts.md](artifacts.md). Frame, router and stores: [desktop-shell.md](desktop-shell.md).
Code: `apps/desktop/src/renderer/src/screens/Artifacts/`.

## Layout (as designed)

- **Toolbar**: "Artifacts" (18px), kind tabs All / Designs / Docs / Whiteboards (28px pills,
  `role="tab"`, arrow keys), Project select, and one accent **+ New artifact** (the design's
  "Import from claude.ai" button is gone: creating from a link is a choice inside New artifact).
  The search field sits in the header's actions slot (`<HeaderSlot name="actions">`), because a
  fifth control would wrap the designed toolbar at 1440px.
- **Grid**: `repeat(auto-fill, minmax(220px, 1fr))`, 12px gap. Each card is a `<button>` with a
  live thumbnail (`ArtifactThumbnail`, `Thumbnail.tsx`): the real design in the same sandboxed,
  network-less `oide-artifact://` frame as the detail pane, scaled from 1280px and without a
  scrollbar; the rendered doc; the whiteboard drawing. It is decorative (`aria-hidden`, no pointer
  events, `tabindex=-1`), mounts when the card nears the viewport (IntersectionObserver) and falls
  back to the design's stylised kind blocks for version-0 cards, a running or failed retrieval, a
  broken import, or when main serves no preview URL (dev:web). Then the title,
  "Kind · project" and a third line. Normally the use line: "Being written by an agent" (green),
  "Written by an agent · 1h ago", "Read by 2 agents", "Not used by agents". While a retrieval runs:
  a running-green dot that pulses (`motion-safe:animate-pulse`, still under prefers-reduced-motion)
  and "Retrieving with an agent"; after a failed one: a red alert icon and "Retrieval failed" (no
  files yet) or "Update failed" (the current version stays). A **broken import**
  (`meta.brokenImport`: a link-only import made by an older oIDE) shows a red `Import has no
  content` badge. Icon plus text everywhere, never colour alone. Selected card = accent border.
  Double-click opens it. Dropping files on the grid opens New artifact on Files with them chosen.
- **Detail pane** (320–380px, `panel`): 190px live preview, title with Rename and Delete (trash
  icon) beside it, "Kind · project · origin" (origin "from claude.ai" for a claude.ai link), Open,
  Give to an agent, **Update** (refresh icon, accessible name "Update from claude.ai"; only for a
  claude.ai link with files and no retrieval running or failed), Open in claude.ai, a line
  "Retrieved 2h ago. Not synced: Update gets the latest version.", the retrieval block when one is
  running or failed, AGENTS USING IT, HISTORY (with "Compare versions"; "No versions yet." at
  version 0). With no files yet (version 0) the retrieval block takes the preview's place; for a
  broken import the **fix panel** does (`FixImportPanel.tsx`, below).
- **Retrieval block** (`Retrieval.tsx`, detail pane and open view):
  - *Retrieving*: pulsing green dot, "Retrieving from claude.ai", one line ("An agent is opening
    the link with your Claude Code CLI and copying its files here. The artifact fills in when it is
    done." or, on an update, "You're seeing v3 until it's done."), the agent's live status from the
    agents store in a `role="status"` box (status dot, agent title, status label, last activity line
    in mono; "Waiting for a free slot (Settings › Agents › Max running)." when queued; "It needs you:
    open the agent to answer." on a permission prompt or question), **Open agent** (Focus) and
    **Cancel**.
  - *Failed*: red card, alert icon, "Retrieval failed" / "Update failed", the agent's reason
    (`retrieval.error`, or "The agent stopped without handing over the files."), "v3 is unchanged."
    on an update, **Retry**, **Open agent**, and **Delete** when there are no files.
  - *Needs a project*: when `artifacts.refresh` answers `needs_project` (the artifact has no
    project), "Run the agent in" (a project select) with Update / Retry and Cancel, inline.
- **New artifact dialog** (`Dialogs.tsx`, 560px): a **Start from** radio group (the shared
  `SegmentedControl`: roving tabindex, arrow keys, Home / End): **A link** | **Files** | **Blank**.
  The last choice is kept between uses; Project and "Where it lives" are reset from the scope each
  time. The primary button stays disabled until the choice can go, with the reason beside it as
  its `aria-describedby`; focus starts on the first field of the choice; Esc, × and Cancel close.
  A press on the scrim closes it only while the form is untouched (no link, title or kind typed or
  chosen, no files picked or dropped, Project and "Where it lives" still the defaults; switching
  "Start from" alone doesn't count) and never while a create is in flight, so a stray click does
  not throw away what was entered.
  - *A link*: "Link" (mono) checked live with `classifyClaudeLink` (reason inline, `role="alert"`,
    `aria-invalid`; a half-typed link waits for blur), hint "An agent opens the link with your
    Claude Code CLI and copies its files here. You can follow it on the Wall; the artifact fills in
    when it's done.", Title (optional, "Uses the artifact's own title"), Kind (Detect, Design, Doc,
    Whiteboard). Project is required (no "No project"; hint "The agent runs in this project.").
    **Retrieve**. Reasons: "Paste a claude.ai link first.", "Fix the link first.", "Choose the
    project the agent runs in.", "Add a project first: the agent runs in one."
  - *Files*: a dashed zone with **Choose files…**, **Choose a folder…** and "or drop files here"
    (the whole dialog takes a drop, and a drop on another choice switches to Files); the chosen
    files listed by name (mono, 132px scroll, a Remove button each, count in a live region); refused
    drops as alert lines; **Opens on** (a select) when a design has several pages; Title (optional),
    Kind ("Detect (Design)" from the names, `kindFromFiles`), **Came from** (optional claude.ai link,
    checked like the link field). **Create**. Reasons: "Choose or drop files first.", "Fix the link
    it came from, or clear it.", and for dropped images alone "Add a page or another file too, or use
    Choose files… for images: a drop doesn't give oIDE an image's file path."
  - *Blank*: Title (required), Kind (Design / Doc / Whiteboard). **Create**. Reason "Give it a
    title first."
  - Shared, at the bottom: Project and "Where it lives" ("In the project's repo", `.oide/artifacts/`,
    needs a project; or "Personal"). Default: the repo for a blank artifact with a project, Personal
    for a link or files, until the user picks.
- **Open (Viewer.tsx)**: back button, title, "Kind · project · vN" (plus "· 9 files" for several
  files, "no files yet" at version 0), Unsaved changes badge, Save, and a "More actions" menu
  (Rename, Delete). Below it, left to right: the **Agent panel** (`AgentPanel.tsx`, below), the
  Files panel when there are several files, and one content pane (a `<main>`). The pane's toolbar
  has a **View** switch, the shared `SegmentedControl` (a radio group: roving tabindex, arrow keys,
  Home / End): docs and designs **Preview | Code | Compare**, whiteboards **Board | Compare**; and,
  on Preview of a doc or design, the **Comment** toggle (point and comment, below). Code is the
  Monaco editor as before (Save, Ctrl/Cmd+S, dirty tracking, conflict banners); Preview renders a
  doc's draft live and a design's saved version. A doc or design opens on the last choice of
  Preview or Code (in memory, `feedbackStore.ts`, Preview at first), on Code when unsaved edits come
  back, and on Preview for an extension artifact type (its own viewer). Unsaved entry edits are kept in `draftStore.ts` (a module-level zustand store keyed by
  artifact id: base version and content, baseline, the entry file, draft; in memory only), so leaving
  the screen from the rail, Ctrl+K or a toast does not lose them. The store also remembers which
  artifact's Viewer was open when the screen was left (`lastOpenId`, taken from the Viewer actually
  rendered, so a route change while one is open never records an artifact the user didn't see; any
  close forgets it). Back on Artifacts the Viewer
  reopens once, on the route's artifact when it has a draft, or (the rail and Ctrl+K carry no
  artifact) on that remembered one; there is no "most recent draft" fallback, so the grid stays
  browsable. Back to the grid with unsaved edits asks **Keep editing / Keep as draft / Discard**:
  Keep as draft closes the Viewer, leaves the draft in the store and forgets `lastOpenId` (so the
  screen does not reopen it); grid cards with a draft show an **Unsaved** badge, which is the way
  back (the card opens the Viewer with the draft). Save, Use theirs and Discard clear the draft, and
  so does deleting the artifact or finding it gone from the list; that clean-up runs only after a
  list load succeeded, so a failed `artifacts.list` never deletes drafts (and the resume waits for
  the next good load). If an agent saved a newer version meanwhile, the restored draft goes through
  the usual conflict banner (Keep mine / Use theirs). If an agent changed the artifact's entry
  file meanwhile, the draft (text of the old file) is dropped with a warning toast instead of being
  shown as the new entry's text and saved to the wrong file, both when the screen resumes it and when
  the user reopens it from its card. After Keep as draft, coming back to the screen on a route that
  names the artifact (a chip, a toast action) reopens it with the draft; while the grid is already
  showing, such a route only selects it, and opening the card (double-click or Enter) shows the draft. The screen subscribes to the draft ids
  only (`draftIdsKey`), not to the draft text, so typing does not re-render it. Unsaved edits to a
  non-entry file in the Files panel are not kept. Editors are lazy chunks:

  | Kind | Code | Preview |
  | --- | --- | --- |
  | Doc | Monaco (Markdown, word wrap) | Rendered Markdown of the draft, live as you type |
  | Design | Monaco (HTML, or JavaScript when `meta.entry` is `App.jsx`; the entry's language otherwise) | Sandboxed preview of the **saved** version, which reloads on save ("Showing v3. Save to refresh the preview.") |
  | Whiteboard | (Board) Embedded Excalidraw (`WhiteboardEditor.tsx`), dark theme on the oIDE tokens | (the board is the view) |

  Monaco reuses the Files screen setup (`screens/Files/monaco/setup.ts`: local package, `oide-dark`
  theme, inlined editor worker) through a dynamic import, so the Artifacts chunk stays small.
  Ctrl/Cmd+S saves in every editor. Plain keys typed in an editor stay there (`keepKeysInEditor`):
  Monaco types through an EditContext element and Excalidraw through its canvas, which the keymap
  does not see as editable, so J / K / N / Esc would otherwise also run app shortcuts.
  With no files yet (version 0), and for a broken import, the retrieval block (or the fix panel)
  stands in for the Agent panel, the View switch, the editors and Save.
- **Files panel** (`FilesPanel.tsx`, open view, when `fileCount > 1`): a 232px `nav` "Files" left of
  the editors: a compact tree (folders first, then files, sorted; 12px indent per level; JetBrains
  Mono), the open file `aria-current`, the entry marked with an accent "Opens on" badge, size in the
  tooltip. Selecting the entry shows the tabs and editors above. Selecting another file replaces
  them (the View switch hides):
  - a text file opens in Monaco (language by extension, `languageForPath`), with a design's
    preview beside it; Save writes it (below); switching away from unsaved edits asks "Discard your
    changes?";
  - an image shows inline (an `<img>` with a data: URL from `artifacts.readFile`; the renderer CSP
    allows `data:` images but not the `oide-artifact:` scheme); other binary files say they can't be
    shown;
  - a design's other HTML pages offer **Open on this page** (disabled with "Save your changes first."
    while anything is unsaved).
- **Broken import** (`FixImportPanel.tsx`, in the detail pane and, full width, in the open view in
  place of the tabs and editors): heading "This import has no content", "An older oIDE saved only
  the link. An agent can retrieve the files with your Claude Code CLI, or you can choose files you
  downloaded.", **Retrieve with an agent** (`artifacts.refresh`; "Retry with an agent" after a
  failure, with the reason; not offered for an old chat link, which can't be retrieved), **Choose
  files…** and **Delete**. While the retrieval runs the retrieval block shows in its place. In the
  open view the first action has focus.
- **Agent panel** (`AgentPanel.tsx`, open view, left of the content; a `ResizableAside`, panel
  `artifacts.agent`: 400px default, 320 to 720, width saved in `settings.ui.panelWidths`). Heading
  "Agent" and an icon button **Hide the agent panel** (chevron); hidden, it is a 40px strip with
  **Show the agent panel**, the agent's status dot and the number of unsent comments (the choice is
  kept in memory for every artifact). The artifact's agent is the newest live summary in the agents
  store whose `artifactId` is this artifact (`artifactAgentOf` in `model.ts`; archived ones never).
  - *No agent yet*: "Tell an agent what to change. It can edit, add and delete this artifact's
    files; each change is a new version you can compare or restore." and a hint to use Comment;
    **Permission mode**, **Model** and **Effort** selects (defaults as Spawn picks them: the
    project's Spawn default mode from `settings.forProject`, else Settings' default mode, else Auto;
    the lead of the project's or the default focus preset, family aliases resolved through Settings ›
    Models › Model versions; a custom-model preset falls back to Opus); a composer ("What should
    change?", Enter sends, Shift+Enter a new line, paste / drop / Attach file). Sending starts the
    agent. `needs_project` shows "Run the agent under" (a project select) with Start and Cancel,
    inline; `busy` reloads the agents list and toasts main's reason with "Your message is still
    here."
  - *With an agent*: status (dot and label), **Open in Focus** (icon button) and a "More agent
    actions" menu with **New conversation** (archives the agent so the next message starts a new
    one; disabled while it works). A settings row: the context ring button (Focus's
    `ContextRingButton`, warn / danger from `agents.contextWarnAt` / `agents.contextSuggestCompactAt`;
    opens Focus's `CompactDialog` → `agents.compact`), **Model** and **Effort** selects (the families
    Spawn offers; efforts gated by the CLI's `effort` / `effort:<level>` features; "Model and effort
    apply from the next message." as their description and tooltip, and a toast after the change;
    an agent on a custom model shows its model name instead), **Permission mode** (Focus's
    `modeChoices`; an artifact agent counts as "in a worktree", so Bypass is offered when Settings
    allow it), and **Stop** while it works. Then Focus's own pieces, unchanged: `Transcript`
    (`useTranscriptHistory` / `useFocusHistory`, `buildRows`), `Streaming`, `PermissionPrompt`
    pinned above the composer, and `Composer` (its `compact` prop shows Attach artifact as an icon;
    `/compact` asks first; Shift+Tab cycles the mode). The panel is a size container, so the
    permission prompt stacks its buttons as it does in a narrow Focus.
- **Point and comment** (`Comments.tsx`, Preview of a doc or design): **Comment** (speech-bubble
  icon and text, `aria-pressed`) on the pane's toolbar. While on, the preview has an accent border,
  a line says what to do, and Esc (or Esc inside the frame) turns it off instead of closing the
  Viewer. A pick opens a small form at that point ("What should change here?", where it points and
  the quoted text above it; **Add** or Ctrl/Cmd+Enter, **Cancel** or Esc). Added comments are
  numbered **pins**:
  - *Design*: the frame draws the numbered markers (the screen sends it the pins of the page it is
    on). Disabled, with the reason as its description, when main does not serve the preview (the
    `srcdoc` fallback runs no scripts: past versions, the dev mock without a URL) or for a React
    notice: "Comments need the live preview, which the desktop app serves for the saved version."
  - *Doc*: a click on a heading, paragraph, list item, code block, quote, table or image picks it
    (links do not open while commenting); "where" is the nearest heading above ('Under "Limits" ›
    list item'). Picked blocks get an accent outline and their number in the margin
    (`data-oide-pin`, drawn by CSS).
  - **Feedback** tray (Agent panel, above the composer, only when there are pins): "N comments",
    then each pin: a checkbox (ticked by default, "Send comment N"), its number, where, the quoted
    text, the comment, **Edit** (inline, Save / Cancel) and **Remove**. **Send N to agent** sends the
    ticked ones with whatever is typed in the composer as one text message (`buildFeedbackMessage`);
    with no agent yet it starts one with that text. Sent pins are removed; unsent ones stay while
    oIDE runs (in memory, per artifact, `feedbackStore.ts`), also after closing the Viewer.
- **Compare**: From / To selects (every version, plus "Your unsaved changes" when dirty) over a
  read-only Monaco diff (`VersionDiff.tsx`, same theme as the Review split view) with a "+N −M
  lines" count. Whiteboard JSON is pretty-printed first so the diff is per property.

### Boards (kanban, [ADR 0022](../../adr/0022-kanban-boards.md))

Model, operations and agent tools: [kanban-boards.md](kanban-boards.md). Code: `Board/`.

- **Grid and detail pane**: a **Boards** kind tab; the thumbnail and the 190px preview are
  `BoardMini` (each column's coloured label and count over its first cards; the preview is a
  `role="img"` "Board: <title>, N columns, M cards"); `KindThumb` draws four lanes for version 0.
  New artifact › Blank offers **Board** (and Files detects a `board.json`); a claude.ai link never
  makes a board.
- **Open (`BoardViewer.tsx`)** in place of the Viewer: back button, title, "Board · project · vN ·
  N cards · last change by <you / agent> <time>", **Search cards** (title, description and property
  values; drag and drop is off while searching), **Columns and properties**, **New card** (adds
  "Untitled" at the top of the first column and opens it), and More actions (Rename, Delete). Below:
  the Agent panel (the board's artifact agent; its hint says what it can do with tickets), the
  columns (`BoardView.tsx`) and, when a card is open, the card panel (`CardPanel.tsx`, a
  `ResizableAside`, panel `artifacts.board-card`, 420px, 320 to 760). Esc closes the card, then the
  board. A `role="status"` live region says what moved.
- **Columns**: 280px lanes tinted with the column colour, a header with the coloured name chip and
  count (an `h3`), **+** (new card) and a menu (Rename inline, New card, Move left / right, the nine
  colours as a pick-one list, Delete column; delete asks where its cards go). Headers drag to
  reorder; an accent bar shows where the column lands. **Add column** at the end.
- **Cards**: the column's tint over the card surface, the title as a `<button>` (opens the card), the
  chips of the properties shown on cards (option colours; text, numbers and dates plain), the
  comment count and up to two linked agents with their status dot. A hover / focus menu: Open, Move
  up / down, Move to <column>, Delete card. Cards drag within and between columns (an accent line
  shows the drop point; a drop where it was saves nothing). **Keyboard**: Alt+←/→ move the card to
  the previous / next column (bottom), Alt+↑/↓ within the column; focus follows the card.
  **+ New card** at the bottom of each column takes titles one after another (Enter adds, Esc ends).
- **Card panel**: the title (saved on blur or Enter; an agent's new title shows unless you are
  typing), **Column** select, one row per property (select: a select with Empty; multi-select:
  toggle chips with `aria-pressed` and "Add an option…"; checkbox; text, number, date and link
  fields saved on blur / Enter, Esc puts the value back), **Edit properties**, **Agents** (each
  linked agent with its status and a link to Focus; one no longer on the Wall can be removed),
  **Start an agent** (Spawn with the ticket, see [kanban-boards.md](kanban-boards.md)),
  **Description** (rendered Markdown with **Edit**: a textarea, Ctrl/Cmd+Enter saves, Esc cancels; a
  note when the description changed meanwhile), **Comments** (author, time, text; delete on hover;
  Ctrl/Cmd+Enter posts) and Delete card (asks first).
- **Columns and properties** (`BoardSettings.tsx`): a dialog with Properties and Columns tabs.
  Properties: name (saved on blur / Enter), type, "On cards", move up / down, delete (says how many
  cards lose a value); select options with colour, name and delete, and "New option". Columns: colour,
  name, card count, move, delete (with "Move its N cards to"). Add property (name + type) and Add
  column at the bottom.
- **Saving**: every change is a board operation sent with `artifacts.boardApply`, applied locally at
  once and replaced by main's answer; calls go in order; a refusal puts the board back with an error
  toast. An agent's change reloads the board through `artifacts.changed`. History and restore work
  as for every artifact.

## Data flow

| What | IPC |
| --- | --- |
| Grid | `artifacts.list({})`, then `artifacts.uses({ ids })` (one call for all use lines); both reload on `artifacts.changed` |
| Detail | `artifacts.get({ id })` (meta, content, uses, versions), reloaded on `artifacts.changed` for that id |
| Design preview | `artifacts.previewUrl` → `oide-artifact://<id>/<entry>` in `<iframe sandbox="allow-scripts">` (opaque origin, main serves it with a no-network CSP). Main returns the **entry's** URL, so relative links to CSS, images and other pages of a multi-file design work. React designs (`entry: App.jsx`) use the same URL: main serves a generated page that runs the bundled offline runtime, under the same no-network CSP. Without a URL (dev mock), and for past versions, **HTML** goes in through `srcdoc` with `sandbox=""` (no scripts; relative files don't load). **React source never goes into `srcdoc`** (`looksLikeReact` on the content): the frame shows "Save to preview React changes. Use Compare to see older versions." (or, without a URL, "React designs preview in the desktop app.") |
| Doc preview | `marked` → DOMPurify (no `script`, `style`, `iframe`, `form`, `style=`); link clicks never navigate the window, https links go to `shell.openExternal` |
| Whiteboard preview | Read-only SVG render of the Excalidraw JSON (`Whiteboard.tsx`: rectangle, ellipse, diamond, line, arrow, freedraw, text) so the detail pane never loads Excalidraw. Colours are stored as Excalidraw stores them (light theme) and drawn through Excalidraw's dark-theme filter (`invert(93%) hue-rotate(180deg)`), so it matches the editor |
| Open | Editors per kind (above). Save → `artifacts.save({ id, content, note: 'Edited by you', baseVersion })`, a new numbered version; for an artifact of several files `artifacts.writeFiles({ id, files: [{ path: entry, encoding: 'utf8', data }], note, baseVersion })`, so the other files stay as they are. Whiteboards save `serializeAsJSON(elements, appState, files, 'local')`; selecting, zooming and panning are not edits (the first serialisation after loading is the baseline). Esc / Artifacts goes back, with a "Discard your changes?" confirm when dirty |
| Agent writes while open | `artifacts.changed` reloads `artifacts.get`. A newer version the viewer did not save itself: with no unsaved edits it is loaded (Excalidraw remounts with it) and a blue status bar says "Updated by <agent> agent · v5" with See changes (v4 → v5) and Dismiss; with unsaved edits the edits stay and an amber alert says "<Agent> saved v5 while you were editing" with Compare (theirs vs yours), **Keep mine** (saves yours as v6 on top, `baseVersion: 5`, note "Edited by you over v5"; v5 stays in History) and **Use theirs**. A save refused with `conflict` (the event not seen yet) opens the same banner. Decision logic: `liveDecision` in `model.ts`. A newer version that left the entry unchanged (an agent wrote another file) is taken quietly: no reload, no conflict. A version whose entry moved to another file reloads the editor from the new entry |
| Files panel | `artifacts.files({ id })` on open and on each new version; `artifacts.readFile({ id, path })` for the selected file. A text file saves with `artifacts.writeFiles({ id, files: [{ path, encoding: 'utf8', data }], note: 'Edited <path>', baseVersion })`. Same live rules as the entry (`useArtifactFile`): someone else's version that changed this file is loaded when there are no edits ("Updated by <agent> agent · v5", Dismiss) and becomes an amber "<Agent> saved v5 with changes to site.css while you were editing it" banner with **Keep mine** (`baseVersion: 5`, note "Edited site.css over v5") and **Use theirs** when there are; a version that didn't change it is taken quietly; a `conflict` refusal reads the latest and opens the banner. **Open on this page** → `artifacts.writeFiles({ id, entry: path, note: 'Opens on <path>', baseVersion })` (no file changes) |
| Retrieval | The card line and the retrieval block read `meta.retrieval` (`activeRetrieval`, `retrievalLine` in `model.ts`) and the agent from the agents store (`retrieval.agentId`). Update and Retry → `artifacts.refresh({ id })`; `needs_project` → the inline project select, then `artifacts.refresh({ id, projectId })`; `busy` → "An agent is already retrieving it." Cancel → `artifacts.cancelRetrieval({ id })`. Open agent → `navigate('focus', { agentId })`. Main's answer updates the pane at once; `artifacts.changed` (change `retrieval`, or `saved` when the files land) reloads the grid and the detail like any change. A finished first retrieval in the open view replaces the block with the editors |
| Rename | Detail pane or the viewer's More menu → dialog (title selected, 1 to 200 characters, `aria-invalid` on error) → `artifacts.rename`. Only the title changes |
| Delete | Trash icon or More menu → "Delete <title>?" confirm (repo: "deletes its folder in .oide/artifacts/ and all N versions; copies you committed stay in git history"; personal: "can't be undone"; no files yet: "It has no files yet. This can't be undone.") → `artifacts.delete`, toast, next artifact selected. An `artifacts.changed` with `change: 'deleted'` for the open artifact closes it quietly |
| Give to an agent | `navigate('spawn', { projectId, context: [{ kind: 'artifact', id, title }] })`; Spawn pre-fills its context chips from `route.params.context` |
| Open in claude.ai | Only when `importedFrom` is an https link on claude.ai (`canOpenClaudeLink`); `shell.openExternal`. Hidden for claude.site imports: that host is not on the external-link allow-list, since anyone can publish there |
| Agents using it | Uses grouped per agent: "writes" if it ever wrote or created, else "reads"; status dot and title from the agents store; click → Focus |
| History | `versions` newest first: "v4 · edited by you · 11:20", "v3 · Window shell layout agent · added a focus view · 10:52". Click a past version → `artifacts.readVersion` → previewed with "Viewing v2 (current is v4)", **Restore** (`artifacts.restore({ id, version, baseVersion })`: the whole snapshot, every file and the entry it had, becomes a new version noted "Restored v2"; toast "Restored v2 as v5") and **Back to latest**. Compare and the preview still use the entry's text (`readVersion`) |
| Fix a broken import | `FixImportPanel`: **Retrieve with an agent** → `artifacts.refresh` (as above). **Choose files…** → `dialog.pickArtifactFiles({ folder: false })`, then `artifacts.importFiles({ filePaths, url: importedFrom (only a link `classifyClaudeLink` accepts), title, projectId, location })`, then `artifacts.get` and `artifacts.delete` of the empty import only if it is still the same broken version (an agent may have written it meanwhile); the new artifact is selected |
| New artifact › A link | `artifacts.importLink({ url, title?, kind?, projectId, location })`. Main creates the artifact at version 0 with `retrieval.status: 'retrieving'` and starts an ordinary agent in the project (on the Wall, queued behind Max running); oIDE never downloads claude.ai content itself. The dialog closes, the new artifact is selected and shows its retrieving state, and a toast says "Retrieving <title> with an agent. You can follow it on the Wall." |
| New artifact › Files | `dialog.pickArtifactFiles({ folder: false })` (several files, any type) or `({ folder: true })` (one folder); main registers the picks. Dropped files go through the preload drop bridge (`window.oide.attachDropped`, `drop.ts`, at most 50): non-image files come back by path (main registers them as picked); images come back inline with no path, so they are added right after the import with `artifacts.writeFiles({ id, files: [{ path: name, encoding: 'base64', data }], baseVersion, note: 'Added the dropped images' })`; a dropped folder is refused ("Use Choose a folder… instead"). Then `artifacts.importFiles({ filePaths, folderPath?, entry? (Opens on, when there are several pages), url? (Came from), title?, kind?, projectId?, location })`. Outside the desktop app (dev mock) a drop says "Dropping files needs the desktop app. Use Choose files… instead." |
| New artifact › Blank | `artifacts.create({ title, kind, projectId?, location })` |
| Agent panel | The agent from the agents store (`summary.artifactId`). First message → `artifacts.startAgent({ id, text, mode, model: { model, effort? }, projectId? (after needs_project), attachments? })` → the `AgentSummary` (applied to the store at once; `agents.summary` follows). Main starts it with `workIn: 'artifact-folder'`, title "Edit <title>", queued behind Max running; it edits only this artifact through oIDE's MCP artifact tools, so each change is a new version that reaches the Viewer as an ordinary agent write (`artifacts.changed`). Errors: `needs_project` (inline project select), `busy` (it already has a live agent, or a retrieval is writing it), `not_found`. Later messages: Focus's `Composer` → `agents.send`. Transcript: `agents.events` (500 newest, older on scroll) plus the live tail. Model / effort → `agents.setModel({ agentId, model, effort? })` (applies from the next message; main emits `model-changed`, so the summary's `model` / `effort` update at once; `conflict` for a custom model). Mode → `agents.setMode`. Compact → `agents.compact`. Stop → `agents.stop`. New conversation → `agents.archive` (`archiveAgent`). Open in Focus → `navigate('focus', { agentId })` |
| Point and comment (design) | Every HTML page main serves loads `/__oide/picker.js`. Screen → frame, `contentWindow.postMessage(msg, '*')` (the frame is an opaque origin): `{ type: 'oide-pick-mode', on }` and `{ type: 'oide-pins', pins: [{ n, selector }] }` (that page's pins, at most 100, selectors at most 500 characters). Frame → screen: `oide-picked` (selector, tag, text, page, rect, viewport), `oide-pick-cancel` (Esc), `oide-picker-ready` (each load; the screen sends mode and pins again). A message counts only when `event.source` is the preview frame's own window and it parses with `PreviewPickerMessage` (`@oide/protocol`); its text only fills the note the user writes and chooses to send |
| Feedback message | `buildFeedbackMessage` (`model.ts`): "Feedback on the preview of <title> (v5):", a blank line, the ticked pins in marker order numbered 1..N ("1. index.html › \`main > h2\` ("Pricing that scales"): Make this heading smaller."; docs 'Under "Limits" › list item ("Five attempts"): Say three.'), the composer's text, then "Change the artifact to address each point." (one pin: "this point"). Plain text: comments and snippets are sent as written, quotes in snippets become apostrophes and backticks in selectors too. With an agent `agents.send({ kind: 'text' })` and the composer draft is cleared; without, `artifacts.startAgent` |

The Project select is the shared project scope (`useScope`): choosing a project here also scopes the
Wall, Files and Source control, and a scope chosen there filters this grid. Selection lives in the
route (`artifacts.artifactId`, via `replace`).

## Protocol additions (this screen)

`artifacts.uses({ ids })`, `artifacts.readVersion({ id, version })`, `dialog.pickFile`, optional
`projectId` / `location` on `artifacts.import`, `context` on the Spawn route params,
`artifacts.rename({ id, title })`, `artifacts.restore`, `baseVersion` on `artifacts.save`, and `change` / `version` /
`author` on the `artifacts.changed` event. ADR 0014 added `artifacts.importLink`, `refresh`,
`cancelRetrieval`, `files`, `readFile`, `writeFiles`, `importFiles`, `dialog.pickArtifactFiles`,
`retrieval` / `fileCount` on `ArtifactMeta` (version 0 allowed) and change `retrieval` on
`artifacts.changed`; the screen uses all of them and needed no further contract change.
`artifacts.import` and `dialog.pickFile` are no longer used by this screen. The artifact agent
added `artifacts.startAgent`, `agents.setModel` (and the `model-changed` event), `artifactId` and
`effort` on `AgentSummary`, `workIn: 'artifact-folder'` and `PreviewPickerMessage` (main side and
the picker script: [artifacts.md](artifacts.md)). Telemetry ([telemetry.md](telemetry.md)):
retrieval and `artifact_agent_started` are observed in main; the renderer reports
`artifact_agent_message` (`lib/telemetry.ts` `trackArtifactAgentMessage`) for each message to an
artifact agent from this panel: `kind`, `feedback` (number of comments sent with it, 0 for a plain
message) and `has_text` (whether the user typed text), never the text or the comments.

## Excalidraw, CSP and bundle

- `@excalidraw/excalidraw` 0.18 (MIT; open question 16 chose it over tldraw), a devDependency of
  `@oide/desktop` like the other renderer libraries (bundled by Vite, not shipped as node_modules).
- **No CSP change.** Fonts are bundled: `apps/desktop/excalidraw-assets.ts` (a Vite plugin in both
  `electron.vite.config.ts` and `vite.web.config.ts`) copies `dist/prod/fonts/**` to
  `out/renderer/excalidraw-assets/fonts/` and serves them in dev; `excalidraw-env.ts` sets
  `window.EXCALIDRAW_ASSET_PATH` to that folder (absolute URL, since the packaged page's origin is
  "null") before Excalidraw loads, so they load under `font-src 'self'`. Excalidraw also names an
  esm.sh copy as a fallback `src` of every FontFace; Chromium reports a CSP violation for each of
  them (~240) when a board opens, so `excalidraw-env.ts` wraps `window.FontFace` to drop esm.sh
  sources. The e2e test checks there are no CSP violations and no failed font loads.
- Off on purpose instead of widening the CSP: file open/save and image export (the app saves through
  `artifacts.save`; SVG export subsets fonts with WebAssembly, which would need
  `'wasm-unsafe-eval'`), AI text-to-diagram (`aiEnabled={false}`), embeds (`validateEmbeddable`
  refuses all; `frame-src` only allows `oide-artifact:`). Element links open in the system browser
  (https only).
- Bundle (`electron-vite build`): first-load `index` chunk unchanged (+0.2 kB); Artifacts chunk
  53 → 75 kB; Monaco editor wrappers 8 kB (Monaco itself was already a lazy chunk); Excalidraw
  1.67 MB JS + 145 kB CSS, loaded when a board opens; fonts 13.1 MB (12.6 MB of it Xiaolai, the CJK
  hand-drawn fallback, fetched only for CJK text); about 9.8 MB of further lazy chunks
  (Mermaid-to-Excalidraw, font subsetting) that load only if those features are used.
  `out/renderer` grows from 11.6 MB to 36.3 MB on disk.

## Deviations from the design

- Search is in the header (see Layout); the design has no search.
- One **+ New artifact** button with a "Start from" choice (A link, Files, Blank) instead of the
  design's two buttons ("Import from claude.ai" and "+ New artifact"). The design has no dialog for
  either; this one is drawn with the design-system fields, segmented control and dashed drop zone.
- A link starts an agent that retrieves the files (ADR 0014) instead of a copy pasted by hand. The
  retrieving and failed states (card line, detail-pane block, open view) and the Update button are
  additions; so are the Files panel and "Open on this page".
- Failed: Delete is offered in the block only when there are no files (a failed first retrieval).
  After a failed update the artifact still has its content, so the block offers Retry and Open agent;
  Delete stays beside the title.
- The meta line says "from claude.ai" and "Retrieved 2h ago. Not synced: Update gets the latest
  version." instead of "synced from claude.ai": nothing syncs on its own.
- Open in claude.ai and Update are hidden for artifacts that did not come from claude.ai (and for
  claude.site links, which are not on the external-link allow-list).
- Grid thumbnails show the real content, not the stylised blocks drawn on the canvas (those are the
  placeholder until it loads, and for artifacts with nothing to show).
- The 190px doc preview fades its last line out (`.oide-md-fade`) instead of slicing it.
- The design has no agent in the open view, no point and comment and no Preview | Code switch: the
  Agent panel replaces the design's side-by-side editor and preview (the editor is now Code, in the
  same pane as Preview), and Edit / Preview / Compare became a segmented View switch on the content
  pane's toolbar instead of tabs in the header.

## Tests

`AgentPanel.test.tsx`: the View switch opens on Preview and moves to Code and back with the arrow
keys and Home (and is remembered), hide / show the panel; starting the agent (intro, mode and model
picked, `artifacts.startAgent` with text, mode and model, the panel switching to the agent,
`artifact_agent_message` with `feedback: 0`), `needs_project` answered with "Run the agent under";
with an agent: the transcript region and its `agents.events` page, Compact through the dialog,
model and effort through `agents.setModel`, mode through `agents.setMode`, Bypass only when Settings
allow it, no model picker for a custom model, Stop; point and comment: a pick from the frame's own
window opens the form while picks from another source or malformed messages are ignored, two pins
with one unticked send a text with only the ticked one (exact text), the frame gets the pick mode
and the markers and gets them again on `oide-picker-ready`, the unsent pin stays, comments start an
agent when there is none (with the typed text), Esc in the frame turns Comment off, a doc block
picked by click with its heading, marked and removed, Comment disabled with a reason on the
`srcdoc` fallback. `model.test.ts` also covers `artifactAgentOf`, `isAgentWorking`, `pinWhere`,
`buildFeedbackMessage` (order, ticked only, quotes, typed text, text-only) and `nextPinNumber`;
`lib/mock/library.test.ts` the mock artifact agent (writes a version, `busy`, a new one after
archiving, `needs_project`). `Editors.test.tsx` runs with Code remembered and switches to Preview to
check the live doc render. `Editors.test.tsx` "Unsaved edits survive leaving the screen": draft and badge back after a remount,
reopening from the rail (no artifact in the route), Keep as draft (grid kept, badge, no auto-reopen,
the card reopens it), no Keep as draft without edits, a failed `artifacts.list` keeps the drafts
and resumes on the next good load, drafts of deleted artifacts are pruned, a changed entry file
drops the draft with a notice (on resume and on reopening from the card), a route change while a Viewer
is open never sets `lastOpenId` to an unseen artifact, Save / Discard / Use theirs clear it, an agent write while away opens
the conflict banner, whiteboard drafts. `Artifacts.test.tsx` "draft store subscription": no
re-render per keystroke. `Dialogs.test.tsx`: New artifact closes on a scrim press only while untouched (a typed title, a changed
project, a typed link or a dropped file keep it open; Esc, × and Cancel still close).
`model.test.ts` (filters, use lines, reads/writes grouping, version labels, claude.ai host check and
`importLinkError`, `kindFromFiles`, `entryCandidates`, `baseName`, `activeRetrieval` /
`retrievalLine` / `canUpdateFromLink`, Monaco language per entry and per file, `fileTree`, image data
URLs and pages, front matter, whiteboard validation, `liveDecision`, author labels, diff text, rename
titles), `Artifacts.test.tsx` (kind / scope / search filtering, one creation button, Give to an agent
route with the context chip, Open in claude.ai only for claude.ai imports, DOMPurify strips scripts;
**New artifact**: the "Start from" radio group with arrow keys; A link: live check with the chat-link
reason and `aria-invalid`, each disabled reason as `aria-describedby`, no paste box or steps,
`importLink` with the project (and title, kind, location when chosen), no projects; Files: picked
files listed and removable, "Opens on", "Came from" check, `importFiles` with `entry` and `url`, a
folder by `folderPath`, several dropped files with the folder refusal, dropped images added with
`writeFiles` and `baseVersion`, images alone refused, the dev build's drop message; Blank: title
required, kind, repo default; scope reset and the kept choice; files dropped on the grid open Files;
**retrieval**: retrieving and failed card lines with icon and text, the retrieving block with the
agent's status, activity and queued line, Cancel, Open agent, the failed block with its reason,
Retry and Delete (no-files copy), Update with "Retrieved 2h ago", `needs_project` answered with the
inline select, `busy`, the current version kept on show during an update, reload on change
`retrieval`, the open view at version 0; **broken imports**: badge, Retrieve with an agent,
Choose files… imports then deletes (and keeps it when it changed), an old chat link neither retrieved
nor carried over, focus in the open view; React design: saved version by URL and a notice for a past
version, never `srcdoc`), `Editors.test.tsx` (Monaco, Excalidraw and the diff editor stubbed: doc
edit with live preview saved as v2 with `baseVersion`, agent write loaded with "Updated by",
conflict banner with Compare / Keep mine / Use theirs, a `conflict` save error, whiteboard dirty
tracking and reload, rename, delete with confirm, compare from History; **several files**: the tree
with "Opens on", another file saved with `writeFiles` and `baseVersion`, the discard confirm, entry
saves through `writeFiles`, another file's agent write taken quietly vs a conflict with Keep mine,
reload and Use theirs, an image as a data URL, Open on this page; a first retrieval landing while
open), `lib/mock/library.test.ts` (the dev mock's retrieval: an /artifact/ link fails with the
reason, a claude.ai/design link becomes nine files, `busy`, `needs_project`, cancel, files read and
written, `conflict`), `excalidraw-env.test.ts` (asset path, CDN sources dropped). E2E
`apps/desktop/e2e/artifacts.spec.ts`: the dialog opens on "A link", a chat link is refused there,
then Blank creates a doc that is edited in Monaco and saved as v2; draw on a whiteboard in the
packaged-CSP build and save v2 with bundled fonts and no CSP violations.

## Gaps

- Whiteboards have no source (JSON) view; agents write the JSON directly and Compare shows it.
- An agent write to a whiteboard you have not edited remounts Excalidraw, which resets zoom and scroll.
- Excalidraw image export and "copy as SVG" are off or degraded (see Excalidraw, CSP and bundle);
  "copy as PNG" from its context menu still works.
- The Xiaolai CJK font is 12.6 MB of the bundle; drop it from `excalidraw-assets.ts` if size matters
  more than hand-drawn CJK text (CJK then falls back to a system font).
- The app keymap treats Monaco's EditContext element as non-editable (`lib/keymap.ts`
  `isEditableTarget`); the Artifacts editors stop plain keys themselves, other Monaco hosts (Files)
  may still see J / K / N shortcuts fire while typing.
- Dropping files works only in the desktop app (the preload bridge reads the paths); the dev mock
  has no `attachDropped`, so use Choose files there. A drop takes at most 50 files and no folders.
  Dropped images have no path, so they arrive as a second version ("Added the dropped images"), and
  images alone can't start an artifact by drop (Choose files… can).
- React designs preview only as the saved current version; an older version or unsaved edit shows a
  notice (use Compare).
- Several files: Compare and History › view work on the entry file only (`readVersion`); Restore
  brings back every file (`artifacts.restore`). The Files
  panel edits one non-entry file at a time, has no rename, add or delete, and no Compare for
  non-entry files. The design preview beside a non-entry file shows the saved version, so a CSS
  edit shows after Save.
- With today's CLI most claude.ai `/artifact/` links fail retrieval with a reason (no CLI tool reads
  them yet); the failed block says why and offers Retry, Open agent and Delete. Claude Docs and
  claude.ai/design links work when the CLI has those connectors.
- A replacement made from a broken import's files gets a new id, so agents that knew the old id
  must be pointed at the new one.
- Agent panel: not offered at version 0 or on a broken import (the retrieval block and the fix
  panel own that space), so an agent cannot create the first files of an empty artifact from here.
  Its rows are Focus's, at Focus's sizes; subagent cards open Focus. A model change applies from the
  next message, not to a turn already running. The transcript store is Focus's single-agent store,
  so the panel and Focus never show two agents at once (they are never on screen together).
- Point and comment: picking in a doc is by pointer only (no keyboard way to pick a block; typing in
  the composer is the alternative). Doc markers follow the block's index, so an edit that adds or
  removes blocks above a pin moves its marker. Design pins point at the saved version's elements
  by selector; after the agent changes the page a selector may match another element or none. Pins
  live in memory only (lost when oIDE quits). Whiteboards have no point and comment.
