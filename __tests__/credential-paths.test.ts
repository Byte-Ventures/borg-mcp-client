import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  vi.resetModules();
});

describe('portable credential paths', () => {
  it('uses the established ~/.borg/credentials file without moving seats', async () => {
    const home = mkdtempSync(join(tmpdir(), 'borg-credential-paths-'));
    try {
      process.env.HOME = home;
      vi.resetModules();
      const paths = await import('../src/credential-paths.js');
      const canonicalHome = realpathSync(home);
      expect(paths.BORG_USER_ROOT).toBe(join(canonicalHome, '.borg'));
      expect(paths.SERVER_CREDENTIALS_FILE).toBe(join(canonicalHome, '.borg', 'credentials'));
      expect(paths).not.toHaveProperty('SEATS_FILE');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
