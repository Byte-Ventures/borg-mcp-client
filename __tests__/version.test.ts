/**
 * Tests for the runtime version reader.
 *
 * The implementation reads `client/package.json` relative to its own
 * `import.meta.url` and caches at module-eval. These tests assert the
 * read happens (not "unknown") and that it matches whatever's in the
 * actual package.json — preventing drift if a future refactor
 * accidentally hardcodes a string back into the constructor.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getPackageVersion } from '../src/version';

function readActualPackageVersion(): string {
  const here = fileURLToPath(import.meta.url);
  const pkgPath = join(dirname(here), '..', 'package.json');
  return JSON.parse(readFileSync(pkgPath, 'utf-8')).version;
}

describe('getPackageVersion', () => {
  it('returns a non-empty string', () => {
    const v = getPackageVersion();
    expect(typeof v).toBe('string');
    expect(v.length).toBeGreaterThan(0);
  });

  it('does not fall back to "unknown" (package.json must be readable)', () => {
    // If this test fails, the version-resolution path is broken — the
    // module's import.meta.url anchor can't find package.json. That
    // would mean Claude Code's `/mcp` view starts reporting "unknown"
    // for borgmcp version. Fast-fail rather than slow drift.
    expect(getPackageVersion()).not.toBe('unknown');
  });

  it('matches the version field in client/package.json', () => {
    // Pin: getPackageVersion must return the same string as the
    // checked-in package.json. Future hardcoded fallbacks or stale
    // caches would diverge here.
    expect(getPackageVersion()).toBe(readActualPackageVersion());
  });

  it('matches semver shape (X.Y.Z[-suffix])', () => {
    expect(getPackageVersion()).toMatch(/^\d+\.\d+\.\d+(-[\w.-]+)?$/);
  });
});
