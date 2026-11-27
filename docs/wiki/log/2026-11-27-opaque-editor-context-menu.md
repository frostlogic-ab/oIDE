## [2026-11-27] build | Opaque editor context menu

The Monaco context menu in Files, Review and Artifacts rendered see-through: with
`fixedOverflowWidgets` it lives in a shadow root on the editor host, outside `.monaco-editor`, where
the theme's `--vscode-*` colour variables are not defined. Every editor host is now a
`.monaco-component`, `oide-dark` sets `menu.*` colours from the tokens, and `monaco/monaco.css`
defines the radius, border and shadow variables. See [Files](../pages/screen-files.md).
