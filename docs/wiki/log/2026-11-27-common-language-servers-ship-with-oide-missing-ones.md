## [2026-11-27] decision | Common language servers ship with oIDE; missing ones are offered in a toast

[ADR 0020](../../adr/0020-bundle-common-language-servers.md). TypeScript/JavaScript, CSS, HTML, JSON
and YAML servers now ship in `resources/language-servers` (`packages/language-servers`, staged by
`stage.mjs`, checked by `smoke.mjs`) and run with the user's Node.js when not installed. A missing
server raises a toast (Install / No, No remembered per language); Install opens a Files terminal
that runs the manifest's install command through the new `lsp.install` (SEC-05) and main starts the
server once it is on PATH. The status menu's Copy install command became Install. New telemetry
event `language_server_install`. Pages: [screen-files](../pages/screen-files.md),
[packaging](../pages/packaging.md), [extensions](../pages/extensions.md),
[telemetry](../pages/telemetry.md).
