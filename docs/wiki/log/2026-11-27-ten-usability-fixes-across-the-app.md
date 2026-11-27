## [2026-11-27] review | Ten usability fixes across the app

Ten small usability fixes; the pages below now describe them.

- Spawn: "Edit techniques in Settings" opens Settings › Techniques; closing the dialog or following its links asks "Discard this agent?" when there is a goal, extra context or attachments ([screen-spawn](../pages/screen-spawn.md)).
- Wall: the "Archived …" toast has an Undo action that unarchives the agent ([screen-wall](../pages/screen-wall.md)).
- Status bar: "Claude Code CLI not found" / untested is a button that opens Settings › Claude Code ([desktop-shell](../pages/desktop-shell.md)).
- Focus Inspector → Review opens on the clicked file via the optional `path` route param ([screen-focus](../pages/screen-focus.md), [screen-review](../pages/screen-review.md)).
- Source control Revert and Files Replace dialogs stay open until the operation finishes ([screen-source-control](../pages/screen-source-control.md), [screen-files](../pages/screen-files.md)).
- Source control: Push shows "Pushing…", success toasts "Pushed <branch>", Pull confirms with a toast ([screen-source-control](../pages/screen-source-control.md)).
- Terminals: closing a tab moves focus to the neighbouring tab or New terminal ([screen-files](../pages/screen-files.md)).
- Extensions settings: Clear on a secret asks for confirmation and toasts "Cleared <key>" ([extensions](../pages/extensions.md)).
- Settings › Techniques: Reset to default on an edited built-in asks first ([screen-settings](../pages/screen-settings.md)).
