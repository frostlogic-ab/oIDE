# Artifacts

Local artifacts that oIDE stores, previews and hands to agents. v1 has no claude.ai sync (no public
API). Source: [../raw/build-brief.md](../raw/build-brief.md), "Artifacts integration"; decision
[ADR 0004](../../adr/0004-artifact-versions-as-numbered-snapshots.md). Related:
[storage.md](storage.md), [protocol.md](protocol.md); the MCP server and Artifacts screen pages once written.

## Store (`packages/store/src/artifacts.ts`)

### Layout on disk

```
<repo>/.oide/artifacts/<slug>/     location "repo": shared with the team through git
<app-data>/artifacts/<slug>/       location "app-data": personal
  artifact.json                    ArtifactMeta (id, slug, title, kind, projectId, location, version, entry, importedFrom?, times)
  index.html | doc.md | board.excalidraw      entry file by kind
  .versions/versions.json          ArtifactVersion[] (version, ts, author, note)
  .versions/<n>/<entry>            snapshot of version n
```

| Kind | Entry | New content |
| --- | --- | --- |
| design | `index.html` | minimal HTML5 page with the title |
| doc | `doc.md` | Markdown with front matter (`title`, `kind`, `importedFrom`) added when missing |
| whiteboard | `board.excalidraw` | empty Excalidraw scene; saves must be a JSON object |

Slugs come from the title and are unique per location root. The folder is the source of truth;
SQLite (`artifacts`, `artifact_uses`) is an index plus the uses log. Versions are numbered snapshots
for both locations (ADR 0004); oIDE never commits artifacts.

### API

`new ArtifactStore({ db, appDataDir, projectPath: (projectId) => string | undefined, now?, onChange? })`

- `create({ title, kind, projectId?, location='app-data', content? }, author='user')` → `ArtifactMeta` (version 1).
- `list({ projectId?, kind? })`, `read(id, agentId?)` → `{ meta, content }`, `get(id)` → `{ meta, content, uses, versions }` (the `artifacts.get` IPC shape).
- `save(id, content, { author, note })` → next version; per-artifact lock so concurrent writes get distinct versions.
- `versions(id)` (newest first), `readVersion(id, n)`, `rename(id, title)`, `delete(id)`, `dirOf(id)` (for preview and path checks), `root(location, projectId?)`.
- `importUrl({ url, title?, kind='doc', projectId?, location? })`: only `https://claude.ai` (and `claude.site`) links; stores a link-only stub with `importedFrom`, since the content cannot be fetched. "Open in claude.ai" uses `importedFrom`.
- `importFile({ filePath, title?, kind?, ... })`: `.html/.htm` → design, `.md/.markdown/.txt` → doc, `.excalidraw` or Excalidraw `.json` → whiteboard; 10 MB limit.
- `rescan(projects)` re-indexes folders found on disk (repo artifacts teammates committed), assigns
  repo artifacts to the scanning project and drops index rows whose folder is gone. Run at startup.
- Uses: `recordUse(artifactId, agentId, op)`, `uses(id)`, `usesByAgent(agentId)` ("Agents using it",
  and a tile's "1 doc artifact").
- `backend()` → protocol `ArtifactsBackend` for the MCP server: `list(filter, agentId?)`,
  `read(id, agentId?)` (logs `read`), `write(id, content, agentId)` (new version, author
  `agent:<id>`, logs `write`), `create(input, agentId)` (app-data, logs `create`). `list` is not
  logged because it is not about one artifact.

`ArtifactSource { list, fetch, push }` is declared in the protocol for a future sync source; nothing
implements it in v1.

## MCP tools and UI

(To be written by the MCP server and Artifacts screen work: tool names, preview protocol, Give to an agent.)
