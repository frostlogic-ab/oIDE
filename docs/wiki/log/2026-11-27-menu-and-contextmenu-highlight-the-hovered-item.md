## [2026-11-27] build | Menu and ContextMenu highlight the hovered item

Items in the right-click menu (Files tree) and in dropdown menus did not highlight under the pointer.
Each item's classes held `bg-transparent` all the time and added `bg-selected` when it was active.
`cn` is plain `clsx` with no tailwind-merge, so both classes applied and `bg-transparent` won because
Tailwind emits it later in the stylesheet. Items now get one or the other. A regression test in
`Menu.test.tsx` covers both components. Touched [design-system](../pages/design-system.md).

Lesson: with `cn` = `clsx`, never put a base utility and a conditional override for the same property
side by side; pick one in a ternary.
