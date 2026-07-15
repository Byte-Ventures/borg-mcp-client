import { describe, it, expect, vi } from 'vitest';
import {
  enumerateLinkedWorktrees,
  discoverDroneCandidates,
  matchesOnlyLabel,
} from '../src/launch-all-discovery';
import type { LaunchAllDeps } from '../src/launch-all-deps';
import type { ActiveCube } from '../src/cubes';

const CUBE_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_CUBE = '22222222-2222-2222-2222-222222222222';
function droneId(n: number): string {
  return `0000000${n}-0000-0000-0000-000000000000`.slice(0, 36);
}
function cube(over: Partial<ActiveCube> = {}): ActiveCube {
  return {
    cubeId: CUBE_ID,
    droneId: droneId(1),
    name: 'myrepo',
    sessionToken: 'sess',
    droneLabel: 'drone-1',
    apiUrl: 'http://api.test',
    ...over,
  };
}

function makeStubDeps(over: Partial<LaunchAllDeps> = {}): LaunchAllDeps {
  return {
    runSync: vi.fn(() => ''),
    runSyncExitCode: vi.fn(() => 0),
    cwd: vi.fn(() => '/work/myrepo'),
    pathExists: vi.fn(() => true),
    homedir: vi.fn(() => '/home/test'),
    mkdirp: vi.fn(),
    readFileOpt: vi.fn(() => null),
    writeFile: vi.fn(),
    unlinkOpt: vi.fn(),
    statMtime: vi.fn(() => null),
    listDir: vi.fn(() => []),
    getCachedAuth: vi.fn(async () => ({ token: 't', apiUrl: 'http://api.test' })),
    getRoster: vi.fn(async () => ({ drones: [] })),
    getCube: vi.fn(async () => ({ id: CUBE_ID, name: 'myrepo', roles: [] })),
    probeSeat: vi.fn(async () => 'live' as const),
    getCliPreferenceForPath: vi.fn(async () => null),
    readAllProjectIdentities: vi.fn(async () => []),
    findProjectRoot: vi.fn((d: string) => d),
    getActiveCube: vi.fn(async () => null),
    prompt: vi.fn(async () => 'y'),
    isTTY: vi.fn(() => true),
    stderr: vi.fn(),
    stdout: vi.fn(),
    ...over,
  };
}

const porcelain = (main: string, ...linked: string[]) =>
  [`worktree ${main}\nHEAD abc\nbranch refs/heads/main`, ...linked.map((p) => `worktree ${p}\nHEAD def\nbranch refs/heads/wt-x`)].join('\n\n') + '\n';

describe('enumerateLinkedWorktrees (gh#556 Part 2)', () => {
  it('returns the two siblings (drops the main worktree)', () => {
    const run = () => porcelain('/work/myrepo', '/work/myrepo-builder', '/home/test/.borg/worktrees/myrepo/reviewer');
    expect(enumerateLinkedWorktrees(run)).toEqual(['/work/myrepo-builder', '/home/test/.borg/worktrees/myrepo/reviewer']);
  });
  it('returns empty when only the main worktree exists', () => {
    expect(enumerateLinkedWorktrees(() => porcelain('/work/myrepo'))).toEqual([]);
  });
  it('throws a user-readable error when git worktree list fails', () => {
    const run = () => { throw new Error('not a git repository'); };
    expect(() => enumerateLinkedWorktrees(run)).toThrow(/git worktree list failed/);
  });
  it('filters a block that has no worktree line', () => {
    const raw = `worktree /work/myrepo\nHEAD abc\n\nHEAD def\nbranch refs/heads/orphan`;
    expect(enumerateLinkedWorktrees(() => raw)).toEqual([]);
  });
});

describe('discoverDroneCandidates (gh#556 Part 2)', () => {
  it('returns one candidate for a matching cubeId', async () => {
    const deps = makeStubDeps({
      runSync: vi.fn(() => porcelain('/work/myrepo', '/work/myrepo-builder')),
      readAllProjectIdentities: vi.fn(async () => [{ projectPath: '/work/myrepo-builder', cube: cube({ droneLabel: 'drone-1' }) }]),
    });
    const c = await discoverDroneCandidates({ targetCubeId: CUBE_ID }, deps);
    expect(c).toHaveLength(1);
    expect(c[0].worktreeDir).toBe('/work/myrepo-builder');
    expect(c[0].droneLabel).toBe('drone-1');
  });

  it('excludes a worktree with no cubes.json entry (silent)', async () => {
    const deps = makeStubDeps({
      runSync: vi.fn(() => porcelain('/work/myrepo', '/work/other')),
      readAllProjectIdentities: vi.fn(async () => []),
    });
    expect(await discoverDroneCandidates({ targetCubeId: CUBE_ID }, deps)).toEqual([]);
    expect(deps.stderr).not.toHaveBeenCalled();
  });

  it('excludes a worktree whose cubeId mismatches (silent)', async () => {
    const deps = makeStubDeps({
      runSync: vi.fn(() => porcelain('/work/myrepo', '/work/myrepo-builder')),
      readAllProjectIdentities: vi.fn(async () => [{ projectPath: '/work/myrepo-builder', cube: cube({ cubeId: OTHER_CUBE }) }]),
    });
    expect(await discoverDroneCandidates({ targetCubeId: CUBE_ID }, deps)).toEqual([]);
    expect(deps.stderr).not.toHaveBeenCalled();
  });

  it('excludes + warns on a malformed (non-UUID) droneId', async () => {
    const deps = makeStubDeps({
      runSync: vi.fn(() => porcelain('/work/myrepo', '/work/myrepo-builder')),
      readAllProjectIdentities: vi.fn(async () => [{ projectPath: '/work/myrepo-builder', cube: cube({ droneId: 'not-a-uuid' }) }]),
    });
    expect(await discoverDroneCandidates({ targetCubeId: CUBE_ID }, deps)).toEqual([]);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('malformed cubeId/droneId'));
  });

  it('excludes + warns on a worktree dir missing from disk', async () => {
    const deps = makeStubDeps({
      runSync: vi.fn(() => porcelain('/work/myrepo', '/work/myrepo-gone')),
      pathExists: vi.fn(() => false),
      readAllProjectIdentities: vi.fn(async () => [{ projectPath: '/work/myrepo-gone', cube: cube() }]),
    });
    expect(await discoverDroneCandidates({ targetCubeId: CUBE_ID }, deps)).toEqual([]);
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('directory not found'));
  });

  it('returns BOTH an old-scheme sibling AND a new-scheme ~/.borg worktree (Part 1 back-compat)', async () => {
    const oldPath = '/Users/theo/development/repo-builder';
    const newPath = '/Users/theo/.borg/worktrees/repo/reviewer';
    const deps = makeStubDeps({
      runSync: vi.fn(() => porcelain('/Users/theo/development/repo', oldPath, newPath)),
      readAllProjectIdentities: vi.fn(async () => [
        { projectPath: oldPath, cube: cube({ droneLabel: 'drone-1', droneId: droneId(1) }) },
        { projectPath: newPath, cube: cube({ droneLabel: 'drone-2', droneId: droneId(2) }) },
      ]),
    });
    const c = await discoverDroneCandidates({ targetCubeId: CUBE_ID }, deps);
    expect(c.map((x) => x.worktreeDir)).toEqual([oldPath, newPath]);
  });

  it('--only drone-2 keeps only that label', async () => {
    const deps = makeStubDeps({
      runSync: vi.fn(() => porcelain('/work/myrepo', '/work/a', '/work/b')),
      readAllProjectIdentities: vi.fn(async () => [
        { projectPath: '/work/a', cube: cube({ droneLabel: 'drone-1', droneId: droneId(1) }) },
        { projectPath: '/work/b', cube: cube({ droneLabel: 'drone-2', droneId: droneId(2) }) },
      ]),
    });
    const c = await discoverDroneCandidates({ targetCubeId: CUBE_ID, only: 'drone-2' }, deps);
    expect(c.map((x) => x.droneLabel)).toEqual(['drone-2']);
  });

  it('--only matching nothing returns empty', async () => {
    const deps = makeStubDeps({
      runSync: vi.fn(() => porcelain('/work/myrepo', '/work/a')),
      readAllProjectIdentities: vi.fn(async () => [{ projectPath: '/work/a', cube: cube({ droneLabel: 'drone-1' }) }]),
    });
    expect(await discoverDroneCandidates({ targetCubeId: CUBE_ID, only: 'nonexistent' }, deps)).toEqual([]);
  });
});

describe('matchesOnlyLabel', () => {
  it('exact (case-insensitive) + prefix', () => {
    expect(matchesOnlyLabel('drone-3', 'drone-3')).toBe(true);
    expect(matchesOnlyLabel('drone-3', 'DRONE-3')).toBe(true);
    expect(matchesOnlyLabel('drone-1', 'drone')).toBe(true); // prefix
    expect(matchesOnlyLabel('drone-1', 'drone-2')).toBe(false);
  });
});
