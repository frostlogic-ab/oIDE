import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts', 'tools/*/test/**/*.test.ts', 'apps/desktop/src/**/*.test.{ts,tsx}', 'extensions/*/src/**/*.test.ts', 'test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'apps/desktop/e2e/**'],
    environment: 'node',
    setupFiles: ['./test/setup/env.ts'],
    testTimeout: 20000,
  },
});
