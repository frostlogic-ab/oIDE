## [2026-11-28] review | Usability pass: ten fixes across the renderer

An audit of the renderer (Wall, Focus, Spawn, Review, Files, Source control, Usage, Artifacts,
Settings, Marketplace) for small user-facing defects; ten were fixed:

1. Disabled buttons never showed their `title` (`pointer-events: none` in `@oide/ui` `Button`); they
   now keep pointer events, and Focus Stop / Pause say why they are disabled.
2. Closing a terminal tab with a running script or install asks first (an idle shell does not).
3. Review: Esc closes the comment box and keeps the draft; only Cancel discards.
4. Artifacts: Ctrl/Cmd+S saves the open file, as the Save button does, not the entry.
5. Artifacts: a failed library load shows the error and Try again, not "No artifacts yet".
6. Usage: a failed range switch says so, keeps the old range dimmed, and offers Try again.
7. Settings › Techniques and Permissions: a failed load shows the error and Try again instead of
   "Loading…" forever; "1 technique"; the All projects empty state names the right place.
8. New project: an autofocused field keeps focus (the `Dialog` no longer moves it to ×), and the
   disabled Clone / Create say why.
9. Spawn: Cancel and Esc wait for a spawn in flight; presets the CLI cannot run say why.
10. Marketplace › Add custom: Enter no longer starts a second probe or git fetch.

Plus tooltips on cut-off branch names, errors, agent titles and paths. Rules recorded in
[design-system](../pages/design-system.md) (Accessibility); Esc behaviour in
[screen-review](../pages/screen-review.md). No telemetry change: these fix existing flows and answer
no new product question.
