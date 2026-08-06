import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('named CLI preference persistence', () => {
  const originalCwd = process.cwd();
  const originalHome = process.env.HOME;
  const originalStateRoot = process.env.BORG_STATE_ROOT;
  let fixture: string;
  let worktreeA: string;
  let worktreeB: string;

  beforeEach(() => {
    fixture = realpathSync(mkdtempSync(join(tmpdir(), 'borg-cli-preference-')));
    worktreeA = join(fixture, 'project-a');
    worktreeB = join(fixture, 'project-b');
    mkdirSync(join(worktreeA, '.git'), { recursive: true });
    mkdirSync(join(worktreeB, '.git'), { recursive: true });
    process.env.BORG_STATE_ROOT = fixture;
    process.env.HOME = fixture;
    process.chdir(worktreeA);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
    else process.env.BORG_STATE_ROOT = originalStateRoot;
    rmSync(fixture, { recursive: true, force: true });
    vi.resetModules();
  });

  it('round-trips named worktree keys without conflating sibling paths', async () => {
    const { getProjectCliPreferenceForPath, setProjectCliPreference } = await import('../src/cubes.js');

    await setProjectCliPreference('codex', worktreeA);
    expect(await getProjectCliPreferenceForPath(worktreeA)).toBe('codex');
    expect(await getProjectCliPreferenceForPath(worktreeB)).toBeNull();

    await setProjectCliPreference('claude', worktreeB);
    expect(await getProjectCliPreferenceForPath(worktreeA)).toBe('codex');
    expect(await getProjectCliPreferenceForPath(worktreeB)).toBe('claude');

    const launchFile = JSON.parse(
      readFileSync(join(fixture, '.config', 'borgmcp', 'launch.json'), 'utf8'),
    ) as { projects: Record<string, { cli: string }> };
    expect(launchFile.projects[worktreeA]).toEqual({ cli: 'codex' });
    expect(launchFile.projects[worktreeB]).toEqual({ cli: 'claude' });
  });
});
