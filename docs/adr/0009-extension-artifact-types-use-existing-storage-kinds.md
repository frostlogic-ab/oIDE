# ADR 0009: Extension artifact types reuse the three storage kinds

- Status: accepted
- Date: 2026-11-24
- Departs from: build brief, Extension system › Contribution points (v1): "`artifactTypes` | A viewer
  and editor for a new artifact kind | Panel iframe", and Artifacts integration ("New kinds … come in
  through the `artifactTypes` contribution point")

## Context
`ArtifactKind` (`design`, `doc`, `whiteboard`) decides more than the viewer: the entry file name
(`index.html`, `doc.md`, `board.excalidraw`), content validation, the default content, how
`artifacts.import` infers a kind, and the MCP `artifacts.*` tools agents call. Making the kind an
open string would touch the store, the MCP server and every screen that switches on it, and would let
an extension pick file names inside artifact folders.

## Decision
An extension artifact type is a **tag** on an artifact of one of the existing kinds:
`ArtifactMeta.type = "<extension name>:<type id>"` in `artifact.json` (package names cannot contain
`:`). The kind still decides storage (a text format such as a diagram source is normally a `doc`).
The store keeps the field through rescan and save. In Artifacts › Open, an artifact whose type
resolves to an extension that is on and declares it is shown by that extension's
`artifactTypes[].entry`, in the same sandboxed `oide-ext://` iframe as panels. The app sends it
`{ type: "oide:artifact", artifact }` and saves `{ type: "oide:artifact.save", content }` as a new
version of that artifact only; viewers never reach host code. Without the extension, the artifact
falls back to its kind's normal viewer, so nothing is lost when an extension is removed.

## Consequences
- Agents read and write typed artifacts with the existing tools; the content is plain text.
- v1 has no UI to *create* a typed artifact: an extension's MCP tool or host code writes
  `artifact.json` with `type`, or a user adds it. Adding `type` to `artifacts.create` needs a small
  change in `packages/store` (`ArtifactStore.create`).
- A type cannot add a fourth storage format (binary files, folders with their own entry). If one is
  needed, it is a new built-in kind with its own ADR.
