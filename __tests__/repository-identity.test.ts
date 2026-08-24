import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CUBE_TEMPLATES } from 'borgmcp-shared/protocol';
import {
  getOrCreateRepositoryIdentity,
  getRepositoryAssociation,
  resolveGitRepositoryContext,
  saveRepositoryAssociation,
  type GitRepositoryContext,
} from '../src/repository-identity.js';

const roots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'borg-repository-identity-')));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('repository identity', () => {
  it('returns no context only when Git reports that the directory is not a repository', async () => {
    await expect(resolveGitRepositoryContext('/not-a-repo', {
      runGit: () => ({
        status: 128,
        stderr: 'fatal: not a git repository (or any of the parent directories): .git\n',
      }),
    })).resolves.toBeNull();
  });

  it('preserves the designed bare-repository sentinel', async () => {
    await expect(resolveGitRepositoryContext('/repo.git', {
      runGit: () => ({ status: 0, stdout: 'true\n' }),
    })).rejects.toThrow('BARE_REPOSITORY');
  });

  it.each(['ENOENT', 'EACCES', 'EPERM'])('reports Git execution failure %s with its cause', async (code) => {
    const cause = Object.assign(new Error(`spawn git ${code}`), { code });
    await expect(resolveGitRepositoryContext('/repo', {
      runGit: () => ({ status: null, error: cause }),
    })).rejects.toMatchObject({
      name: 'RepositoryDiscoveryError',
      kind: 'git-execution',
      cause,
    });
  });

  it('reports an invalid working directory spawn failure with its cause', async () => {
    const cause = Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT', path: '/missing/repo' });
    await expect(resolveGitRepositoryContext('/missing/repo', {
      runGit: () => ({ status: null, error: cause }),
    })).rejects.toMatchObject({
      message: expect.stringContaining('spawnSync git ENOENT'),
      cause,
    });
  });

  it('reports Git safety and configuration failures instead of claiming there is no repository', async () => {
    await expect(resolveGitRepositoryContext('/repo', {
      runGit: () => ({ status: 128, stderr: 'fatal: detected dubious ownership in repository at /repo\n' }),
    })).rejects.toMatchObject({
      name: 'RepositoryDiscoveryError',
      kind: 'git-query',
      message: expect.stringContaining('detected dubious ownership'),
    });
  });

  it('reports a failed common-directory query with its Git diagnostic', async () => {
    await expect(resolveGitRepositoryContext('/repo', {
      runGit: (_cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --is-bare-repository') return { status: 0, stdout: 'false\n' };
        if (command === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
        return { status: 128, stderr: 'fatal: could not resolve git common directory\n' };
      },
    })).rejects.toMatchObject({
      kind: 'git-query',
      message: expect.stringContaining('could not resolve git common directory'),
    });
  });

  it('reports an origin configuration failure instead of treating it as no origin', async () => {
    await expect(resolveGitRepositoryContext('/repo', {
      canonicalPath: async (value) => value,
      runGit: (_cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --is-bare-repository') return { status: 0, stdout: 'false\n' };
        if (command === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
        if (command === 'rev-parse --path-format=absolute --git-common-dir') {
          return { status: 0, stdout: '/repo/.git\n' };
        }
        return { status: 128, stderr: 'fatal: bad config line 1 in file .git/config\n' };
      },
    })).rejects.toMatchObject({
      kind: 'git-query',
      message: expect.stringContaining('bad config line 1'),
    });
  });

  it.each(['ENOENT', 'EACCES', 'EPERM', 'ENOTDIR', 'ELOOP'])(
    'reports canonical repository path failure %s with its cause',
    async (code) => {
      const cause = Object.assign(new Error(`realpath ${code}`), { code });
      await expect(resolveGitRepositoryContext('/repo', {
        runGit: (_cwd, args) => {
          const command = args.join(' ');
          if (command === 'rev-parse --is-bare-repository') return { status: 0, stdout: 'false\n' };
          if (command === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo\n' };
          return { status: 0, stdout: '/repo/.git\n' };
        },
        canonicalPath: async () => { throw cause; },
      })).rejects.toMatchObject({
        name: 'RepositoryDiscoveryError',
        kind: 'canonical-path',
        cause,
      });
    },
  );

  it('prefers a canonical public origin and uses the shared Git common directory', async () => {
    const context = await resolveGitRepositoryContext('/repo/worktree', {
      canonicalPath: async (value) => value,
      runGit: (_cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --is-bare-repository') return { status: 0, stdout: 'false\n' };
        if (command === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo/worktree\n' };
        if (command === 'rev-parse --path-format=absolute --git-common-dir') return { status: 0, stdout: '/repo/.git\n' };
        return { status: 0, stdout: 'git@github.com:Org/Repo.git\n' };
      },
    });

    expect(context).toMatchObject({
      root: '/repo/worktree',
      commonDir: '/repo/.git',
      publicRepository: { kind: 'origin', value: 'https://github.com/Org/Repo' },
      publicRepositoryName: 'Org/Repo',
    });
  });

  it('keeps a no-origin repository UUID stable without storing its Git path', async () => {
    const root = temporaryRoot();
    const context: GitRepositoryContext = {
      root: '/private/repo',
      commonDir: '/private/repo/.git',
      derivedName: 'repo',
      publicRepository: null,
      publicRepositoryName: null,
    };

    const first = await getOrCreateRepositoryIdentity(context, { root });
    const second = await getOrCreateRepositoryIdentity(context, { root });

    expect(second).toEqual(first);
    expect(first.kind).toBe('local');
    expect(readFileSync(join(root, 'repository-identities.json'), 'utf8')).not.toContain('/private/repo');
    expect(statSync(join(root, 'repository-identity.key')).mode & 0o777).toBe(0o600);
  });

  it('fails closed instead of replacing a malformed identity secret', async () => {
    const root = temporaryRoot();
    const secretPath = join(root, 'repository-identity.key');
    writeFileSync(secretPath, 'malformed\n', { mode: 0o600 });
    const context: GitRepositoryContext = {
      root: '/repo', commonDir: '/repo/.git', derivedName: 'repo',
      publicRepository: null, publicRepositoryName: null,
    };

    await expect(getOrCreateRepositoryIdentity(context, { root })).rejects.toThrow('secret is malformed');
    expect(readFileSync(secretPath, 'utf8')).toBe('malformed\n');
  });

  it('binds associations to both server trust and repository identity', async () => {
    const root = temporaryRoot();
    const repository = { kind: 'local' as const, value: 'ad1b74bd-1262-45dd-b015-298e7395c550' };
    const association = {
      cubeId: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826',
      name: 'repo',
      workingRepoName: 'repo',
      template: 'starter' as const,
    };

    await saveRepositoryAssociation('trust-a', repository, association, { root });

    await expect(getRepositoryAssociation('trust-a', repository, { root })).resolves.toEqual(association);
    await expect(getRepositoryAssociation('trust-b', repository, { root })).resolves.toBeNull();
  });

  it.each(CUBE_TEMPLATES)('round-trips a real association using the shared %s template', async (template) => {
    const root = temporaryRoot();
    const repository = { kind: 'local' as const, value: 'ad1b74bd-1262-45dd-b015-298e7395c550' };
    const association = {
      cubeId: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826',
      name: 'repo',
      workingRepoName: 'repo',
      template,
    };

    await saveRepositoryAssociation('trust-a', repository, association, { root });

    await expect(getRepositoryAssociation('trust-a', repository, { root })).resolves.toEqual(association);
  });

  it('discards a tag-12 default association without corrupting unrelated identity state', async () => {
    const root = temporaryRoot();
    const legacyRepository = { kind: 'local' as const, value: 'ad1b74bd-1262-45dd-b015-298e7395c550' };
    const otherRepository = { kind: 'local' as const, value: 'bd2c85ce-2373-46ee-9026-309f8406d661' };
    const otherAssociation = {
      cubeId: '8da6e20c-6b18-44aa-a3ea-a9d839cdf57a',
      name: 'other-repo',
      workingRepoName: 'other-repo',
      template: 'starter' as const,
    };
    const localContext: GitRepositoryContext = {
      root: '/private/repo', commonDir: '/private/repo/.git', derivedName: 'repo',
      publicRepository: null, publicRepositoryName: null,
    };
    const localIdentity = await getOrCreateRepositoryIdentity(localContext, { root });
    await saveRepositoryAssociation('trust-a', legacyRepository, {
      cubeId: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826',
      name: 'legacy-repo', workingRepoName: 'legacy-repo', template: 'starter',
    }, { root });
    await saveRepositoryAssociation('trust-a', otherRepository, otherAssociation, { root });

    const statePath = join(root, 'repository-identities.json');
    const tag12State = JSON.parse(readFileSync(statePath, 'utf8'));
    const legacy = Object.values(tag12State.associations)
      .find((association: any) => association.name === 'legacy-repo') as any;
    legacy.template = 'default';
    writeFileSync(statePath, `${JSON.stringify(tag12State, null, 2)}\n`, { mode: 0o600 });

    await expect(getRepositoryAssociation('trust-a', legacyRepository, { root })).resolves.toBeNull();
    await expect(getRepositoryAssociation('trust-a', otherRepository, { root })).resolves.toEqual(otherAssociation);
    await expect(getOrCreateRepositoryIdentity(localContext, { root })).resolves.toEqual(localIdentity);
    const migrated = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(Object.values(migrated.associations)).toEqual([otherAssociation]);
    expect(JSON.stringify(migrated)).not.toContain('"default"');
  });

  it('fails closed on control-bearing association display state', async () => {
    const root = temporaryRoot();
    const repository = { kind: 'local' as const, value: 'ad1b74bd-1262-45dd-b015-298e7395c550' };
    await saveRepositoryAssociation('trust-a', repository, {
      cubeId: '9eb7f31d-7c29-43e6-9361-d80cbbf8e826',
      name: 'repo', workingRepoName: 'repo', template: 'starter',
    }, { root });
    const statePath = join(root, 'repository-identities.json');
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state.associations[Object.keys(state.associations)[0]].name = 'repo\u001b[2J';
    writeFileSync(statePath, `${JSON.stringify(state)}\n`, { mode: 0o600 });

    await expect(getRepositoryAssociation('trust-a', repository, { root }))
      .rejects.toThrow('identity store is malformed');
  });
});
