import { describe, expect, it, vi } from 'vitest';
import {
  formatOpenCodeSeatIdentityError,
  OpenCodeSeatIdentityError,
  resolveOpenCodeSeatIdentity,
} from '../src/opencode-seat-identity';
import type { ActiveCube } from '../src/cubes';

function seat(worktree: string, droneLabel = 'builder-2'): ActiveCube {
  return {
    cubeId: '11111111-1111-4111-8111-111111111111',
    droneId: '22222222-2222-4222-8222-222222222222',
    name: 'repo',
    sessionToken: 'token',
    droneLabel,
    apiUrl: 'https://127.0.0.1:7091',
    worktree,
  };
}

describe('OpenCode session seat identity', () => {
  it('binds two sibling sessions to distinct seats despite one repo-rooted child context', async () => {
    const roots = ['/work/repo-builder', '/work/repo-reviewer'];
    const labels = ['builder-1', 'reviewer-1'];
    const resolved = await Promise.all(roots.map((worktree, index) =>
      resolveOpenCodeSeatIdentity({
        listRoots: async () => ({ roots: [{ uri: `file://${worktree}` }] }),
        findProjectRoot: (directory) => directory,
        getActiveCubeForWorktree: async (requested) => seat(requested, labels[index]),
        pinSeatIdentity: vi.fn(),
        childCwd: '/work/repo',
      }),
    ));

    expect(resolved.map((active) => [active.droneLabel, active.worktree])).toEqual([
      ['builder-1', '/work/repo-builder'],
      ['reviewer-1', '/work/repo-reviewer'],
    ]);
  });

  it('pins the sibling seat from the session root even when the MCP child cwd is the repo root', async () => {
    const sibling = '/work/repo-builder';
    const pinSeatIdentity = vi.fn();
    const getActiveCubeForWorktree = vi.fn(async () => seat(sibling));

    await expect(resolveOpenCodeSeatIdentity({
      listRoots: async () => ({ roots: [{ uri: 'file:///work/repo-builder' }] }),
      findProjectRoot: (directory) => directory,
      getActiveCubeForWorktree,
      pinSeatIdentity,
      childCwd: '/work/repo',
    })).resolves.toMatchObject({ droneLabel: 'builder-2', worktree: sibling });

    expect(getActiveCubeForWorktree).toHaveBeenCalledWith(sibling);
    expect(pinSeatIdentity).toHaveBeenCalledWith(expect.objectContaining({ worktree: sibling }));
  });

  it('preserves direct borg launch when cwd and the served session share the worktree', async () => {
    const worktree = '/work/repo-reviewer';
    await expect(resolveOpenCodeSeatIdentity({
      listRoots: async () => ({ roots: [{ uri: 'file:///work/repo-reviewer' }] }),
      findProjectRoot: (directory) => directory,
      getActiveCubeForWorktree: async () => seat(worktree, 'reviewer-1'),
      pinSeatIdentity: vi.fn(),
      childCwd: worktree,
    })).resolves.toMatchObject({ droneLabel: 'reviewer-1', worktree });
  });

  it('fails loudly before pinning when the resolved seat belongs to another worktree', async () => {
    const pinSeatIdentity = vi.fn();
    await expect(resolveOpenCodeSeatIdentity({
      listRoots: async () => ({ roots: [{ uri: 'file:///work/repo-builder' }] }),
      findProjectRoot: (directory) => directory,
      getActiveCubeForWorktree: async () => seat('/work/repo'),
      pinSeatIdentity,
      childCwd: '/work/repo',
    })).rejects.toMatchObject<Partial<OpenCodeSeatIdentityError>>({
      code: 'SEAT_WORKTREE_MISMATCH',
    });
    expect(pinSeatIdentity).not.toHaveBeenCalled();
  });

  it.each([
    { roots: [] },
    { roots: [{ uri: 'file:///one' }, { uri: 'file:///two' }] },
    { roots: [{ uri: 'https://example.com/repo' }] },
  ])('rejects an unusable session-root pin without cwd fallback', async (roots) => {
    const getActiveCubeForWorktree = vi.fn();
    await expect(resolveOpenCodeSeatIdentity({
      listRoots: async () => roots,
      findProjectRoot: (directory) => directory,
      getActiveCubeForWorktree,
      pinSeatIdentity: vi.fn(),
      childCwd: '/work/repo',
    })).rejects.toBeInstanceOf(OpenCodeSeatIdentityError);
    expect(getActiveCubeForWorktree).not.toHaveBeenCalled();
  });

  it('renders a durable loud failure with the conflicting seat and executable recovery', () => {
    const error = new OpenCodeSeatIdentityError(
      'SEAT_WORKTREE_MISMATCH',
      'The seat and session directory differ.',
      '/work/repo-builder',
      seat('/work/repo', 'coordinator-1'),
    );
    const rendered = formatOpenCodeSeatIdentityError(error, '/work/repo');
    expect(rendered).toContain('Borg OpenCode identity error [SEAT_WORKTREE_MISMATCH]');
    expect(rendered).toContain('coordinator-1 (/work/repo)');
    expect(rendered).toContain('were not started');
    expect(rendered).toContain('borg --cli opencode');
    expect(rendered).toContain('borg reset-local-connection');
  });
});
