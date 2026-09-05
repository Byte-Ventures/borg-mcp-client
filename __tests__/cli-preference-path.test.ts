import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

  it.each([
    ['malformed JSON', '{"projects": ]\n'],
    ['valid JSON with the wrong shape', '{"projects": []}\n'],
  ])('refuses to overwrite %s in the launch file', async (_label, raw) => {
    const { setProjectCliPreference } = await import('../src/cubes.js');
    const launchPath = join(fixture, '.config', 'borgmcp', 'launch.json');
    mkdirSync(join(fixture, '.config', 'borgmcp'), { recursive: true });
    writeFileSync(launchPath, raw);

    await expect(setProjectCliPreference('codex', worktreeA)).rejects.toThrow(
      `Borg state file is unreadable; refusing to overwrite it: ${launchPath}`,
    );
    expect(readFileSync(launchPath, 'utf8')).toBe(raw);
  });
});
