import { defineConfig } from 'vitest/config'

// Local config so package test runs don't inherit the repo-root vitest.config.ts
// (which scopes `include` to the app's src/ and would otherwise match nothing here).
export default defineConfig({
  test: {
    include: ['__tests__/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
  },
})
