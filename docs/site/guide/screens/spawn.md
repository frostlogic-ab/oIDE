# Spawn

A dialog over the Wall that starts one or more agents. Open it with **Spawn agent**, from the
command bar, or from another screen (Artifacts > Give to an agent, Files > Ask an agent about this,
Review > Hand conflicts to a new agent), which pre-fills the context.

## Fields

| Field | What it does |
| --- | --- |
| Goal | What the agent should do. The tile's title starts as the goal's first sentence; once the agent starts, it gives the task a short name of its own, which replaces it. |
| Context | Chips for artifacts, files (relative to the project) and https URLs. |
| Project | Which open project. Defaults to the scoped project. |
| Work in | **New worktree from main** (default), **new worktree from the current branch**, or **the project folder directly**. |
| Mode | **Manual**, **Edit automatically**, **Plan**, **Auto** (default) and, only when Settings > Allow Bypass is on, **Bypass**. See [Agents and permissions](/guide/agents-and-permissions). |
| Models | Focus presets **Cheap**, **Balanced**, **Quality**, or **Custom**. |
| Advanced model settings | How models are picked (one model, a separate subagent model, or routed by the lead), model and effort per slot, and model versions (Latest or pinned). |
| Advanced techniques | Extra instructions such as Adversarial review or Quality gates must pass, plus techniques from extensions you turned on (off by default). Each shows where it goes: the first message or the system prompt. |
| Parallel attempts | 1 to 6 agents with the same goal, each in its own worktree, so you can compare. |
| Tools from extensions | Extension tools for this agent, labelled "read only" or "asks first". |

Press **Spawn** or Ctrl/Cmd+Enter. The new tiles are highlighted on the Wall.

## Focus presets

| Preset | Strategy |
| --- | --- |
| Cheap | Sonnet leads; subagents always use Haiku |
| Balanced | Opus leads and routes subagents by task size: simple to Haiku, standard to Sonnet, complex to Opus |
| Quality | Opus for everything, at maximum effort |

Presets are editable in Settings > Models. Changing any slot by hand switches the dialog to Custom.

## Rules

- Bypass is never allowed in the project folder, and is only offered when Settings > Allow Bypass is
  on.
- More than one attempt needs worktrees.
- Controls the installed CLI does not support (detected from `claude --help`) are hidden: unknown
  modes, effort, routed subagents, system-prompt techniques, extension tools.

Details: [screen-spawn](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/screen-spawn.md).
