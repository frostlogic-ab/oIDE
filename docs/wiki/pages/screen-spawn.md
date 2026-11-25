# Screen: Spawn an agent

A 720px dialog over the Wall (`overlay: true` in `screens/registry.tsx`). Design:
[raw/design/Spawn.dc.html](../raw/design/Spawn.dc.html). Code: `apps/desktop/src/renderer/src/screens/Spawn/`
(`index.tsx` UI, `spawnModel.ts` pure form model). It builds a protocol `AgentSpec` (see
[protocol](protocol.md)) that the [agent-supervisor](agent-supervisor.md) turns into flags, env,
`--agents` JSON and the first message. Returns to [screen-wall](screen-wall.md).

## Fields → AgentSpec

| Control | Spec field | Notes |
| --- | --- | --- |
| Goal (textarea) | `goal`, `title`, `autoTitle` | title = first sentence of the goal, max 80 chars (`titleFromGoal`), a stand-in: `autoTitle: true` asks the agent to name the task with `set_title` once it starts ([agent-supervisor](agent-supervisor.md#agent-named-titles)) |
| Attachments (paste into the goal, drop on it, or the "Attach file" pill) | `attachments[]` | images and files as chips in the Context row (thumbnail, name, size); sent with the first message (see [screen-focus](screen-focus.md#attachments)); kept in memory by the supervisor, not in the stored spec |
| Context chips + "Artifact, file or URL" | `context[]` | artifact (from `artifacts.list` for the project), file (relative path, no `..`), http(s) URL. Pre-filled from route `params.context` (Artifacts › Give to an agent, Files › Ask an agent) |
| Project | `projectId` | default: route `params.projectId`, else the scoped project, else the first |
| Work in | `workIn` | new worktree from main / from current branch / project folder |
| Mode cards | `mode` | default: the project's `.oide/config.json` `defaultMode` when trusted (`settings.forProject`), else Settings › Claude Code › default mode (Auto). A mode you picked is kept when you switch project. Bypass card only when Allow Bypass is on |
| Models: Cheap / Balanced / Quality / Custom | `strategy` | presets from `settings.models.presets` (built-in fallback); default: the project's `presetId` (`settings.forProject`), else Settings' default preset; hints from the canvas for built-ins |
| Advanced model settings | `strategy` | How agents pick models (one / separate subagent model / routed), a row per slot (model pills, effort), Model versions (Latest alias or a pinned version per family) |
| Advanced techniques | `techniques[]` (Settings order) | `settings.forProject({projectId})` (global + `.oide/techniques.json` + extensions; `settings.techniques` without a project); default on = `enabledByDefault`; placement badge (First message / System prompt) and the text when on |
| Parallel attempts 1–6 | `attempts`, `attemptGroup` | group id generated when > 1 |
| Tools from extensions | `extensions[]` | `extensions.installed` with tools; checked when enabled for the project; "asks first" / "read only" labels |

Spawn: button, or Ctrl/Cmd+Enter anywhere in the dialog (keymap `composer.send`, modal scope).
`buildSpec()` validates with `AgentSpec.safeParse` plus oIDE rules, then `agents.spawn`; returned
summaries go into the agents store at once, Settings `models.lastUsedStrategy` is saved, and the
router returns to the Wall (back if it came from there, else replace) with `highlightTiles(ids)`.

## Rules

- **Bypass**: offered only when Settings › Allow Bypass is on; never with the project folder. When
  Bypass is picked, "Project folder directly" is disabled in Work in; when the project folder is
  picked, the Bypass card is disabled. `buildSpec` refuses both cases anyway. The red warning shows
  while Bypass is selected.
- **Parallel attempts need worktrees**: more than one attempt in the project folder is refused.
- **Focus**: the preset whose strategy matches the slots (model family + effort of the fields the
  strategy uses) is selected; any change that breaks the match shows Custom. Picking a preset resets
  the slots. Custom models ("Your models") are offered on the lead slot only, sent as `customModel`.
- **Model versions**: a slot holds a family alias ("opus", Latest) or an exact id (pinned). Presets
  and pills start from Settings › Model versions (`applyVersions`); the CLI receives exactly that.

## Hidden when the CLI lacks it (`CliInfo.features`)

Unknown CLI (no features) shows everything. Otherwise: modes without `mode:<name>`; effort selects
without `effort` (levels filtered by `effort:<level>`); "Routed by orchestrator" (and presets using
it) without `agents`; system-prompt techniques disabled without `append-system-prompt`; the tools
section without `mcp-config`.

## Decisions

- The Advanced model settings panel starts open, as drawn; Advanced techniques starts closed.
- Version pinning is one "Model versions" row (one select per family in use) rather than a select
  per slot: per-slot selects did not fit the 720px dialog, and Settings pins per family too.
- Footer copy "Runs claude CLI in its own terminal" is kept from the canvas although agents use
  pipes, not a pty.
- Model rows are one grid (rows are subgrids): only the orchestrator offers custom models, so its
  pill group is wider; a shared pill column keeps the effort selects (32px / 12px) aligned, as drawn.

## Tests

`screens/Spawn/spawnModel.test.ts` (defaults, route pre-fill, routed spec with attempts and group,
Bypass refusals, required fields, custom model, preset matching, versions, summaries, CLI gating) and
`screens/Spawn/Spawn.test.tsx` (jsdom: context chips from params, 3 routed attempts → `agents.spawn` →
Wall with highlighted tiles, Ctrl+Enter, empty goal, Bypass vs project folder, Allow Bypass off,
Custom focus on slot change).
