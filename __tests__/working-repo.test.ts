import { describe, expect, it } from 'vitest';
import { resolveWorkingRepo } from '../src/working-repo';

describe('resolveWorkingRepo', () => {
  it('reports a git worktree by canonical repository identity without its local path', () => {
    const repo = resolveWorkingRepo('/Users/dev/.borg/worktrees/borg-mcp/builder-3', {
      runGit: (_cwd, args) => {
        if (args[0] === 'rev-parse') {
          return { status: 0, stdout: '/Users/dev/.borg/worktrees/borg-mcp/builder-3\n' };
        }
        return { status: 0, stdout: 'git@github.com:borgmcp/borg-mcp.git\n' };
      },
    });

    expect(repo).toEqual({
      name: 'borg-mcp',
      origin: 'github.com/borgmcp/borg-mcp',
    });
  });

  it('reports a plain git directory with its configured origin', () => {
    const repo = resolveWorkingRepo('/src/borg-mcp/client', {
      runGit: (_cwd, args) => {
        if (args[0] === 'rev-parse') return { status: 0, stdout: '/src/borg-mcp\n' };
        return { status: 0, stdout: 'https://github.com/borgmcp/borg-mcp.git\n' };
      },
    });

    expect(repo).toEqual({
      name: 'borg-mcp',
      origin: 'github.com/borgmcp/borg-mcp',
    });
  });

  it('reports no repository identity when cwd is not a git repository', () => {
    const repo = resolveWorkingRepo('/tmp/scratch-project', {
      runGit: () => ({ status: 128, stdout: '' }),
    });

    expect(repo).toEqual({
      name: null,
      origin: null,
    });
  });

  it.each([
    ['https userinfo', 'https://x-access-token:super-secret@github.com/borgmcp/private-repo.git?token=query-secret#fragment-secret'],
    ['ssh userinfo', 'ssh://git:ssh-secret@github.com/borgmcp/private-repo.git?token=query-secret#fragment-secret'],
    ['git userinfo', 'git://git:git-secret@github.com/borgmcp/private-repo.git?token=query-secret#fragment-secret'],
    ['SCP user prefix', 'git@github.com:borgmcp/private-repo.git?token=query-secret#fragment-secret'],
  ])('canonicalizes %s without emitting credentials or URL suffixes', (_kind, rawOrigin) => {
    const repo = resolveWorkingRepo('/src/private-repo', {
      runGit: (_cwd, args) => {
        if (args[0] === 'rev-parse') return { status: 0, stdout: '/src/private-repo\n' };
        return { status: 0, stdout: `${rawOrigin}\n` };
      },
    });

    expect(repo).toEqual({
      name: 'private-repo',
      origin: 'github.com/borgmcp/private-repo',
    });
    for (const secret of ['super-secret', 'ssh-secret', 'git-secret', 'query-secret', 'fragment-secret', 'git@', '/src/private-repo']) {
      expect(JSON.stringify(repo)).not.toContain(secret);
    }
  });

  it('reports no identity for an uncanonicalizable origin', () => {
    const repo = resolveWorkingRepo('/src/private-repo', {
      runGit: (_cwd, args) => args[0] === 'rev-parse'
        ? { status: 0, stdout: '/src/private-repo\n' }
        : { status: 0, stdout: 'not-a-remote\n' },
    });

    expect(repo).toEqual({ name: null, origin: null });
  });
});
