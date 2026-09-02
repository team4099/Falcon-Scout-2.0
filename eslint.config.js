import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // convex/_generated is written by `npx convex dev` and carries its own
  // eslint-disable header — linting it only produces churn, and `--fix` will
  // strip that header.
  globalIgnores(['dist', 'dev-dist', 'convex/_generated']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      // The codebase marks deliberately-unused bindings with a leading
      // underscore (destructured props kept for documentation, placeholder
      // callback params). Honour that convention instead of flagging them.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
      }],
    },
  },
  {
    // Vite's config runs in Node and legitimately pokes at globalThis for the
    // service-worker circuit breaker, where `any` is the honest type.
    files: ['vite.config.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
])
