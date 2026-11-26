// oIDE docs theme: the default VitePress theme with oIDE's colours and type
// (docs/wiki/pages/design-system.md), plus the home page from the "oIDE Website" design (Landing.vue).
import type { Theme } from 'vitepress';
import DefaultTheme from 'vitepress/theme';
// Self-hosted fonts: the site loads nothing from third-party hosts. Inter ships with VitePress.
import '@fontsource-variable/archivo/wdth.css';
import '@fontsource-variable/jetbrains-mono';
import Layout from './Layout.vue';
import './custom.css';

export default {
  extends: DefaultTheme,
  Layout,
} satisfies Theme;
