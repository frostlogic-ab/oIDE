## [2026-11-27] build | Files editor minimap

The Files editor now shows a VS Code style minimap on the right: the whole file in miniature with
the slider always visible over the lines in view; click to jump, drag the slider to scroll. It is
Monaco's own minimap, turned on only for the Files editor (`FILE_MINIMAP` in `monaco/setup.ts`) and
themed from the design tokens; diffs and artifact source editors keep it off. Covered by an e2e test
in `files-search.spec.ts` that drags the slider. No telemetry event: it is always on, so there is no
choice to measure. See [screen-files](../pages/screen-files.md).
