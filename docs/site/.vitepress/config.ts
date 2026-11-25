// VitePress config for the oIDE docs site (https://oide-dev.github.io/oide/).
// Build: pnpm docs:build   Dev: pnpm docs:dev   Deployed by .github/workflows/docs.yml.
import { defineConfig } from 'vitepress';

const repo = 'https://github.com/oide-dev/oide';

export default defineConfig({
  title: 'oIDE',
  description: 'Mission Control for coding agents: run many Claude Code CLI agents in parallel, across many projects, in one window.',
  lang: 'en-US',
  base: '/oide/',
  cleanUrls: true,
  lastUpdated: true,
  appearance: 'dark',
  head: [
    // Brand assets: docs/brand (copied to docs/site/public by tools/brand/build-brand.mjs).
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/oide/favicon.svg' }],
    ['meta', { name: 'theme-color', content: '#0E1013' }],
    ['meta', { property: 'og:image', content: 'https://oide-dev.github.io/oide/social-preview.png' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { property: 'og:title', content: 'oIDE' }],
    ['meta', { property: 'og:description', content: 'Run many Claude Code CLI agents in parallel, in one window. Open source, MIT.' }],
  ],
  themeConfig: {
    siteTitle: 'oIDE',
    logo: { light: '/logo-mark-light.svg', dark: '/logo-mark.svg', alt: '' },
    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Extensions', link: '/extensions/', activeMatch: '/extensions/' },
      { text: 'FAQ', link: '/faq' },
      { text: 'Contributing', link: '/contributing' },
      {
        text: 'Links',
        items: [
          { text: 'Releases', link: `${repo}/releases` },
          { text: 'Wiki (internals)', link: `${repo}/blob/main/docs/wiki/index.md` },
          { text: 'Marketplace index', link: 'https://github.com/oide-dev/oide-marketplace' },
          { text: 'Security policy', link: `${repo}/blob/main/SECURITY.md` },
        ],
      },
    ],
    sidebar: {
      '/guide/': [
        {
          text: 'Start',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Using oIDE', link: '/guide/using-oide' },
          ],
        },
        {
          text: 'Screens',
          collapsed: false,
          items: [
            { text: 'Wall', link: '/guide/screens/wall' },
            { text: 'Focus', link: '/guide/screens/focus' },
            { text: 'Spawn', link: '/guide/screens/spawn' },
            { text: 'Source control', link: '/guide/screens/source-control' },
            { text: 'Review', link: '/guide/screens/review' },
            { text: 'Files', link: '/guide/screens/files' },
            { text: 'Artifacts', link: '/guide/screens/artifacts' },
            { text: 'Marketplace', link: '/guide/screens/marketplace' },
            { text: 'Settings', link: '/guide/screens/settings' },
          ],
        },
        {
          text: 'Concepts',
          items: [
            { text: 'Agents and permissions', link: '/guide/agents-and-permissions' },
            { text: 'Worktrees and review', link: '/guide/worktrees-and-review' },
            { text: 'Security model', link: '/guide/security-model' },
          ],
        },
      ],
      '/extensions/': [
        {
          text: 'Extension author guide',
          items: [
            { text: 'Overview', link: '/extensions/' },
            { text: 'Your first extension', link: '/extensions/first-extension' },
            { text: 'Manifest reference', link: '/extensions/manifest' },
            { text: 'Host API', link: '/extensions/api' },
            { text: 'MCP tools and risk labels', link: '/extensions/tools-and-risk' },
            { text: 'Commands, panels and settings', link: '/extensions/contributions' },
            { text: 'Capabilities and consent', link: '/extensions/capabilities' },
            { text: 'Developing and testing', link: '/extensions/developing' },
            { text: 'Packaging and publishing', link: '/extensions/publishing' },
          ],
        },
      ],
    },
    socialLinks: [{ icon: 'github', link: repo }],
    search: { provider: 'local' },
    editLink: {
      pattern: `${repo}/edit/main/docs/site/:path`,
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'MIT licensed. oIDE is not affiliated with or endorsed by Anthropic.',
      copyright: 'Copyright (c) oIDE contributors',
    },
    outline: { level: [2, 3] },
  },
});
