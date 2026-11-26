# Files

Browse and edit files in main or in any agent's worktree.

## Tree

One tree per project in scope. Each project header has a checkout picker: **main** or any agent
worktree. Files an agent is changing carry a coloured dot per agent (green running, amber waiting
on you, blue ready for review), and their folders open on first load. Full keyboard navigation
(arrows, Home/End, Enter).

## Editor

Monaco, loaded when you open a file. Tabs show a dot when unsaved; Ctrl/Cmd+S saves. Files over 5 MB
open read only, and binary files show a notice. Syntax colouring only: there are no language servers
yet.

Select code and use **Ask an agent about this** to open Spawn with that file and line range as
context, or **Send to &lt;agent&gt;** when an agent is editing that file.

## When an agent is changing the file

A banner says so: "&lt;agent&gt; is changing this file in its worktree. You're viewing main, so your
edits won't clash." **See agent's version** switches to the agent's checkout; **Open agent** opens it
in Focus.

## File activity

On the right: agents editing the file now, its commit history (yours and agents'), and artifacts that
mention it.

Details: [screen-files](https://github.com/frostlogic-ab/oIDE/blob/main/docs/wiki/pages/screen-files.md).
