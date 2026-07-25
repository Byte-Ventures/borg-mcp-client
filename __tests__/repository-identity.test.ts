import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  it('prefers a canonical public origin and uses the shared Git common directory', async () => {
    const context = await resolveGitRepositoryContext('/repo/worktree', {
      canonicalPath: async (value) => value,
      runGit: (_cwd, args) => {
        const command = args.join(' ');
        if (command === 'rev-parse --show-toplevel') return { status: 0, stdout: '/repo/worktree\n' };
        if (command === 'rev-parse --is-bare-repository') return { status: 0, stdout: 'false\n' };
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
