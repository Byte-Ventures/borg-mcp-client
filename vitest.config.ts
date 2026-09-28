import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    include: ['__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 60_000,
    globalSetup: ['__tests__/global/real-home-guard.ts'],
    setupFiles: ['__tests__/setup-isolated-home.ts'],
  },
});
