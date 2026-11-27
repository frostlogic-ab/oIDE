## [2026-11-27] build | Website headers show oIDE by Frostlogic

The getoide.com headers now match the app header: the oIDE mark beside "oIDE" with a "by
[Frostlogic wordmark]" subtitle underneath, on the home page nav (`Landing.vue`) and on every docs
page (`Layout.vue` fills VitePress's `nav-bar-title-after` slot; `siteTitle: false`). The wordmark is
a new `FrostlogicLogo.vue` with the same paths as `@oide/ui`'s `FrostlogicLogo`, so the word follows
the site's dark and light themes. The footer is unchanged. See [docs-site](../pages/docs-site.md).
