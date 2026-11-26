# Screen: Extension marketplace

Renderer screen `apps/desktop/src/renderer/src/screens/Marketplace/`, built from
[../raw/design/Marketplace.dc.html](../raw/design/Marketplace.dc.html). Backend concepts (index, install
flow, Add custom services, loopback proxy) are on [marketplace.md](marketplace.md) and
[extensions.md](extensions.md); the frame is on [desktop-shell.md](desktop-shell.md).

## Files

| File | What |
| --- | --- |
| `index.tsx` | Screen: categories aside, list, detail aside, consent dialog (install / update), remove confirm |
| `AddCustomDialog.tsx` | The Add custom dialog (four routes plus an Edit mode for an existing custom server); `Capabilities` block |
| `parts.tsx` | `CheckButton` (the design's 18px checkbox), `RiskPill`, `ToolRows` (editable tool list), `Monogram`, `SaveFields` (Name / Save it in / Turn on for), `ModalShell` (accessible 720px dialog) |
| `model.ts` | Pure helpers: `buildItems` (index + installed + custom → one `ListItem`), `filterItems` (category or `'all'`, search, sort), `matchesQuery`, `matchesElsewhere` (matches a category-scoped search hides), `riskFromHints`, `monogram`/`tintFor`, `qualifiedToolName`, `splitCommandLine`, `parsePastedJson`, `enabledIn` |
| `*.test.ts(x)` | `model.test.ts` (pure helpers), `AddCustomDialog.test.tsx` (URL probe flow, risk label editing, header token never rendered, scrim press closes only a pristine form and never one that started inside the dialog, env row removal, the drop box opens nothing and says so), `Marketplace.test.tsx` (search falls back to matches in other categories) |

## Layout (as designed)

- **Categories aside** (220px, `panel`): BROWSE = `MARKETPLACE_CATEGORIES` ("MCP" hint on Agent tools);
  YOURS = Installed / Custom / Updates with counts; dashed "+ Add custom"; the "Extensions are open
  source…" note at the bottom. Categories are buttons with `aria-current="page"`.
- **List** (`main`): 36px search (scoped to the category; when it finds nothing there but matches
  elsewhere, the list shows those with a status line "No matches in <category>. Showing N matches
  from other categories.", and "Nothing matches your search" only when no category matches), Sort select (Most installed = `downloads`, Recently updated =
  `MarketplaceEntry.updatedAt`, Name), accent "+ Add custom"; `h1` = category; one row per item: 40px
  monogram tile (tint picked from `#9DBBFA #7FC8A9 #E6E8EB #F2C078 #C4A7E7` by a hash of the name),
  name · publisher, violet "Custom" pill for custom servers and folder/git extensions, description,
  state text (Install link-blue, Installed green, Built in grey, "Update to x" link-blue). The selected
  row has an accent border; selection lives in the route (`replace('marketplace', { extension: key })`,
  key `e:<npm name>`, `x:<installed id>`, `c:<custom id>`; a plain npm name also works).
- **Detail** (320-380px, `panel`): 52px monogram, name, author line ("publisher · open source",
  "publisher · built in", "Added by you · custom", folder/git), "not reviewed" badge when not reviewed,
  description, update box ("Update to x"), main button (Install / Uninstall / Remove / disabled
  "Built in"), "Tools it gives agents" (mono rows, risk text "read only" `#7FC8A9` / "asks first"
  `#F2C078`; custom servers and installed extensions get a per-tool on/off; extensions save it with `extensions.setToolEnabled({ id, tool, server, enabled })`, which fills `disabledTools`), "Enabled for" (All projects + one checkbox per open
  project), "Declared capabilities", the custom box (source line, explanation, Edit, Publish to
  marketplace), and "Tools marked "asks first" always show a permission prompt on the agent's tile."

## Data flow

| Action | IPC |
| --- | --- |
| Load | `extensions.index`, `extensions.installed`, `custom.list`, `extensions.updates` (each falls back to `[]` while main has no handler); `extensions.changed` refreshes installed + updates |
| Install | consent dialog (every tool with its risk, capabilities, "not verified" warning) → `extensions.install({ name })` |
| Update | `needsConsent` → consent dialog listing `addedTools` / `addedCapabilities` → `extensions.update({ id, consent: true })`; otherwise update directly |
| Uninstall / Remove | confirm → `extensions.uninstall({ id })` / `custom.remove({ id })` |
| Enable per project | `extensions.setEnabled({ id, projectId?, enabled })` (no `projectId` = All projects); custom servers: `custom.save` with `projects` / `allProjects` |
| Per-tool on/off, risk (custom) | `custom.save` with edited `tools` (detail checkboxes, or Edit) |
| Publish to marketplace | `shell.openExternal('https://github.com/oide-dev/oide-marketplace')` |

## Add custom

720px dialog 56px from the top: title, description, close; underline tabs; body; footer with the
"not reviewed" badge, "Custom tools aren't reviewed by the marketplace. Only add ones you trust.",
Cancel and the primary button. `ModalShell` gives `role="dialog"`, `aria-modal`, labelled/described
by the header, focus moves in and is trapped, Esc closes, focus returns to the opener, and a modal
keymap scope blocks screen shortcuts. A press on the scrim closes the dialog only while nothing has
been entered (`ModalShell` `dismissOnScrim`, false once the form is dirty: any typed field, probe
result, env row, pick, loaded extension, sign-in draft or changed placement), and only when the press
starts on the scrim itself, so a text selection dragged out of the dialog never closes it. Esc,
× and Cancel always close.

| Route | Flow |
| --- | --- |
| From a URL | Connect / Check again → `custom.probeUrl`. "What oIDE found": "Reached **name** · transport · server vX" (or the error), auth row (`needsAuth`: "Sign in in your browser" saves a draft with `custom.save` then `custom.authorize({ id })`; "Use a token instead" reveals header + password token; otherwise "No sign-in needed"), "N tools found · M turned on". Tool rows with risk from annotations (`readOnlyHint` → read only; `destructiveHint` or no hint → asks first), clickable to flip; on/off per tool. Name, Save it in, Turn on for. Add tool → `custom.save` (auth `oauth` / `header` / `none`), then `custom.setHeaderToken` when a token was entered. Cancel after a draft save → `custom.remove`. |
| Found on this computer · N | `custom.scanImports` runs when the dialog opens (gives the tab count). Rows: checkbox, name, mono display, source, note ("already added" disabled, "remote" for http). Save it in + Turn on for. Import N → `custom.importSelected`, then a review step with each imported server's tools (risk + on/off), saved with `custom.save` on Done. |
| Local command or JSON | Fill in (Name, Command split with a quote-aware splitter, env rows with password values, a trash button per row ("Remove variable KEY", or "Remove variable N" while unnamed; removing the last row leaves one empty row; focus moves to the remove button of the row that took its place, or the new last row), "+ Add variable") or Paste JSON (standard `mcpServers`, parsed client-side with a green "Recognised N servers…" or a red error and `aria-invalid`). Test it → `custom.probeCommand` per server → tool rows. Add tool → `custom.save` per server (stdio transport, `envKeys`, `secrets` = env values); env values are then cleared. |
| Extension from folder or git | "Choose an extension folder" box with Choose a folder… → `extensions.addFromFolder({ devMode })`; git URL + Fetch → `extensions.addFromGit({ url })`; "Developer mode: reload when its files change" (default on). Shows the manifest's tools (risk read-only: "Risk labels come from the extension's manifest"), capabilities and "not reviewed". Install extension → `extensions.setEnabled` (global when every project is ticked, else per project). Cancel → `extensions.uninstall`. |

Placement for every route: "My settings (all my projects)" sets `allProjects` when every open
project is ticked; "Project .mcp.json (shared through git)" saves `projects` = ticked ones.

## Security

- Secrets (env values, header tokens) are sent to main once (`custom.save` secrets,
  `custom.setHeaderToken`) and cleared from component state; inputs are `type="password"`; a test
  checks a saved token is not in the DOM. Imported servers never send secrets over IPC (main re-reads
  the files).
- Custom servers and folder/git extensions carry the "not reviewed" badge in the detail and in every
  Add custom route; unverified marketplace entries get a warning in the install consent.
- Capabilities are shown for consent only (open question 12).

## Deviations from the design

- Detail tool rows show the risk as coloured text (as drawn); install consent and Add custom use pills.
- Detail tool rows of installed extensions and custom tools add an on/off checkbox (the canvas draws
  none). Extensions save it through the screen's `setToolEnabled` → `extensions.setToolEnabled`
  (fills `disabledTools`; the row updates from the returned record); custom tools through
  `custom.save`. Covered by `Marketplace.test.tsx`.
- The Add custom footer is the canvas's single line; the "not reviewed" badge is shown on the detail
  and in the review step, not in the footer. The URL field is Inter, as drawn.
- Added: consent dialogs, update box, Declared capabilities, "All projects" checkbox, remove confirm,
  "Use a token instead", the Found review step, and an Edit mode (the design shows only the buttons).
- Found tab note shows "remote" for http entries instead of "needs sign-in": the scan cannot know
  whether a remote server needs sign-in until it is probed.
- No drop zone: a sandboxed renderer cannot read a dropped folder's path, and main accepts
  `extensions.addFromFolder({ path })` only for a path picked in the native dialog. The box reads
  "Choose an extension folder"; dragging something over it refuses the drop (`dropEffect = 'none'`,
  so no copy cursor) and an always-mounted `role="status"` line says "Dropping a folder here is not
  supported yet. Use Choose a folder instead."; nothing opens. Making drops work needs a preload
  helper that registers the dropped folder as picked (as the attachment drop bridge does).
- Monograms are computed (first letters), so the sample "Postgres inspector" shows "Pi", not "Pg".

## Gaps

- `custom.save` from the detail and Edit sends `secrets: {}`; main keeps the stored values (only passed keys are overwritten).
- No "Check for updates" refresh button (the index refreshes daily in main; `extensions.index({ refresh })` exists).
- Mock data for this screen lives in `lib/mock/library.ts` (invented sample entries from the canvas).
