## [2026-11-27] build | Mouse back / forward buttons navigate screen history

The mouse's back and forward side buttons now go to the previous / next screen, like Alt+Left /
Alt+Right. `Keymap.attach` listens for `mouseup` (capture phase) and `Keymap.handleMouseButton`
maps buttons 3 / 4 to `nav.back` / `nav.forward` and runs them through the normal scope stack, so
screen scopes and modal dialogs behave as they do for the keyboard shortcut. The matching
`mousedown` / `auxclick` are swallowed so nothing underneath also reacts. No telemetry event: the
router history has no event today and the button is a second way into an existing action.
Pages: [desktop-shell](../pages/desktop-shell.md).
