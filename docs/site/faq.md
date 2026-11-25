# FAQ

## Is oIDE made by Anthropic?

No. oIDE is an independent open-source project (MIT). It is **not affiliated with, endorsed by or
supported by Anthropic**. "Claude" and "Claude Code" are trademarks of Anthropic. That is also why the
product is called oIDE and its logo has no "Claude" in it.

## Does oIDE include Claude Code?

No. You install the Claude Code CLI yourself and sign in to it yourself. oIDE finds your `claude`
binary (on your `PATH`, or the path you set in Settings > Claude Code) and starts it, unmodified, for
each agent.

## Anthropic's terms: is this allowed on my Pro or Max plan?

What oIDE does, and does not do, so that it stays within the rules for using a subscription through
another product:

- It drives **your own, unmodified** `claude` CLI. It never bundles, patches or re-implements Claude
  Code; it talks to the CLI through its own streaming JSON mode.
- Sign-in happens **only** through Anthropic's own flow, in a terminal running `claude`.
- It **never reads, stores, logs or forwards** your Claude credentials (no code touches the CLI's
  credential file or keychain item; a test enforces it).
- It makes **no direct calls** to Anthropic's API on your plan. Every model call goes through the CLI.
- It **respects plan limits**: at most 3 agents run at once by default, the rest queue, and rate-limit
  errors are shown with their reset time and never retried in a loop.

Whether Anthropic is comfortable with an open-source app driving many subscription sessions at once
is an **open question** that the maintainers are asking Anthropic before a public 1.0. Until there is
an answer, oIDE is pre-1.0. Your account is your responsibility: read Anthropic's current terms and
usage policies, and keep Max running at a level your plan supports. The planned fallback, if the
answer requires one, is a mode that uses your own API key.

## Does oIDE send my code or prompts anywhere?

No. Prompts, code and paths stay on your computer, between you and the CLI you run. oIDE can send
anonymous usage analytics and crash reports, but only if you agree: the first launch asks, both are off
until you say yes, and Settings › Privacy turns them off again at any time. They never contain your
code, prompts, file names or paths, project or branch names, or anything about your Claude account. See
[Privacy and telemetry](guide/privacy.md). Local crash reports (also opt-in) stay on your computer. Extensions you install and MCP servers you add can reach the network: check their
declared capabilities.

## Why does each agent get its own worktree?

So agents can work in parallel without overwriting each other or your own uncommitted work. Each one
works on its own `oide/<slug>` branch; you review and merge when it is done. See
[Worktrees and review](/guide/worktrees-and-review).

## Can I use other models or providers?

Settings > Models > Your models adds third-party endpoints (a compatible API, a local server,
Bedrock, Vertex) for the lead agent. They are passed to the CLI as environment variables; keys are
kept in your OS keychain. Subagents use the Claude model families only. oIDE supports only the
Claude Code CLI as the agent runtime.

## How many agents can I run?

As many as you like in the queue; **Max running** (Settings > Agents, default 3) caps how many run at
once. Subagents add to your usage; Focus > Subagents shows their share of tokens.

## Why is the installer unsigned? Is it safe?

The project does not have code-signing accounts yet. Download only from the project's
[GitHub Releases](https://github.com/oide-dev/oide/releases), which are built in CI from tagged
commits. See [Getting started](/guide/getting-started#unsigned-builds) for the OS warnings and how to
open the app, and [Settings > Updates](/guide/screens/settings#updates) for how unsigned builds update.

## Does oIDE update itself?

Packaged builds look for updates on GitHub Releases (Stable or Beta channel). oIDE downloads an update
only when you click, and installs it only when you choose to restart. Unsigned macOS builds cannot
install updates themselves and link to the release page instead; Linux .deb and .rpm installs update
through your package manager.

## Where is my data?

| What | Where |
| --- | --- |
| Projects, agents, events, settings | `oide.db` in oIDE's app data folder: `%APPDATA%\oIDE` (Windows), `~/Library/Application Support/oIDE` (macOS), `~/.config/oIDE` (Linux) |
| Agent worktrees | `<app-data>/worktrees/` by default |
| Team settings | Each project's `.oide/` folder |
| Secrets for third-party services | Your OS keychain |

Events older than 30 days are compacted to summaries.

## Can a repository I clone run commands through oIDE?

Not until you trust it. Untrusted projects cannot run their setup command, pre-approve tools, start
project MCP servers or turn on extensions. See [Security model](/guide/security-model#workspace-trust).

## Can I sync artifacts with claude.ai?

Not today: there is no public API for claude.ai artifacts, and oIDE never uses your claude.ai
sign-in, so it can't download them. You can import a copy: paste the link together with the
artifact's code, or pick a file you downloaded. See [Artifacts](/guide/screens/artifacts).

## How do I report a security problem?

Privately, through GitHub's "Report a vulnerability" on the repository. See the
[security policy](https://github.com/oide-dev/oide/blob/main/SECURITY.md).
