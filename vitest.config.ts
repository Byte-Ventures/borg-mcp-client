import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    include: ['__tests__/**/*.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    testTimeout: 10_000,
  },
});
