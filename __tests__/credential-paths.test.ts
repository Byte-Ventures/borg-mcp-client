import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const originalStateRoot = process.env.BORG_STATE_ROOT;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalStateRoot;
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

  it('uses BORG_STATE_ROOT ahead of HOME for isolated credentials', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'borg-credential-state-root-'));
    const ambientHome = mkdtempSync(join(tmpdir(), 'borg-credential-ambient-home-'));
    try {
      process.env.BORG_STATE_ROOT = stateRoot;
      process.env.HOME = ambientHome;
      vi.resetModules();
      const paths = await import('../src/credential-paths.js');
      expect(paths.BORG_USER_ROOT).toBe(join(stateRoot, '.borg'));
      expect(paths.SERVER_CREDENTIALS_FILE).toBe(join(stateRoot, '.borg', 'credentials'));
    } finally {
      rmSync(stateRoot, { recursive: true, force: true });
      rmSync(ambientHome, { recursive: true, force: true });
    }
  });
});
