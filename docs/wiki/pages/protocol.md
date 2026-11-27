# Protocol (`packages/protocol`)

The shared contract: Zod schemas (and their inferred types) that main, preload, renderer, agent-core,
the MCP server and extensions all import. Nothing else may redefine these shapes (CLAUDE.md,
Conventions). Rule: changes are **additive** (new optional or defaulted fields, new variants), never
renames or removals, so parallel work and stored data keep parsing. Source:
[../raw/build-brief.md](../raw/build-brief.md); related [architecture.md](architecture.md),
[storage.md](storage.md), [git-worktrees.md](git-worktrees.md), [artifacts.md](artifacts.md).

`src/index.ts` re-exports every module. Schemas are values (`AgentSpec.parse(x)`); types share the
name (`type AgentSpec = z.infer<typeof AgentSpec>`). Use `z.input<typeof X>` where defaults should
stay optional (for example `AgentSpecInput`).

## Modules

| File | Main exports |
| --- | --- |
| `agent.ts` | `Id`, `PermissionMode` (+ `PERMISSION_MODE_LABELS`), `Effort`, `WorkIn`, `ModelSlot`, `ModelStrategy` (`single` / `subagent-model` / `routed`), `ContextChip`, `AgentSpec` (everything Spawn collects), `AgentStatus` (+ `NEEDS_YOU`), `SubagentTier/Status/Info`, `TokenUsage`, `PermissionRequest/Answer`, `CheckResult`, `ReviewSubmission`, `TodoItem`, `DiffStat`, `AgentSummary` (the tile state; also persisted per agent; `mergeConflict` while resolving conflicts oIDE sent), `UserMessage` (incl. `merge-conflicts`, built in main only: `agents.send` refuses it; delivered as a `user-text` with `origin: 'oide'`) |
| `events.ts` | `AgentEvent`: discriminated union on `type` with `agentId`, monotonic `seq`, `ts`, optional `parentToolUseId`. Variants include init, user/assistant text, thinking, partial (never stored), tool-use/result, usage, result, status, permission request/resolved, todos, subagent, review-submitted, rate-limit, plan-usage, mode-changed, compact, subagent-task, background-tasks, stderr, exit, error, unknown. `AgentEventDraft` = event without `seq/ts/agentId` |
| `project.ts` | `Project`, `SyncState`, `WorktreeInfo`, `CommitInfo`, `OverlapWarning`, `MergePrediction` (`git.predictMerge`; `git.askToResolve` sends the conflicts to the agent), `FileDiff`, `ReviewComment`, `FileNode` |
| `settings.ts` | `Technique`, `FocusPreset`, `CustomModel`, `Settings` (claude, models, agents, techniques, permissions, ui), `.oide/` files `ProjectConfig` / `ProjectPermissions` / `ProjectTechniques` / `ProjectExtensions` (each with `version: 1`), `CliInfo`, `TESTED_CLI_RANGE`, `contextWindowFor()`, `MODEL_FAMILIES`, `KNOWN_MODEL_VERSIONS`, `resolveModel()` |
| `artifacts.ts` | `ArtifactKind`, `ArtifactMeta` (`artifact.json`), `ArtifactVersion`, `ArtifactUse`; interfaces `ArtifactContent`, `ArtifactsBackend` (what the MCP server calls), `ArtifactSource` (future sync) |
| `extensions.ts` | `ExtensionManifest` (package.json `oide` field), `MarketplaceEntry/Index`, `MARKETPLACE_CATEGORIES`, `ExtensionUpdate`, `InstalledExtension`, `CustomTool`, `CustomServer`, `ToolRisk` |
| `ipc.ts` | `Commands` (renderer → main request/response pairs, input validated in main), `Events` (main → renderer streams), `Scope`, `OideBridge` (`window.oide.invoke/on`), channel names, `IpcResult` |

## JSON Schemas

`packages/protocol/schemas/oide-{config,permissions,techniques,extensions}.schema.json` describe the
`.oide/*.json` files for editors. Generated from the Zod schemas (input side) by
`pnpm --filter @oide/store gen:schemas`; a store test fails when they are stale.

## Additions log

Fields added after the first cut (all optional or defaulted):

- Git/store build (2026-11-24): `CommitInfo.body`; `FocusPreset.builtIn`; `Settings.models.versions`
  (family → `latest` or version) and `models.lastUsedStrategy` ("Custom (last used)"); `spawn.lastExtensions` (Spawn's last "Tools from extensions" picks);
  `Settings.permissions.defaults` (`editFiles` allow/ask, `shell` ask/allow, `network`
  ask/allow/block, from Settings > Permissions > Defaults); `MODEL_FAMILIES`,
  `KNOWN_MODEL_VERSIONS`, `resolveModel()`; `ArtifactContent`, `ArtifactsBackend`, `ArtifactSource`.
- Agent-core and extension work (same day, by those builds): `PermissionRequest.toolUseId`,
  `AgentSummary.planText/backgroundTasks/planUsage`, result `contextWindow/localCommand/apiErrorStatus`,
  event variants `mode-changed`, `compact`, `subagent-task`, `background-tasks`, `plan-usage`,
  `error.code`; `MarketplaceEntry.source`, `MARKETPLACE_CATEGORIES`, `ExtensionUpdate`,
  `InstalledExtension.disabledProjects/disabledTools`, extension/custom IPC commands
  (`extensions.updates/update/addFromGit`, `custom.importSelected/setHeaderToken`) and the
  `extensions.hostState` event. See those packages' pages for meaning.
- M7 release engineering (2026-11-24): `Settings.updates` (`channel` stable/beta, `checkAutomatically`;
  defaulted as a whole so older settings parse), `updates.ts` (`UpdateChannel`, `UpdateState`, `UpdateStatus`),
  IPC `updates.status/check/download/install` (install needs `{ consent: true }`) and the `updates.changed`
  event. See [packaging](packaging.md). 2026-11-27: `Settings.updates.downloadAutomatically` and
  `installOnQuit` (default true), `UpdateInstallTrigger`, `updates.install` takes an optional
  `from: 'header' | 'settings'` ([ADR 0018](../../adr/0018-updates-download-and-install-on-quit-by-default.md)).
- Conformance UX fixes (2026-11-24): `Settings.keybindings` (action → combos, default `{}`);
  `ReviewComment.side` and `review.addComment { side }` (`old` | `new`, default `new`), `side` on
  `review-feedback` comments; `permission-resolved.reason` (`quit`); `AgentSummary.interruptedPermission`;
  `notify.kind` / `notify.requestId`. The `init.slashCommands` field is now filled by the parser.
- Integration (2026-11-25): IPC `settings.forProject { projectId } → { defaultMode, presetId, techniques }`, the
  project's effective Spawn defaults (`.oide/config.json` under trust, as launches use them).
- Artifact agents (2026-11-27, [ADR 0017](../../adr/0017-artifact-agents.md)): `AgentSpec.artifactId`, `WorkIn`
  `artifact-folder`, `AgentSummary.artifactId` and `.effort`, event `model-changed { model, effort? }`, IPC
  `agents.setModel { agentId, model, effort? }` and `artifacts.startAgent { id, projectId?, text, attachments?, mode?,
  model? } → AgentSummary`, `PreviewPicked` / `PreviewPickerMessage` (the preview picker's postMessage protocol),
  telemetry `artifact_agent_started`, `artifact_agent_message`, `agent_model_changed`.
