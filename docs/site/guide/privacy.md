# Privacy and telemetry

Your code, prompts, agent output and file paths stay on your computer. oIDE can send **anonymous
usage analytics** and **crash and error reports**, and only if you agree.

## Your choice

- **First launch**: oIDE asks once. "Share usage and crash reports" turns both on, "No thanks" keeps
  them off for good. Close the question without choosing and it may ask on one more launch, then never.
- **Settings › Privacy**: "Share anonymous usage analytics" and "Send crash and error reports". Off
  stops sending at once; both off also deletes the random install id. "See what's sent" lists every
  event oIDE can send.
- **Environment**: `DO_NOT_TRACK=1` or `OIDE_TELEMETRY=0` turns everything off.

## What is sent

Screens you open (as names like `/wall`), features you use (for example an agent was started with
model family `opus` in a worktree, a permission was allowed for a `Bash` tool, a search ran, a
setting changed, never its value), counts and timings in ranges, performance numbers, versions of
oIDE, the CLI and Electron, your OS, language, OS region (country) and screen size range, and a
random install id.

Crash and error reports hold the kind of error, its message with paths, names, links, quoted text and
tokens removed, and locations in oIDE's own code only.

## What is never sent

Code, prompts, agent output, file names or paths, project, repository or branch names, agent titles
or goals, tool inputs, commit messages, artifacts, extension settings, environment values, links you
open, custom or local extension names, and anything about your Claude account. There is no session
or screen recording.

## How it is sent

oIDE's main process sends to the maintainers' [Umami](https://umami.is) server through a network
session that can reach that one host. The app window loads no analytics script and has no network
access. The server sees your IP address, as with any request. Usage statistics send a fixed
placeholder address instead, so Umami stores no location for them, only the country from your
operating system's region settings; for crash and error reports Umami keeps the country, region and
city. Nothing is saved on your computer to send later.

Building oIDE yourself? `OIDE_UMAMI_HOST` and `OIDE_UMAMI_WEBSITE_ID` point it at your own Umami;
an empty value builds it without telemetry.

Local crash reports (Settings › Privacy › Save crash reports on this computer) are separate: they stay
on your computer.
