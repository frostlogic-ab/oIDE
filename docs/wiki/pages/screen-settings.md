# Settings screen

`apps/desktop/src/renderer/src/screens/Settings/`. Design: [../raw/design/Settings.dc.html](../raw/design/Settings.dc.html).
Data: the settings service on [storage.md](storage.md), the IPC contract on [protocol.md](protocol.md),
the frame on [desktop-shell.md](desktop-shell.md).

## Layout

A 230px section list (`aside`, "Search settings" input, section buttons with `aria-current="page"`,
the `.oide/` footer note) and a scrolling main column (padding 22px 32px, content max 760px) built from
the design's `.row` / `.rl` / `.rt` / `.rd` / `.sec` / `.inp` styles (`ui.tsx`: `Row`, `Rd`, `Sec`,
`inp`). The section is the route param: `navigate('settings', { section: 'models' })`; clicking a
section calls `replace('settings', { section })`. Ids: `cli`, `models`, `agents`, `tech`, `perms`,
`projects`, `artifacts`, `ext`, `keys`, `look`, `privacy`, `updates`, `diag`. Search filters the list by section label plus
the words of its rows (`SECTIONS[].keywords`); Enter opens the first match.

`settings.loadErrors` (bad JSON or schema errors in the settings document or a project's `.oide/*.json`)
shows as an amber banner at the top of every section, and per project under Projects.

## Sections and data

| Section | Controls | IPC |
| --- | --- | --- |
| Claude Code | status card (found and signed in / not signed in / not found / untested version), `path · version`, tested range from `TESTED_CLI_RANGE`, Check again; Plan row ("Signed in" or Sign in); CLI path; Open Models settings; Default mode (Bypass only listed when allowed); Allow Bypass (warning when on; turning it off moves a Bypass default back to Auto); Extra CLI flags | `cli.detect` (store), `cli.openSignIn`, `settings.update` |
| Models | Default focus (presets + "Custom (last used)" = `custom`), preset pill tabs with "edited", strategy cards (One model / Separate subagent model / Routed by orchestrator), model pills + effort per slot, summary, Reset to default; Model versions per family ("uses …" via `resolveModel`); Your models cards (provider, status, "Key stored", env preview), Test connection, Edit, Remove, Add model form | `settings.update` (`models.presets` sent whole, arrays replace; `models.versions.<family>`; `models.defaultPresetId`), `settings.builtIns`, `settings.saveCustomModel`, `settings.testCustomModel`, `settings.deleteCustomModel` |
| Agents | Max running (1–32), worktree location, cleanup, fetch interval (0–1440 min, 0 = off), amber and /compact thresholds in %, notifications | `settings.update` |
| Techniques | Save techniques for (All projects = global list; a project = its `.oide/techniques.json`), expandable cards (Built in / Yours, edited, on/off), name, description, text, placement, On by default switch, Reset to default (built-ins), Delete (own), Add technique, "What a new agent receives" preview | `settings.techniques`, `settings.saveTechnique` (debounced 400 ms, flushed on blur and unmount), `settings.deleteTechnique`, `settings.builtIns` |
| Permissions | Defaults (edit files, shell, network); Rules for (project), Always allowed / Always denied lists with Remove and Add rule | `settings.update` (`permissions.defaults`), `settings.projectPermissions`, `settings.saveProjectPermissions` |
| Projects | open projects with path, Trusted checkbox, their `.oide/` errors | `projects.trust`, `settings.loadErrors` |
| Artifacts & claude.ai | where artifacts live, import is a copy (not synced), Open in claude.ai | none (link to the Artifacts screen) |
| Extensions | Marketplace index URL (empty = bundled index only, nothing fetched; an https URL needs a native confirmation in main, declining restores the saved value), then each installed extension's `contributes.settings` fields | `settings.update({ marketplace: { indexUrl } })`, `extensions.settings`, `extensions.setSetting` |
| Keyboard shortcuts | every action with its keys; Change records the next combo (Esc cancels; plain Tab is not recorded and moves on to Save / Cancel, where Esc still cancels, Shift+Tab stays recordable because `agent.cycleMode` uses it; a visible hint "Press the new keys · Tab to move on · Esc to cancel"; after Save, Cancel or Esc focus returns to that action's Change button), a combo another action uses shows a warning and Save takes it from there; Reset per action and Reset all (`KeysSection.tsx`) | `settings.update { keybindings: { <action>: [combo] \| null } }` |
| Appearance | accent radiogroup (four `ACCENT_OPTIONS` swatches, arrow keys); Sidebar widths: how many sidebars have a custom width and Reset sidebar widths (see [design-system](design-system.md)) | `settings.update({ ui: { accent } })`; the settings store applies it. Reset: `settings.update({ ui: { panelWidths: null } })` |
| Privacy | Share anonymous usage analytics and Send crash and error reports (opt-in, off by default, disabled with the reason when telemetry is unavailable; changing one also answers the first-run question), See what's sent (the catalogue, in the app); Save crash reports on this computer (local only, off deletes them). See [telemetry](telemetry.md). `ui.telemetry` stays deprecated and unread | `settings.update({ privacy: { usageAnalytics \| errorReports, consentAnswered: true } })`, `telemetry.status`, `settings.update({ ui: { crashReports } })` |
| Updates (M7) | Current version and state line (a downloaded update "installs when you close oIDE" while that is on), Channel (Stable / Beta), Check automatically, Download automatically and Install when oIDE closes (both on by default, [ADR 0018](../../adr/0018-updates-download-and-install-on-quit-by-default.md)), Check now with "Last checked …", an available-update card (notes, Download, progress bar, Restart to update with an inline confirm that running agents stop), Open release page when the build cannot install itself, the disabled reason otherwise | `updates.status`, `updates.check`, `updates.download`, `updates.install({ consent: true, from: 'settings' })`, `updates.changed` event, `settings.update({ updates: { channel / checkAutomatically / downloadAutomatically / installOnQuit } })` |
| Diagnostics | Checks (CLI, git ≥ 2.38, gh, node, keychain, database, MCP port, logs), Copy report, Check again; Folders waiting to be removed (only when there are some: worktrees a program held open, with tries, last holders, Show holders, Retry now); Open logs folder | `app.diagnostics`, `app.pendingCleanups`, `app.retryCleanup`, `app.cleanupHolders`, `app.openLogsFolder` ([reliability](reliability.md#windows)) |

## Save and validation rules

- Every control saves on change with the smallest deep-merge patch through `useSettings.update`
  (e.g. `{ agents: { maxRunning: 5 } }`); text fields (CLI path, extra flags) save on blur or Enter.
  An empty CLI path sends `{ claude: { cliPath: null } }` (null resets to the default). Errors from
  main (`invalid_input`) become error toasts; the store keeps main's answer as the truth.
- Number fields keep the typed text locally, show the reason next to the row title (`role="alert"`,
  `aria-invalid`, `aria-describedby`) and save only valid values: max running 1–32, fetch 0–1440,
  amber 1–99 and below the /compact level, /compact 2–100 and above amber.
- Custom model form: name, model id and (for Local / Compatible API) an http(s) base URL are required;
  errors show after the first Add. The API key is in component state only until Add: it is cleared
  before the IPC call resolves, the form closes, and the card afterwards shows only "Key stored" and
  `ANTHROPIC_AUTH_TOKEN=•••• from keychain`. Editing leaves the key field empty ("leave empty to keep
  it"); a key is sent only when typed.

## Deviations from the design

- "Check for update" is "Check again" (re-runs CLI detection): oIDE has no command that updates the CLI.
- The Plan row shows "Signed in": the CLI does not report the plan name (build brief, guess).
- Worktree location is a select (App data folder / Next to the repo), not a free path: the settings
  schema stores `app-data | sibling`.
- Added rows the design lacks but the schema has: fetch interval (Agents), "Always denied" and Add rule
  (Permissions), a project picker for rules, and a Region field instead of Base URL for Bedrock and
  Vertex models.
- The undesigned sections (Projects, Artifacts & claude.ai, Keyboard shortcuts, Appearance) and an
  extra Privacy section use the same row style; the design shows them as "Not designed yet".
- Default section is Claude Code (the canvas preview opened on Models).
- CLI path and Extra CLI flags are Inter 12px, 282px wide: the canvas's `.inp` overrides its `mono`
  class. 12px fields use `inpSm` (`cn(inp, 'text-[12px]')` cannot shrink the text: `cn` does not
  merge classes and Tailwind emits 13px later).
- Techniques open with the first technique expanded, as drawn.
- Models: the slot rows share a grid so the effort selects (32px / 12px) line up, as in Spawn.

## Confirmations
Removing a custom model, deleting a technique and resetting all shortcuts each open a danger `Dialog`
first, saying what is lost: the model's keychain key, the presets that point at it, and resuming the
sessions that used it. The supervisor refuses to launch or resume an agent whose `customModel` no
longer exists (it never falls back to the Claude plan with the custom model's name), so those presets
fail with a clear error until another model is picked. For a technique it names where the text lives
(global, or the project's `.oide/techniques.json`); for shortcuts, how many custom bindings go back.

## Gaps

- Custom models are offered only in the lead slot (stored as `custom:<id>`; `agents.spawn` maps it to
  `AgentSpec.customModel`). Subagent slots list the model families only: the CLI cannot route
  subagents to another endpoint.
- "Custom (last used)" depends on Spawn writing `models.lastUsedStrategy`.
- `settings.builtIns`, `settings.loadErrors` and `projects.trust` need main handlers; without them the
  screen hides "edited"/Reset and the banner.

## Tests

`KeysSection.test.tsx`: records and saves a rebind, resets it, warns on a conflict and takes the combo from the
other action, Esc cancels, Tab is not recorded (Shift+Tab is), Esc on Save still cancels, focus returns to Change after Save / Cancel / Esc, follows `settings.changed`, moves old browser-storage rebinds into Settings once.

`Settings.test.tsx` (jsdom): Allow Bypass sends `{ claude: { allowBypass: false } }`; max running sends
`{ agents: { maxRunning: 5 } }` and refuses 99 with `aria-invalid`; adding a custom model sends the key
to `settings.saveCustomModel`, then "Key stored" shows and the key is nowhere in the DOM; an empty form
does not save.

`UpdatesSection.test.tsx` (jsdom): channel saves `{ updates: { channel: 'beta' } }`; Check now → Download →
progress → Restart to update only calls `updates.install({ consent: true, from: 'settings' })` after the inline confirm;
Download automatically and Install when oIDE closes start checked and save `downloadAutomatically` / `installOnQuit`;
unsigned builds show Open release page instead of Download; disabled builds explain why; errors use `role=alert`.
