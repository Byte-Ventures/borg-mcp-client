// A real vitest run of one state control that fails before it signals its child.
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    root: resolve(__dirname, '../../..'),
    environment: 'node',
    include: ['__tests__/fixtures/stall-run/fails-before-go.fixture.ts'],
    globalSetup: ['__tests__/global/real-home-guard.ts'],
    setupFiles: ['__tests__/setup-isolated-home.ts'],
  },
});
