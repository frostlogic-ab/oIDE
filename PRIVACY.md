# Privacy

oIDE runs on your computer. Your code, prompts, agent output and file paths stay there, between you
and the Claude Code CLI you run. oIDE never reads, stores or sends your Claude credentials.

## Opt-in usage analytics and crash reports

oIDE can send **anonymous usage analytics** and **crash and error reports** to help us make it better.
Both are **off until you agree**:

- On first launch oIDE asks once. "Share usage and crash reports" turns both on; "No thanks" keeps
  both off for good. If you close the question without choosing, it may ask on one more launch, then
  never again.
- Settings › Privacy has a switch for each. Turning one off stops sending at once; turning both off
  also deletes the random install id, so turning them on later starts a new one.
- `DO_NOT_TRACK=1` or `OIDE_TELEMETRY=0` in your environment turns everything off: no question, no
  network.

### What is sent

- Screens you open, as names such as `/wall` or `/settings/privacy`.
- Features you use, for example: an agent was started (model family such as `opus`, effort,
  permission mode, worktree or folder, number of parallel attempts), a permission was answered (allow
  or deny, and the kind of tool such as `Bash` or `mcp`), a search ran, a setting changed (which one,
  never its value), an agent was merged or archived.
- Counts and timings in coarse ranges: start-up time, how long agent runs take, numbers of agents,
  subagents and tokens.
- Performance: render and response times, memory in ranges.
- Crash and error reports: the kind of error, its message with paths, names, links, quoted text and
  tokens removed, and where it happened in oIDE's own code.
- Your setup: oIDE, Claude Code CLI and Electron versions, operating system and version, CPU
  architecture, language, screen size rounded to 100 px, and a random install id created when you agree.

The full list of events and the only values they may carry is in Settings › Privacy › See what's sent
and in [docs/wiki/pages/telemetry.md](docs/wiki/pages/telemetry.md).

### What is never sent

Your code, prompts or agent output; file names or paths; project, repository or branch names; agent
titles or goals; tool inputs; commit messages; artifacts; extension settings; environment values;
links you open; names of custom or local extensions; anything about your Claude account. oIDE does
not record sessions or the screen.

### Where it goes

Official builds send to an [Umami](https://umami.is) server at `data.frostlogic.se`, run by the
maintainers. oIDE's main process sends it directly; the app window loads no analytics script and has
no network access. As with any web request, the server sees your IP address; Umami keeps only the
country, region and city derived from it, and no cookies are used. Nothing is stored on your computer
for sending later: anything not sent when oIDE quits is dropped.

Forks and your own builds can point at their own Umami (`OIDE_UMAMI_HOST`, `OIDE_UMAMI_WEBSITE_ID`) or
build without telemetry (set either to an empty string).

## Local crash reports

Settings › Privacy › Save crash reports on this computer (off by default) keeps crash summaries on
your computer only, with paths, prompts and code removed, so you can attach one to a bug report. That
switch uploads nothing.

## Extensions and MCP servers

Extensions you install and MCP servers you add can reach the network on their own. Check their
declared capabilities before you install them.
