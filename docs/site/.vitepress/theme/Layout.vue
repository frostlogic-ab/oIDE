<script setup lang="ts">
// Picks the page shell: `layout: landing` (the home page) gets the design's own page, every other
// page gets the default VitePress layout with oIDE's styles (custom.css). The docs nav title is the
// app header lockup: the mark and "oIDE" (config.ts sets `siteTitle: false`).
import DefaultTheme from 'vitepress/theme';
import { useData } from 'vitepress';
import Landing from './Landing.vue';

const { frontmatter } = useData();
</script>

<template>
  <Landing v-if="frontmatter.layout === 'landing'" />
  <DefaultTheme.Layout v-else>
    <template #nav-bar-title-after>
      <span>oIDE</span>
    </template>
  </DefaultTheme.Layout>
</template>
