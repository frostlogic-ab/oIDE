## [2026-11-27] build | Header logos drop by Frostlogic; app logo opens getoide.com

Removed the "by Frostlogic" subtitle from the app header (`Header.tsx`) and both website headers
(`Layout.vue`, `Landing.vue`); deleted the now-unused `FrostlogicLogo.vue` and its CSS. The app header
logo is now a button that opens https://getoide.com in the system browser through `shell.openExternal`;
`getoide.com` joined the external-URL allow-list. Site header logos already link to the site root.
Pages updated: [design-system](../pages/design-system.md), [docs-site](../pages/docs-site.md).
