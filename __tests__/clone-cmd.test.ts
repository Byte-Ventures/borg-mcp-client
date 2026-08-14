import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runClone, validateCloneRepositoryUrl, type CloneDeps, type GitRunResult } from '../src/clone-cmd';
import { hasCloneCredentials } from '../src/clone-security';
import type { CloneArgs } from '../src/parse-clone-args';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), 'borg-clone-'));
  roots.push(value);
  return value;
}

function git(args: string[], cwd: string): GitRunResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function sourceRepository(base: string): string {
  const source = join(base, 'remotes', 'repo');
  mkdirSync(source, { recursive: true });
  expect(git(['init', '-q', '-b', 'main'], source).status).toBe(0);
  expect(git(['config', 'user.email', 'borg@example.invalid'], source).status).toBe(0);
  expect(git(['config', 'user.name', 'Borg'], source).status).toBe(0);
  writeFileSync(join(source, 'README.md'), 'ready\n');
  expect(git(['add', 'README.md'], source).status).toBe(0);
  expect(git(['commit', '-q', '-m', 'initial'], source).status).toBe(0);
  return source;
}

function rig(base: string, quickstart = vi.fn(async () => 0), tty = true) {
  const output: string[] = [];
  const errors: string[] = [];
  let current = join(base, 'checkouts');
  mkdirSync(current, { recursive: true });
  const deps: CloneDeps = {
    cwd: () => current,
    chdir: (path) => { current = path; },
    runSync: (cmd, args, cwd) => cmd === 'git' ? git(args, cwd ?? current) : ({ status: 1, stdout: '', stderr: '' }),
    pathExists: existsSync,
    isDirectory: (path) => { try { return statSync(path).isDirectory(); } catch { return false; } },
    readDirectory: readdirSync,
    createDirectory: (path) => {
      try { mkdirSync(path, { recursive: true }); return true; } catch { return false; }
    },
    removeTree: (path) => rmSync(path, { recursive: true, force: true }),
    isTTY: () => tty,
    quickstart,
    stdout: (text) => output.push(text),
    stderr: (text) => errors.push(text),
  };
  return { deps, output, errors, quickstart, cwd: () => current };
}

function cloneArgs(repositoryUrl: string, overrides: Partial<CloneArgs> = {}): CloneArgs {
  return { repositoryUrl, checkoutOnly: true, roles: [], yes: false, ...overrides };
}

describe('clone credential boundary', () => {
  it.each([
    'https://alice:secret@example.com/org/repo.git',
    'oauth2:secret@host/org/repo.git',
    'oauth2:secret@host:org/repo.git',
    'ssh://git:secret@example.com/org/repo.git',
  ])('rejects credential form %s before Git argv', async (repositoryUrl) => {
    const base = root();
    const testRig = rig(base);
    const calls: string[][] = [];
    testRig.deps.runSync = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(hasCloneCredentials(repositoryUrl)).toBe(true);
    expect(await runClone(cloneArgs(repositoryUrl), testRig.deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(testRig.output.join('') + testRig.errors.join('')).not.toContain('secret');
  });

  it('accepts SSH transport usernames but refuses URL suffixes that could persist secrets', () => {
    expect(validateCloneRepositoryUrl('git@example.com:Org/Repo.git')).toEqual({ ok: true });
    expect(validateCloneRepositoryUrl('ssh://git@example.com/Org/Repo.git')).toEqual({ ok: true });
    expect(validateCloneRepositoryUrl('https://example.com/Org/Repo.git?download=1').ok).toBe(false);
    expect(validateCloneRepositoryUrl('git@example.com:Org/Repo.git?access_token=secret').ok).toBe(false);
  });

  it('rejects a credential-shaped destination before any Git argv', async () => {
    const base = root();
    const testRig = rig(base);
    const calls: string[][] = [];
    testRig.deps.runSync = (cmd, args) => {
      calls.push([cmd, ...args]);
      return { status: 0, stdout: '', stderr: '' };
    };
    expect(await runClone(cloneArgs('https://example.com/org/repo.git', {
      destination: 'https://alice:destination-secret@example.com/path',
    }), testRig.deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(testRig.errors.join('')).not.toContain('destination-secret');
  });

  it('redacts credential-bearing Git diagnostics without rewriting safe argv', async () => {
    const base = root();
    const testRig = rig(base);
    const calls: string[][] = [];
    testRig.deps.runSync = (cmd, args) => {
      calls.push([cmd, ...args]);
      return {
        status: 128,
        stdout: '',
        stderr: 'fatal: redirected to https://example.com/repo.git?access_token=diagnostic-secret',
      };
    };
    expect(await runClone(cloneArgs('https://example.com/org/repo.git', { destination: 'checkout' }), testRig.deps)).toBe(1);
    expect(calls[0]).toEqual([
      'git', 'clone', '--', 'https://example.com/org/repo.git', join(base, 'checkouts', 'checkout'),
    ]);
    expect(testRig.errors.join('')).toContain('<redacted>');
    expect(testRig.errors.join('')).not.toContain('diagnostic-secret');
  });
});

describe('runClone', () => {
  it('fresh-clones and composes directly into quickstart in the checkout', async () => {
    const base = root();
    const source = sourceRepository(base);
    const testRig = rig(base);
    expect(await runClone(cloneArgs(source, { checkoutOnly: false }), testRig.deps)).toBe(0);
    const destination = join(base, 'checkouts', 'repo');
    expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('ready\n');
    expect(testRig.quickstart).toHaveBeenCalledWith(destination, { roles: [], yes: false });
    expect(testRig.cwd()).toBe(destination);
  });

  it('passes an explicit one-role plan straight to quickstart', async () => {
    const base = root();
    const source = sourceRepository(base);
    const testRig = rig(base);
    expect(await runClone(cloneArgs(source, {
      checkoutOnly: false,
      template: 'software-dev',
      roles: [{ slug: 'builder', count: 1 }],
      yes: true,
    }), testRig.deps)).toBe(0);
    expect(testRig.quickstart).toHaveBeenCalledWith(join(base, 'checkouts', 'repo'), {
      template: 'software-dev',
      roles: [{ slug: 'builder', count: 1 }],
      yes: true,
    });
  });

  it.each([
    [cloneArgs('/source', { checkoutOnly: false }), 'both --yes and --template'],
    [cloneArgs('/source', { checkoutOnly: false, template: 'software-dev' }), 'both --yes and --template'],
    [cloneArgs('/source', { checkoutOnly: false, yes: true }), 'both --yes and --template'],
  ] as const)('rejects an incomplete non-interactive full flow before filesystem or Git access', async (args, message) => {
    const base = root();
    const testRig = rig(base, vi.fn(async () => 0), false);
    const calls: string[] = [];
    testRig.deps.pathExists = (path) => { calls.push(path); return false; };
    testRig.deps.runSync = (cmd) => { calls.push(cmd); return { status: 0, stdout: '', stderr: '' }; };
    expect(await runClone(args, testRig.deps)).toBe(1);
    expect(calls).toEqual([]);
    expect(testRig.errors.join('')).toContain(message);
  });

  it('allows a complete non-interactive full flow', async () => {
    const base = root();
    const source = sourceRepository(base);
    const testRig = rig(base, vi.fn(async () => 0), false);
    expect(await runClone(cloneArgs(source, {
      checkoutOnly: false, template: 'software-dev', yes: true,
    }), testRig.deps)).toBe(0);
    expect(testRig.quickstart).toHaveBeenCalledOnce();
  });

  it('repeat-clone reuses only a matching origin', async () => {
    const base = root();
    const source = sourceRepository(base);
    const testRig = rig(base);
    expect(await runClone(cloneArgs(source), testRig.deps)).toBe(0);
    expect(await runClone(cloneArgs(source), testRig.deps)).toBe(0);
    expect(testRig.output.join('')).toContain('Reusing existing checkout');
    expect(readdirSync(join(base, 'checkouts'))).toEqual(['repo']);
  });

  it('reports an explicit remote mismatch and leaves the checkout untouched', async () => {
    const base = root();
    const source = sourceRepository(base);
    const other = join(base, 'remotes', 'other');
    mkdirSync(other, { recursive: true });
    expect(git(['clone', '-q', source, other], base).status).toBe(0);
    const testRig = rig(base);
    const destination = join(base, 'checkouts', 'checkout');
    expect(await runClone(cloneArgs(source, { destination }), testRig.deps)).toBe(0);
    expect(await runClone(cloneArgs(other, { destination }), testRig.deps)).toBe(1);
    expect(testRig.errors.join('')).toContain('remote mismatch');
    expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('ready\n');
  });

  it('uses a collision-safe default destination for a non-repository directory', async () => {
    const base = root();
    const source = sourceRepository(base);
    const testRig = rig(base);
    mkdirSync(join(base, 'checkouts', 'repo'));
    expect(await runClone(cloneArgs(source), testRig.deps)).toBe(0);
    expect(existsSync(join(base, 'checkouts', 'repo-2', '.git'))).toBe(true);
  });

  it('stops at a ready checkout with --no-launch', async () => {
    const base = root();
    const source = sourceRepository(base);
    const testRig = rig(base);
    expect(await runClone(cloneArgs(source, { destination: 'checkout' }), testRig.deps)).toBe(0);
    expect(testRig.quickstart).not.toHaveBeenCalled();
    expect(testRig.output.join('')).toContain('No cube or drone was created');
    expect(testRig.output.join('')).toContain('borg quickstart');
  });

  it('removes only a destination Borg created when clone fails', async () => {
    const base = root();
    const testRig = rig(base);
    const destination = join(base, 'checkouts', 'new-checkout');
    expect(await runClone(cloneArgs(join(base, 'missing'), { destination }), testRig.deps)).toBe(1);
    expect(existsSync(destination)).toBe(false);
    expect(testRig.errors.join('')).toContain(`the directory borg created at ${destination} was removed`);
  });

  it('preserves a pre-existing empty destination when clone fails', async () => {
    const base = root();
    const testRig = rig(base);
    const destination = join(base, 'checkouts', 'empty');
    mkdirSync(destination);
    expect(await runClone(cloneArgs(join(base, 'missing'), { destination }), testRig.deps)).toBe(1);
    expect(existsSync(destination)).toBe(true);
    expect(readdirSync(destination)).toEqual([]);
    expect(testRig.errors.join('')).toContain('was preserved');
  });

  it('keeps a successful checkout when quickstart fails and gives the recovery path', async () => {
    const base = root();
    const source = sourceRepository(base);
    const testRig = rig(base, vi.fn(async () => 1));
    expect(await runClone(cloneArgs(source, { checkoutOnly: false }), testRig.deps)).toBe(1);
    expect(existsSync(join(base, 'checkouts', 'repo', '.git'))).toBe(true);
    expect(testRig.errors.join('')).toContain('run `borg quickstart` again');
  });

  it.each([
    [130, 'cancellation'],
    [1, 'partial failure'],
  ])('reuses the checkout and converges after quickstart %s', async (firstCode) => {
    const base = root();
    const source = sourceRepository(base);
    const quickstart = vi.fn().mockResolvedValueOnce(firstCode).mockResolvedValueOnce(0);
    const testRig = rig(base, quickstart);
    const args = cloneArgs(source, { checkoutOnly: false });
    expect(await runClone(args, testRig.deps)).toBe(firstCode);
    testRig.deps.chdir(join(base, 'checkouts'));
    expect(await runClone(args, testRig.deps)).toBe(0);
    expect(testRig.output.join('')).toContain('Reusing existing checkout');
    expect(readdirSync(join(base, 'checkouts'))).toEqual(['repo']);
  });
});
