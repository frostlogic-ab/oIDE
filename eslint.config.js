// Root ESLint flat config for the whole monorepo (`pnpm lint`).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/release/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.vite/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'docs/wiki/raw/**',
      'docs/site/.vitepress/cache/**',
      // oIDE artifacts (designs with bundled React runtimes), not project source.
      '.oide/artifacts/**',
      '**/*.dc.html',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { fixStyle: 'inline-type-imports', disallowTypeAnnotations: false }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Renderer, UI kit and extension UIs run in the browser.
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}', 'apps/desktop/src/artifact-runtime/**/*.ts', 'packages/ui/**/*.{ts,tsx}', 'extensions/*/ui/**/*.{ts,tsx,js}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.{tsx,jsx}', 'packages/ui/**/*.ts', 'apps/desktop/src/renderer/**/*.ts'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Playwright tests run code in the page through page.evaluate.
    files: ['apps/desktop/e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { sourceType: 'commonjs' },
  },
);
