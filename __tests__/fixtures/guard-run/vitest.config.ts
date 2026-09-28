// A real vitest run under the production guard, for the guard's own control.
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    root: resolve(__dirname, '../../..'),
    environment: 'node',
    include: ['__tests__/fixtures/guard-run/writes.fixture.ts'],
    globalSetup: ['__tests__/global/real-home-guard.ts'],
    setupFiles: ['__tests__/setup-isolated-home.ts'],
  },
});
