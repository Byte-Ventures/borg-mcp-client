import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

  it('preserves simultaneous updates in one process and keeps unrelated preferences', async () => {
    const { setProjectCliPreference } = await import('../src/cubes.js');
    await setProjectCliPreference('codex', worktreeA);
    const paths = Array.from({ length: 8 }, (_, n) => join(fixture, `drone-${n}`));
    await Promise.all(paths.map(path => setProjectCliPreference('opencode', path)));
    const actual = JSON.parse(readFileSync(join(fixture, '.config', 'borgmcp', 'launch.json'), 'utf8'));
    expect(actual.projects).toEqual({
      [worktreeA]: { cli: 'codex' },
      ...Object.fromEntries(paths.map(path => [path, { cli: 'opencode' }])),
    });
  });

  it('preserves choices from independently launched drone processes', async () => {
    const { setProjectCliPreference } = await import('../src/cubes.js');
    await setProjectCliPreference('codex', worktreeA);
    // Older launch.json writers created owner-controlled 0755 directories.
    // Lock contention must work there as well as in a new private directory.
    if (process.platform !== 'win32') chmodSync(join(fixture, '.config', 'borgmcp'), 0o755);
    const paths = Array.from({ length: 8 }, (_, n) => join(fixture, `drone-${n}`));
    const children = paths.map(path => fork(
      fileURLToPath(new URL('./fixtures/cli-preference-child.ts', import.meta.url)),
      [path],
      { execArgv: ['--import', import.meta.resolve('tsx')], env: { ...process.env, BORG_STATE_ROOT: fixture }, silent: true },
    ));
    const ready = children.map(child => new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('exit', () => reject(new Error('CLI preference child exited before the barrier')));
    }));
    const finished = children.map(child => new Promise<void>((resolve, reject) => {
      let stderr = '';
      child.stderr!.on('data', data => { stderr += data.toString(); });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`CLI preference child exited ${code}: ${stderr}`)));
    }));
    // Attach failure handlers while waiting for all contenders to reach the barrier.
    for (const result of finished) void result.catch(() => {});
    try {
      await Promise.all(ready);
      for (const child of children) child.send('start');
      await Promise.all(finished);
      const actual = JSON.parse(readFileSync(join(fixture, '.config', 'borgmcp', 'launch.json'), 'utf8'));
      expect(actual.projects).toEqual({
        [worktreeA]: { cli: 'codex' },
        ...Object.fromEntries(paths.map(path => [path, { cli: 'opencode' }])),
      });
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.allSettled(finished);
    }
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
