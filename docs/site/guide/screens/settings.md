# Settings

Sections on the left (with **Search settings**), one section on the right. Every control saves as
soon as you change it. Settings are stored per install; some can be overridden per project in the
project's `.oide/` folder, so a team can share them through git.

If a settings file cannot be read (bad JSON, unknown values), an amber banner at the top says which
one; the broken part falls back to defaults.

## Claude Code

The CLI status card (found and signed in, not signed in, not found, or a version outside the tested
range), **Check again**, **Sign in** (opens a terminal running `claude`), **CLI path**, **Default
mode** for new agents, **Allow Bypass permissions** (off by default; turning it off moves a Bypass
default back to Auto), and **Extra CLI flags** passed to every agent.

## Models

- **Default focus**: the preset Spawn starts with, or "Custom (last used)".
- **Presets**: edit Cheap, Balanced and Quality (strategy, model and effort per slot), or reset them.
- **Model versions**: per family (Haiku, Sonnet, Opus, Fable), **Latest** (the CLI's alias follows
  new releases) or a pinned version.
- **Your models**: third-party endpoints (a compatible API, a local server, Bedrock, Vertex) with
  **Test connection**. API keys go to the OS keychain and are never shown again. Custom models can
  be used for the lead agent only.

## Agents

**Max running** (1 to 32, default 3; the rest wait in a queue), **worktree location** (oIDE's app
data folder or next to the repo), **clean up worktrees** (after 7 days, right away, or never),
**context warning** and **/compact suggestion** levels, **notifications** (needs permission, ready
for review, error) and how often to **fetch remotes** (0 turns it off).

## Techniques

Reusable instructions added to new agents, for all projects or for one project (saved in its
`.oide/techniques.json`). Each has a name, text, placement (**first message** or **system prompt**)
and whether it is on by default. Built in: Adversarial review (on), Full docs and tests (off),
Quality gates must pass (on). "What a new agent receives" previews the result.

## Permissions

**Defaults** for editing files (allow or ask), shell commands (ask or allow) and network (ask, allow
or block). **Rules for** a project: always allowed and always denied rules, saved in the project's
`.oide/permissions.json`. See [Agents and permissions](/guide/agents-and-permissions).

## Projects

Open projects with their path and a **Trusted** checkbox, plus problems in their `.oide/` files.

## Updates

| Control | What it does |
| --- | --- |
| Channel | **Stable** (default) or **Beta**. Beta also receives stable releases. |
| Check automatically | On by default: looks 15 seconds after startup and every 6 hours. |
| Check now | Looks for a newer release on GitHub Releases. |
| Current version | The version you are running. |
| Last check | When oIDE last looked. |

oIDE looks for updates on its own, but it only **downloads** an update when you click to download,
and it only **installs** it when you click **Restart to update** and confirm (running agents stop and
resume after the restart). It never installs without your consent. Moving from Beta back to Stable
keeps your version until a newer stable release ships; oIDE never downgrades.
Updates are off in development builds and portable zips. Releases are published as drafts first, so
an update reaches you only after a maintainer publishes the release.

How each kind of build updates:

| Build | Updates |
| --- | --- |
| Windows (NSIS installer) | Downloads and installs in place. Unsigned builds work, but SmartScreen may warn when the new version first runs. |
| macOS | Signed builds install in place. Unsigned builds cannot install updates themselves (macOS requires a signed app), so oIDE shows the new version with a link to its release page; download it and replace the app. |
| Linux AppImage | Updates in place. |
| Linux .deb / .rpm | Update through your package manager; oIDE does not replace package-managed files. |

## Artifacts & claude.ai

Where artifacts live, and a reminder that imports from claude.ai are copies, not synced.

## Extensions

The settings that extensions you turned on contribute (for example Browser preview's default URL).
Secret fields are password inputs: the value goes to the OS keychain and is never shown again.

## Keyboard shortcuts

Every shortcut with its key. **Change** records the next key combination (Esc cancels); a combination
another action already uses shows a warning, and saving takes it from that action. **Reset** goes
back to the built-in keys.

## Appearance

The accent colour: blue `#7AA2F7` (default), green, violet or amber, plus any themes from extensions
you turned on.

## Privacy

**Share anonymous usage statistics** and **Crash reports**, both off by default. oIDE does not
collect usage statistics yet, so the first switch only records your choice. Crash reports stay
on your computer with paths, prompts and code removed; nothing is uploaded, and you can copy one into
a bug report yourself. oIDE never reads, stores or sends your Claude credentials; prompts, code and
paths stay on your computer.

## Diagnostics

What oIDE found at startup: the CLI and whether its version is in the tested range, git (2.38+), `gh`,
Node, the OS keychain, the database, the MCP port and the logs. **Copy report** copies a redacted
report that is safe to paste into a bug report; **Open logs folder** opens oIDE's log folder.

Details: [screen-settings](https://github.com/oide-dev/oide/blob/main/docs/wiki/pages/screen-settings.md).
