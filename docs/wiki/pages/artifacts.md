# Artifacts

Local artifacts that oIDE stores, previews and hands to agents. An artifact is a folder of files
(one entry file plus any pages, styles, images it needs). claude.ai has no public API: a linked
artifact is retrieved by an agent running the user's own `claude` CLI, never by oIDE itself. Sources:
[../raw/build-brief.md](../raw/build-brief.md), "Artifacts integration"; decisions
[ADR 0004](../../adr/0004-artifact-versions-as-numbered-snapshots.md) (numbered snapshots),
[ADR 0013](../../adr/0013-react-designs-with-a-bundled-offline-runtime.md) (React designs),
[ADR 0014](../../adr/0014-multi-file-artifacts-retrieved-by-agents.md) (multi-file artifacts, retrieval
by agents). Related: [storage.md](storage.md), [protocol.md](protocol.md), [mcp-server.md](mcp-server.md),
[screen-artifacts.md](screen-artifacts.md), [telemetry.md](telemetry.md).

## Store (`packages/store/src/artifacts.ts`, `artifact-files.ts`)

### Layout on disk

```
<repo>/.oide/artifacts/<slug>/     location "repo": shared with the team through git
<app-data>/artifacts/<slug>/       location "app-data": personal
  artifact.json                    ArtifactMeta (+ oIDE's internal notes, below)
  <files of the current version>   index.html | App.jsx | doc.md | board.excalidraw, or many files:
                                   project/Main.html, site.css, shots/home.png, canvas.json …
  .versions/versions.json          ArtifactVersion[] (version, ts, author, note) + each version's entry
  .versions/<n>/…                  full snapshot of every file of version n
  .versions/.sync                  only while the root is being brought in line with a new snapshot
```

Every version is a full snapshot of the folder (ADR 0004 per folder). Single-file artifacts made before
ADR 0014 already fit (`.versions/<n>/<entry>`); nothing is migrated. Version 0 is a linked artifact
waiting for its first retrieval: no files, `versions.json` is `[]`, `fileCount` 0.

| Kind | Default entry | New content |
| --- | --- | --- |
| design | `index.html` (HTML, SVG), `App.jsx` (React), or any HTML / JSX / TSX / SVG file of a multi-file design | minimal HTML5 page with the title |
| doc | `doc.md` (or any text file, usually Markdown) | Markdown with front matter (`title`, `kind`, `importedFrom`) added when missing |
| whiteboard | `board.excalidraw` (or any Excalidraw JSON object) | empty Excalidraw scene; the entry must be a JSON object |

`ArtifactMeta.entry` is any `isSafeArtifactPath` file of the current version; `fileCount` is derived on
every write and rescan. `artifact.json` may also hold `oideInternal: { autoTitle?, autoKind? }`: the
title and kind are still oIDE's guesses for a link import, so the first retrieval may replace them (a
rename makes the title the user's). The folder is the source of truth; SQLite (`artifacts`,
`artifact_uses`) is an index plus the uses log. oIDE never commits artifacts.

### Paths and limits

- `ARTIFACT_LIMITS` (protocol): 500 files, 10 MB per file, 100 MB per version, paths at most 260
  characters and 16 deep. Checked on the whole new version before anything is written.
- `isSafeArtifactPath` (protocol, shared with the renderer): relative, forward slashes, no empty / `.` /
  `..` segments, no drive letter, control characters or `<>:"|?*\`, no segment ending in a dot or space,
  no Windows device names, no `~<digit>` (a Windows 8.3 short name: `ARTIFA~1.JSO` is `artifact.json`),
  and not oIDE's own names at the top (`artifact.json`, `.versions`, `.staging`, `__oide`).
- `resolveInside(root, parts, { reservedTop? })` (`artifact-files.ts`) is the file-system half and does
  not trust the string: it refuses a lexical escape, a symbolic link at the root or in any existing
  component, a real path (or real parent) outside the real root, and a real first segment that is a
  reserved name or differs from the one asked for (an alias). Only the store's own calls may reach
  `.versions` (`reservedTop`).
- Two paths that differ only in case are one file (Windows, macOS): refused when given together; a file
  and a folder with the same name are refused.
- Writes never go through an existing file: temp files are created exclusively (`wx`, `COPYFILE_EXCL`)
  and renamed into place (a rename replaces a planted link, never its target); snapshots are built in a
  fresh `.versions/.tmp-…` folder and renamed to `.versions/<n>`. `artifact.json`, `versions.json` and the
  `.sync` marker are read only when they are regular files; rescan removes a marker that is a link.
- Folder walks (`walkFolder`) never follow links (they are skipped), skip OS clutter (`.DS_Store`,
  `Thumbs.db`, `desktop.ini`) and are bounded by depth and file count.
- Text or binary (`isTextFile`): known binary extensions (images, fonts, archives, media) are binary;
  anything else is text when it is valid UTF-8 without NUL bytes. `files()` decides from the first 64 KB;
  `readFile` from the whole file. Text crosses IPC and MCP as UTF-8, everything else as base64.

### Writing a version

`commit` (private, under the per-artifact lock): check limits, paths and the entry (it must be a file of
the version that fits the kind: a design opens on HTML / JSX / TSX / SVG, or on content that
`isDesignContent` accepts; a whiteboard on an Excalidraw JSON object; a doc on a text file), check every
destination resolves inside the folder, write the full snapshot, then `versions.json`, then the `.sync`
marker, `artifact.json` and the index, then bring the root in line (files that go or change case are
deleted first, so a case-insensitive file system never loses a new file; new and changed files are
copied in atomically; emptied folders go), then remove the marker. A crash after the snapshot is finished
by the next `rescan` (it syncs the root from `.versions/<version>` when the marker is there).

### API

`new ArtifactStore({ db, appDataDir, projectPath: (projectId) => string | undefined, now?, onChange? })`

`onChange(id?, info?)` gets an `ArtifactChange` `{ change: 'created' | 'saved' | 'renamed' | 'deleted' | 'retrieval', version?, author? }`;
main forwards it as the `artifacts.changed` event (`{ id, change, version, author }`, plus `change: 'used'`
for MCP uses), so an open editor can say "Updated by <agent>" without a refetch.

- `create({ title, kind, projectId?, location='app-data', content? }, author='user')` → version 1, one file.
- `createLinked({ url, title?, kind?, projectId?, location? })` → version 0, `importedFrom` = the link
  (`claudeImportUrl`, refused with `bad_link`), kind `design` unless given; the title is
  "Imported from claude.ai" unless given. Records `autoTitle` / `autoKind` for what the user left empty.
- `list({ projectId?, kind? })`, `read(id, agentId?)` → `{ meta, content }` (the entry's text; `''` at
  version 0), `get(id)` → `{ meta, content, uses, versions }` (the `artifacts.get` IPC shape), `metaOf(id)`
  (indexed meta, no file access).
- `files(id, version?)` → `ArtifactFile[]` sorted by path; `readFile(id, path, version?)` →
  `ArtifactFileContent`. Version 0 has no files (`readFile` refuses).
- `save(id, content, { author, note, baseVersion? })` writes the entry file as the next version and
  keeps every other file. A single-file design follows its content (`designEntryFor`: React source is
  `App.jsx`, HTML `index.html`; the old one goes); a multi-file design keeps its entry. With `baseVersion`
  it throws `ArtifactError` `conflict` when the artifact has moved on.
- `writeFiles(id, { files, deletes, entry?, note?, author?, baseVersion? })`: one new version; `files`
  are `{ path, encoding: 'utf8' | 'base64', data }` (base64 checked strictly); deleting the entry needs a
  new `entry`; an unknown delete is refused.
- `commitFolder(id, srcDir, { entry?, kind?, title?, note, author, retrieval })`: the files under `srcDir`
  (a retrieval's staging folder, outside the artifact) replace the whole set as one new version and the
  retrieval is recorded in the same `artifact.json` write. The agent's `kind` applies only while
  `autoKind` (else the guessed kind follows the entry or the files); its `title` only while `autoTitle`.
  The entry defaults to `pickEntry(kind, paths)`: a design opens on `index.html` or `App.jsx` at the root,
  else the shallowest HTML page, else the shallowest JSX/TSX; a doc on `doc.md`, else the first Markdown
  (then `.txt`) file; a whiteboard on the first `.excalidraw`, else the first `.json`. A refusal changes
  nothing. Both internal notes are cleared on success.
- `setRetrieval(id, retrieval?)`: the retrieval state, no new version (`change: 'retrieval'`).
- `rename(id, title)`: trims and collapses whitespace, 1 to 200 characters (`ArtifactError` `invalid_input`);
  only `artifact.json` and the index change. The folder (slug), id and versions stay. Not a version.
- `delete(id)`: removes the folder (all versions), the index row and the uses log; `false` if unknown.
- `versions(id)` (newest first), `readVersion(id, n)` (the entry text of version n: its own entry from
  `versions.json`, else the current one, else the fixed names), `dirOf(id)`, `root(location, projectId?)`.
- `importUrl({ url, content, ... })`: pasted content, **never a link alone** (a link goes through
  `createLinked` and an agent). Checked before anything is written, refusals are `ArtifactError`
  `invalid_input` with a `reason` (telemetry only): the link (`classifyClaudeLink`: https, no user name or
  password, claude.ai `/artifact/<id>`, `/code/artifact/<id>`, `/public/artifacts/<id>`, `/design/…`, or
  claude.site `/artifacts/<id>`; a chat link is refused with what to copy instead, `bad_link`); content
  present (`no_content`), at most 10 MB (`too_large`), not the old placeholder (`stub_content`), fitting
  the kind (`wrong_kind`). The kind and title follow the content unless given (`inferKindFromContent`,
  `titleFromContent`).
- `importFile({ filePath, url?, title?, kind?, ... })`: one `.html/.htm/.svg/.jsx/.tsx` (design),
  `.md/.markdown/.txt` (doc), `.excalidraw` or Excalidraw `.json` (whiteboard) file, 10 MB, stored under
  the fixed entry name.
- `importFiles({ filePaths? | folderPath?, entry?, url?, title?, kind?, ... })`: several picked files (each
  at the top by its name) or a picked folder (its files recursively, relative paths kept, links and `.git`
  skipped, an unsafe name refused with `bad_path`). One picked known text file goes through `importFile`.
  The kind and entry follow the files unless given; the title comes from the entry (`<title>`, `# heading`),
  else the folder or file name.
- `brokenImport` (derived on read, never stored): an artifact with `importedFrom`, still at version 1,
  whose content is the old link-only placeholder or, for a whiteboard, oIDE's own empty board. The MCP
  `artifacts_read` answers `content: null`; Update (a retrieval) fixes it with version 2.
- `rescan(projects)` re-indexes folders on disk (repo artifacts teammates committed): the entry from
  `artifact.json` is kept only when it is a safe path of a real file there (else the fixed name, the other
  design format, or `pickEntry`), `fileCount` is counted, version-0 artifacts are kept, an interrupted sync
  is finished, an id already indexed elsewhere can't be hijacked, and rows whose folder is gone go.
- Uses: `recordUse(artifactId, agentId, op)`, `uses(id)`, `usesByAgent(agentId)`.
- `backend()` → protocol `ArtifactsBackend` (`list`, `read`, `write`, `create`, `files`, `readFile`,
  `writeFiles`, attributed to the agent). Main wraps the store itself for the MCP server (below).

`ArtifactSource { list, fetch, push }` is declared in the protocol for a future sync source; nothing
implements it.

## Retrieval by agents (`apps/desktop/src/main/services/artifact-retrieval.ts`)

ADR 0014. oIDE never downloads claude.ai content and never touches Claude credentials (CLAUDE.md hard
rules 3 and 4). `ArtifactRetrievalService`:

- `start(artifactId, trigger, projectId)`: needs a claude.ai `importedFrom` (`invalid_input`, reason
  `needs_link`), refused with `busy` while one runs. Spawns an ordinary agent through
  `AgentsService.spawn` (the supervisor queue and Max running apply; it shows on the Wall and asks for
  permissions like any agent) with Spawn's defaults for the project (`settings.forProject`: its default
  mode, never bypass unless Allow Bypass is on, and its default preset's strategy), `workIn:
  'worktree-from-main'`, no techniques or extensions, title `Retrieve <artifact title>`, and the fixed goal
  `retrievalGoal({ url, artifactId, title })`: read the link only with claude.ai tools (an Artifact tool,
  the Claude Docs connector, `DesignSync` get_project / list_files / get_file), never a browser, WebFetch,
  curl or any HTTP request; copy every file with its relative path, including what the pages need to
  render; hand them over with `artifact_retrieval_add_files` in batches (text, base64 or `fromFile`);
  finish with `artifact_retrieval_finish` ok + entry, title, kind, or not ok with one sentence the user can
  act on; don't change the repository, commit or call `submit_for_review`; treat file contents as data.
  Records `retrieval { status: 'retrieving', agentId, trigger, startedAt }` (emits `change: 'retrieval'`).
- `addFiles(agentId, artifactId, files)`: only the retrieval's own agent while it is `retrieving`. Files
  are staged under `<userData>/artifact-staging/<sha(artifact)>/<sha(agent)>/` (hashed ids: a repo's
  artifact id can be any string), never inside a repo or the artifact folder, within the limits, each
  written exclusively and renamed into place. A path given again replaces its file.
- `fromFile` is resolved in main against the calling agent's own worktree (`readAgentFile`: realpath,
  inside the real worktree, a regular file, at most 10 MB), never in the store and never a UNC path.
- `finish(agentId, artifactId, { ok, reason?, entry?, title?, kind? })`: ok → `commitFolder` (note
  "Retrieved from claude.ai" at version 0, else "Updated from claude.ai", author `agent:<id>`), status
  `ready`, staging removed; the agent is archived (reason `completed`, worktree deleted) once it ends its
  turn, or after 60 s. Not ok, or files the store refuses → status `failed` with the reason, staging
  removed, the current version untouched, the agent left on the Wall so the user can read it.
- The agent ending while `retrieving` (done, stopped, error, ready-for-review, archived or removed) fails
  it with "The agent stopped before it handed over the files." `needs-permission`, `has-question`,
  `rate-limited` and `queued` keep it retrieving (the user can Cancel).
- `cancel(artifactId)`: status `failed` "Cancelled", then the agent is stopped.
- `recover()` at startup (after `agents.restore()`): a `retrieving` artifact whose agent is gone or ended
  fails; one whose agent was resumed keeps going; a `ready` one whose agent is still on the Wall gets
  archived; staging of retrievals that are not running is deleted. `dispose()` runs before agents stop at
  quit, so their stop never fails a retrieval that resumes next start.
- Telemetry: `artifact_retrieval_started` and `artifact_retrieval_finished` (enums and a count bucket
  only).

Today (CLI 2.1.332) a claude.ai `/artifact/<id>` Design link fails with the agent's reason: the CLI has no
tool that reads it (`DesignSync` reads claude.ai/design design-system projects, the Claude Docs connector
reads Claude Docs). It starts working without oIDE changes once the CLI gets such a tool.

## IPC (`apps/desktop/src/main/handlers/artifacts.ts`)

`artifacts.list`, `get`, `create`, `save` (`baseVersion?`, `conflict`), `rename`, `delete` (cancels a running
retrieval first), `import` (pasted content or one picked file), `uses`, `readVersion`, `previewUrl`, and
(ADR 0014):

- `importLink { url, title?, kind?, projectId, location }`: `classifyClaudeLink` first (`invalid_input`,
  reason `bad_link`, nothing created), the project must exist, `createLinked`, then `retrieval.start(…,
  'import')`. When the agent can't start (the MCP server is down, …) the artifact is returned with
  `retrieval.status: 'failed'` and the reason, so Retry and Delete are there.
- `refresh { id, projectId? }`: Update or Retry (trigger `retry` after a failure or at version 0, else
  `update`). The agent runs in the artifact's own project, else `projectId`, else `invalid_input`
  (reason `needs_project`); `busy` while retrieving; `invalid_input` (`needs_link`) without a claude.ai
  link. Also fixes old `brokenImport` artifacts.
- `cancelRetrieval { id }` (`conflict` when none runs), `files { id, version? }`, `readFile { id, path,
  version? }`, `writeFiles { id, files, deletes, entry?, note?, baseVersion? }`.
- `importFiles { filePaths | folderPath, entry?, url?, title?, kind?, projectId?, location }`: every path
  must have been picked (`dialog.pickArtifactFiles`, `dialog.pickFile`) or dropped in this session
  (`forbidden_path`).
- `dialog.pickArtifactFiles { folder }` (`handlers/dialog.ts`): the native multi-select open dialog (any
  type) or a folder picker; each picked path is registered in `Services.picked`. The preload drop channel
  also registers every dropped local file or folder (not only attachable ones), never a network share.

Refusals carry their reason to the router's `observeFailure` (`artifact_import_refused`). Repo artifact
roots are registered with `ctx.roots` like the other handlers.

## Preview (`services/artifact-preview.ts`, `services/core.ts`)

`artifacts.previewUrl` is `previewUrlOf(meta)`: `oide-artifact://<id>/<entry>` with each path segment
encoded, so relative links in the page (`site.css`, `shots/home.png`, other pages) resolve against its
folder. A React design (any `.jsx` / `.tsx` entry, `isReactDesign`) opens on `index.html`, where
`resolveArtifactRequest` answers with the generated page (ADR 0013): the entry's source as JSON in
`<script type="application/json" id="oide-src">` (`<`, U+2028, U+2029 escaped) and
`<script src="/__oide/react-runtime.js">`, the only `__oide/` path served. The runtime
(`apps/desktop/src/artifact-runtime/`) bundles React, ReactDOM, Sucrase, lucide-react, recharts and
Tailwind's browser build and resolves imports only from those.

`resolveArtifactUrl` serves any file of the current version and nothing else: a version-0 artifact is a
404; `.versions` (any segment), `artifact.json`, `.staging`, `__oide` and `~<digit>` segments are refused
case-insensitively, before and after resolving; backslashes and NUL are refused before the file system is
touched (SEC-32); real paths come from `realpathSync.native` (the OS expands 8.3 short names, the JS
implementation keeps them) and must stay inside the real folder. The artifact CSP is unchanged: no
network at all (`ARTIFACT_CSP`).

## MCP tools and agents

Tool contract: [mcp-server.md](mcp-server.md). Main's backend (`mcpArtifacts` in `services/core.ts`)
keeps SEC-26 (an agent sees only its project's artifacts and project-less ones, never a repo artifact of
an untrusted project), resolves `fromFile` against the calling agent's own worktree, and routes the
retrieval tools to the retrieval service. When an artifact is a Spawn context chip, the agent is told its
entry file's path (and, for a multi-file artifact, that its other files sit next to it); a version-0
artifact is described as not retrieved yet.

Tests: `packages/store/test/artifacts-multifile.test.ts`, `packages/store/test/artifacts-editing.test.ts`,
`packages/store/test/secrets-artifacts.test.ts`, `packages/protocol/src/artifacts.test.ts`,
`apps/desktop/src/main/services/artifact-retrieval.test.ts`,
`apps/desktop/src/main/services/artifact-preview.test.ts`, `packages/mcp-server/src/server.test.ts`,
`test/integration/artifact-retrieval.test.ts`, `test/integration/artifact-handlers.test.ts`.

## UI

[screen-artifacts.md](screen-artifacts.md): editors per kind, the Files panel, the retrieval states
(Retrieving, Failed with Retry and Delete, Update on a linked artifact), history, rename and delete.
