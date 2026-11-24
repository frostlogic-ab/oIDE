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
| `model.ts` | Pure helpers: `buildItems` (index + installed + custom → one `ListItem`), `filterItems` (category, search, sort), `riskFromHints`, `monogram`/`tintFor`, `qualifiedToolName`, `splitCommandLine`, `parsePastedJson`, `enabledIn` |
| `*.test.ts(x)` | `model.test.ts` (pure helpers), `AddCustomDialog.test.tsx` (URL probe flow, risk label editing, header token never rendered) |

## Layout (as designed)

- **Categories aside** (220px, `panel`): BROWSE = `MARKETPLACE_CATEGORIES` ("MCP" hint on Agent tools);
  YOURS = Installed / Custom / Updates with counts; dashed "+ Add custom"; the "Extensions are open
  source…" note at the bottom. Categories are buttons with `aria-current="page"`.
- **List** (`main`): 36px search, Sort select (Most installed = `downloads`, Recently updated =
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
  `#F2C078`; custom servers get a per-tool on/off), "Enabled for" (All projects + one checkbox per open
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
keymap scope blocks screen shortcuts.

| Route | Flow |
| --- | --- |
| From a URL | Connect / Check again → `custom.probeUrl`. "What oIDE found": "Reached **name** · transport · server vX" (or the error), auth row (`needsAuth`: "Sign in in your browser" saves a draft with `custom.save` then `custom.authorize({ id })`; "Use a token instead" reveals header + password token; otherwise "No sign-in needed"), "N tools found · M turned on". Tool rows with risk from annotations (`readOnlyHint` → read only; `destructiveHint` or no hint → asks first), clickable to flip; on/off per tool. Name, Save it in, Turn on for. Add tool → `custom.save` (auth `oauth` / `header` / `none`), then `custom.setHeaderToken` when a token was entered. Cancel after a draft save → `custom.remove`. |
| Found on this computer · N | `custom.scanImports` runs when the dialog opens (gives the tab count). Rows: checkbox, name, mono display, source, note ("already added" disabled, "remote" for http). Save it in + Turn on for. Import N → `custom.importSelected`, then a review step with each imported server's tools (risk + on/off), saved with `custom.save` on Done. |
| Local command or JSON | Fill in (Name, Command split with a quote-aware splitter, env rows with password values, "+ Add variable") or Paste JSON (standard `mcpServers`, parsed client-side with a green "Recognised N servers…" or a red error and `aria-invalid`). Test it → `custom.probeCommand` per server → tool rows. Add tool → `custom.save` per server (stdio transport, `envKeys`, `secrets` = env values); env values are then cleared. |
| Extension from folder or git | Choose a folder… → `extensions.addFromFolder({ devMode })`; git URL + Fetch → `extensions.addFromGit({ url })`; "Developer mode: reload when its files change" (default on). Shows the manifest's tools (risk read-only: "Risk labels come from the extension's manifest"), capabilities and "not reviewed". Install extension → `extensions.setEnabled` (global when every project is ticked, else per project). Cancel → `extensions.uninstall`. |

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
- Added: consent dialogs, update box, Declared capabilities, "All projects" checkbox, remove confirm,
  "Use a token instead", the Found review step, and an Edit mode (the design shows only the buttons).
- Found tab note shows "remote" for http entries instead of "needs sign-in": the scan cannot know
  whether a remote server needs sign-in until it is probed.
- The drop zone only opens the folder picker on drop: a sandboxed renderer cannot read a dropped
  file's path without a preload helper.
- Monograms are computed (first letters), so the sample "Postgres inspector" shows "Pi", not "Pg".

## Gaps

- **Per-tool on/off for marketplace extensions**: `InstalledExtension.disabledTools` exists but no IPC
  sets it, so the detail shows the tools without checkboxes for extensions (custom servers have them).
  Needs e.g. `extensions.setToolEnabled({ id, tool, enabled })`.
- `custom.save` from the detail and Edit sends `secrets: {}`; main must keep existing secrets when the
  map is empty.
- No "Check for updates" refresh button (the index refreshes daily in main; `extensions.index({ refresh })` exists).
- Mock data for this screen lives in `lib/mock/library.ts` (invented sample entries from the canvas).
