## [2026-11-28] decision | Toasts are dark cards in the app palette

The light `#E6E8EB` toast pill from the canvas stood out as the only light surface in the dark UI.
Toasts are now dark raised cards with a per-level status icon and tinted border, kit buttons and a
close icon button ([ADR 0022](../../adr/0022-dark-toasts.md)). Placement, timing and live-region
behaviour are unchanged. Pages touched: [desktop-shell](../pages/desktop-shell.md),
[design-system](../pages/design-system.md). No telemetry change (visual only).
