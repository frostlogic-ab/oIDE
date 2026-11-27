## [2026-11-27] build | Scroll long subagent lists on Wall tiles

An agent that had run a dozen or more subagents grew a tall stack of chips, which stretched its tile and,
through the shared grid row, every tile beside it. The chip list on a Wall tile is now capped at about
three and a half rows and scrolls past that ([screen-wall](../pages/screen-wall.md)). Because the CSS
tooltip bubble would be clipped by the scroll box, `Tooltip` gained a `portal` mode that renders the bubble
fixed in `document.body`; `ModelLetterChip` uses it ([design-system](../pages/design-system.md)).
No telemetry: a layout cap answers no product question.
