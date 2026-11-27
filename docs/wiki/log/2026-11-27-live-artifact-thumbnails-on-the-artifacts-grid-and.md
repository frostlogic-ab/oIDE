## [2026-11-27] build | Live artifact thumbnails on the Artifacts grid and the Wall aside

The Artifacts grid cards and the Wall's Artifacts aside drew only the canvas's stylised grey blocks,
so a user saw no preview of their artifacts there. Both now use `ArtifactThumbnail`
(`apps/desktop/src/renderer/src/screens/Artifacts/Thumbnail.tsx`): the design in the sandboxed
`oide-artifact://` frame scaled down (no scrollbar), the rendered doc, or the whiteboard SVG; lazy
via IntersectionObserver; the stylised blocks stay as the placeholder. Pages:
[screen-artifacts](../pages/screen-artifacts.md), [screen-wall](../pages/screen-wall.md). No
telemetry change: thumbnails answer no product question that the existing artifact events miss.
