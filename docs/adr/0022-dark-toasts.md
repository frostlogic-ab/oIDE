# ADR 0022: Toasts are dark cards in the app palette

- Status: accepted
- Date: 2026-11-28
- Departs from: the Mission Control canvas (`docs/wiki/raw/design/Main.dc.html`), which draws the
  toast as a light `#E6E8EB` pill with dark text and a grey-outlined Dismiss

## Context
The light pill was the only light surface in a dark UI. On screen it read as a foreign element (a
system dialog rather than part of oIDE), its status border-left strips clashed with the pill, and its
buttons did not match the kit's `Button` variants.

## Decision
- A toast is a dark raised card: `bg-raised`, 1px border, radius 10, `shadow-toast`, `text-ink`
  12.5px, 280–480px wide. It rises and fades in over 160 ms (`motion-safe:animate-toast-in`).
- The level shows as a 16px stroke icon in its status colour plus a matching border, the same pairs
  the status cards use: info `info` / accent / `line-3`, success `check` / `ok` / `ok-line`, warning
  `warning` / `warn` / `warn-line`, error `alert-circle` / `bad` / `bad-line`. Warnings and errors
  label their icon ("Warning", "Error") so the level is not told by colour alone.
- Buttons come from the kit (`buttonClass`): the action is `primary` (`warn` on warnings, `secondary`
  on errors), the second answer `secondary`. Dismiss is a ghost close icon button, still labelled
  `Dismiss: <message>`. The ×N repeat count is a small mono chip.
- Placement, timing, dedupe and live-region behaviour are unchanged. Tooltips keep the light bubble
  (`--color-toast`).

## Consequences
Toasts look like the rest of the frame (menus, cards, dialogs) and follow the accent the user picks.
