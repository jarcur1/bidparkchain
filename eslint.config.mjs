import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

// Names starting with `_` are deliberately unused: Express error middleware arity, Playwright fixture
// dependencies that must be destructured, and callback parameters that a signature requires.
const unusedVars = ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }];

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'test-results/', 'playwright-report/', 'data/', 'artifacts/', 'cache/'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    // Only the two hook rules that catch real bugs. The v7 `recommended` preset also enables React Compiler
    // rules (refs, set-state-in-effect, purity, manual memoization) that flag patterns this code uses on
    // purpose, so they stay off. Intentional exhaustive-deps exceptions carry an inline
    // `eslint-disable-next-line` with the reason.
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    // typescript-eslint's rule is the one tseslint.configs.recommended enables on every file, so it replaces the
    // core rule, which cannot see TypeScript type usage.
    files: ['**/*.{js,mjs,ts,tsx}'],
    rules: { 'no-unused-vars': 'off', '@typescript-eslint/no-unused-vars': unusedVars },
  },
  {
    files: ['src/**/*.{ts,tsx}', 'shared/**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['server/**/*.mjs', 'scripts/**/*.mjs', 'shared/**/*.{ts,tsx,js,mjs}', 'tests/**/*.{ts,tsx,js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    // Playwright specs also run callbacks in the browser (page.evaluate, addInitScript).
    files: ['tests/e2e/**/*.mjs'],
    languageOptions: { globals: globals.browser },
  },
  {
    // Playwright requires an object pattern as the first fixture argument, even when it has no dependencies.
    files: ['tests/e2e/**/*.mjs'],
    rules: { 'no-empty-pattern': ['error', { allowObjectPatternsAsParameters: true }] },
  },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
);
