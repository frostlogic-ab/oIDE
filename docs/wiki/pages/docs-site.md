# Docs site and home page

The public site at `getoide.com` (GitHub Pages custom domain, `docs/site/public/CNAME`): a marketing home page plus the user guide, the
extension author guide, the security model and the FAQ. VitePress 2 in `docs/site/`, built and
deployed by `.github/workflows/docs.yml` ([packaging](packaging.md)). Commands: `pnpm docs:dev`,
`pnpm docs:build`, `pnpm docs:preview`.
Source design: the "oIDE Website" artifact, copied to [raw/design/website/](../raw/design/website/)
(Main, Features and More are the home page top to bottom; Phone is Main at 390 px).

## How it is put together

| File | Role |
| --- | --- |
| `docs/site/index.md` | Only frontmatter: `layout: landing`, title and description. The copy lives in `Landing.vue`. |
| `.vitepress/theme/index.ts` | Extends the default theme, swaps in `Layout.vue`, imports the self-hosted fonts and `custom.css`. |
| `.vitepress/theme/Layout.vue` | `layout: landing` gets `Landing.vue`; every other page gets `DefaultTheme.Layout`, with the brand lockup in its `nav-bar-title-after` slot (`siteTitle: false` in `config.ts`). |
| `.vitepress/theme/FrostlogicLogo.vue` | The Frostlogic wordmark for the site, the same paths as `@oide/ui`'s `FrostlogicLogo` (roof `#2491EB`, word in `currentColor`). |
| `.vitepress/theme/Landing.vue` | The home page from the design: nav, hero with the four numbered claims pinned on the wall screenshot, Direct, Review, Extend, How it works, Compare, Download, Open source, FAQ, close, footer. |
| `.vitepress/theme/site.css` | The design's `site.css`, loaded as `<style scoped>` by `Landing.vue` so its generic class names (`.link`, `.btn`, `.wrap`) cannot reach VitePress's own components. |
| `.vitepress/theme/custom.css` | Global: VitePress variables restyled to the design's tokens for doc pages, Archivo headings, the home page's light tokens and the `on-dark` / `on-light` switch. |
| `docs/site/public/shots/` | The design's screenshots (wall, tiles, spawn, focus, source control, review, marketplace, add custom, artifacts, models, status bar). |

## Decisions

- **Logo.** The app's own mark (`public/logo-mark.svg`, `logo-mark-light.svg`, from
  [design-system](design-system.md) and `tools/brand/`) replaces the design's outlined square in the nav and footer. Both headers (home page nav and docs nav) use
  the app header lockup: the 28px mark beside "oIDE", linking to the site root (https://getoide.com/);
  the footer keeps mark + "oIDE".
- **Light and dark** follow VitePress's `<html class="dark">` (set by an inline script before
  hydration, default dark, toggled by the sun/moon button or the docs' switch). The home page never
  derives a class from `isDark`, and theme-dependent bits (logo, toggle icon) are drawn twice and
  hidden with CSS, so the server render and the client always match.
- **Fonts are self-hosted** (`@fontsource-variable/archivo` with the width axis,
  `@fontsource-variable/jetbrains-mono`; Inter ships with VitePress). The site loads nothing from
  third-party hosts, in line with the [telemetry](telemetry.md) stance; the site has no analytics.
- **Links**: `repo` in `Landing.vue` and `.vitepress/config.ts` is `https://github.com/frostlogic-ab/oIDE`;
  every repository, issue, discussion and download link is built from it. Base path `/oIDE/`.
  Releases there are published by the [release pipeline](release-pipeline.md).
- **Downloads** link straight to the newest installer file:
  `releases/latest/download/oIDE-<os>-<x64|arm64>.<ext>`. Release file names carry the version, so
  the [release pipeline](release-pipeline.md) also uploads a version-free copy of each installer for
  these links. The visitor's system is detected after mount (none on phones and tablets); the main
  Download buttons fetch that system's installer (Apple silicon .dmg, x64 .exe, x64 AppImage, or
  the arm64/x64 build when Chromium's `userAgentData` reports the architecture) and fall back to the
  `#download` cards when the system is unknown. Each card's button and links (arch, `.zip`, `.deb`,
  `.rpm`) are direct file links too; only "All downloads on GitHub Releases" opens the release page.
- **No package managers.** The design shows `brew install --cask oide` and `winget install oide`;
  neither exists, so each card shows the command to check the download against the release's
  `SHA256SUMS` instead. Add the package-manager commands back once a cask or winget manifest ships.
- **macOS builds** are per architecture (arm64, x64), not universal, so the menu says
  "Apple silicon · Intel". Requirements on the cards: macOS 12+, Windows 10/11, Ubuntu 22.04 /
  Fedora 39+ (Electron 45).
- **Additions to the design:** skip link, theme toggle (hidden under 420 px), Escape and
  outside-click close the download menus, "More in the full FAQ" link, the FAQ answer on running
  many agents names Settings › Agents › Max running. The nav download label drops "for <OS>"
  under 600 px so the bar fits a 360 px phone.

## Changing it

Edit copy in `Landing.vue` (lists such as the compare table, FAQ and download cards are arrays in
its script). Keep claims in step with the user guide and [constraints](constraints.md): no
"Claude" in the product name, and say plainly that oIDE is not made by Anthropic. Check both themes
and a 390 px viewport with `pnpm docs:build && pnpm docs:preview`.
