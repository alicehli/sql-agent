import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Test config for the app code under src/ (the workspace packages under packages/*
// have their own vitest configs and are run via `pnpm run test:packages`).
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/client'),
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    environment: 'node',
  },
})
