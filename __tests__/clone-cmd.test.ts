import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runClone, validateCloneRepositoryUrl, type CloneDeps, type GitRunResult } from '../src/clone-cmd';

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'borg-clone-i4-'));
  roots.push(root);
  return root;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeSource(root: string, name: string, content = name): string {
  const source = join(root, name);
  mkdirSync(source, { recursive: true });
  git(['init', '-q', '-b', 'main', source], root);
  git(['config', 'user.email', 'borg-test@example.invalid'], source);
  git(['config', 'user.name', 'Borg Test'], source);
  writeFileSync(join(source, 'README.md'), `${content}\n`);
  git(['add', 'README.md'], source);
  git(['commit', '-q', '-m', 'initial'], source);
  return source;
}

function realRunner(output: string[], errors: string[], cwd: string): CloneDeps {
  return {
    cwd: () => cwd,
    runSync: (cmd, args, commandCwd): GitRunResult => {
      const result = spawnSync(cmd, args, {
        cwd: commandCwd ?? cwd,
        encoding: 'utf8',
      });
      return {
        status: result.status,
        stdout: result.stdout ?? '',
        stderr: result.stderr ?? '',
      };
    },
    pathExists: existsSync,
    isDirectory: (path) => {
      try { return statSync(path).isDirectory(); } catch { return false; }
    },
    readDirectory: readdirSync,
    removeTree: (path) => rmSync(path, { recursive: true, force: true }),
    mkdirp: (path) => mkdirSync(path, { recursive: true }),
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  };
}

describe('borg clone flow', () => {
  it('accepts SSH transport identity but rejects embedded HTTPS credentials', () => {
    expect(validateCloneRepositoryUrl('ssh://git@github.com/example/project.git')).toEqual({ ok: true });
    expect(validateCloneRepositoryUrl('git@github.com:example/project.git')).toEqual({ ok: true });
    expect(validateCloneRepositoryUrl('https://token@example.com/example/project.git')).toMatchObject({ ok: false });
    expect(validateCloneRepositoryUrl('https://example.com/example/project.git?access_token=secret')).toMatchObject({ ok: false });
  });

  it('fresh-clones, creates a sibling worktree, and leaves it ready with --no-launch', async () => {
    const root = makeRoot();
    const source = makeSource(root, 'source');
    const destination = join(root, 'checkout');
    const output: string[] = [];
    const errors: string[] = [];
    const launch = vi.fn(async () => 0);

    const code = await runClone({
      repositoryUrl: source,
      flags: { destination, name: 'worker', noLaunch: true },
    }, { ...realRunner(output, errors, root), launch });

    expect(code).toBe(0);
    expect(existsSync(join(destination, '.git'))).toBe(true);
    expect(existsSync(join(root, 'worker'))).toBe(true);
    expect(git(['branch', '--show-current'], join(root, 'worker')).trim()).toBe('wt-worker');
    expect(output.join('')).toContain('No agent launched');
    expect(output.join('')).toContain('cd ');
    expect(output.join('')).toContain('&& borg');
    expect(launch).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  });

  it('repeat-clone reuses the matching checkout and existing worktree', async () => {
    const root = makeRoot();
    const source = makeSource(root, 'source');
    const destination = join(root, 'checkout');
    const firstOutput: string[] = [];
    const firstErrors: string[] = [];
    const deps = realRunner(firstOutput, firstErrors, root);
    const args = { repositoryUrl: source, flags: { destination, name: 'worker', noLaunch: true } } as const;

    expect(await runClone(args, deps)).toBe(0);
    const secondOutput: string[] = [];
    const secondErrors: string[] = [];
    expect(await runClone(args, { ...realRunner(secondOutput, secondErrors, root) })).toBe(0);

    expect(secondOutput.join('')).toContain('Reusing existing checkout');
    expect(secondOutput.join('')).toContain('Reusing sibling worktree');
    expect(readdirSync(root).filter((entry) => entry.startsWith('worker'))).toEqual(['worker']);
    expect(secondErrors).toEqual([]);
  });

  it('reports both remotes and preserves an existing checkout on mismatch', async () => {
    const root = makeRoot();
    const sourceA = makeSource(root, 'source-a', 'A');
    const sourceB = makeSource(root, 'source-b', 'B');
    const destination = join(root, 'checkout');
    const firstOutput: string[] = [];
    const firstErrors: string[] = [];
    expect(await runClone({ repositoryUrl: sourceA, flags: { destination, noLaunch: true } }, realRunner(firstOutput, firstErrors, root))).toBe(0);

    const output: string[] = [];
    const errors: string[] = [];
    expect(await runClone({ repositoryUrl: sourceB, flags: { destination, noLaunch: true } }, realRunner(output, errors, root))).toBe(1);
    expect(errors.join('')).toContain('remote mismatch');
    expect(errors.join('')).toContain(sourceA);
    expect(errors.join('')).toContain(sourceB);
    expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('A\n');
  });

  it('discloses a collision and chooses a safe sibling name', async () => {
    const root = makeRoot();
    const source = makeSource(root, 'source');
    const destination = join(root, 'checkout');
    mkdirSync(join(root, 'worker'), { recursive: true });
    const output: string[] = [];
    const errors: string[] = [];

    expect(await runClone({
      repositoryUrl: source,
      flags: { destination, name: 'worker', noLaunch: true },
    }, realRunner(output, errors, root))).toBe(0);

    expect(output.join('')).toContain('using "worker-2" instead');
    expect(existsSync(join(root, 'worker-2'))).toBe(true);
    expect(git(['branch', '--show-current'], join(root, 'worker-2')).trim()).toBe('wt-worker-2');
  });

  it('uses an explicit branch for the sibling worktree', async () => {
    const root = makeRoot();
    const source = makeSource(root, 'source');
    const output: string[] = [];
    const errors: string[] = [];

    expect(await runClone({
      repositoryUrl: source,
      flags: { destination: join(root, 'checkout'), name: 'worker', branch: 'feature/reviewer', noLaunch: true },
    }, realRunner(output, errors, root))).toBe(0);
    expect(git(['branch', '--show-current'], join(root, 'worker')).trim()).toBe('feature/reviewer');
    expect(errors).toEqual([]);
  });

  it('keeps a no-authority launch behind an injected process seam', async () => {
    const root = makeRoot();
    const source = makeSource(root, 'source');
    const output: string[] = [];
    const errors: string[] = [];
    let launchedAt: string | undefined;
    const launch = vi.fn(async (cwd: string) => {
      launchedAt = cwd;
      return 0;
    });

    expect(await runClone({ repositoryUrl: source, flags: { destination: join(root, 'checkout'), noLaunch: false } }, {
      ...realRunner(output, errors, root),
      launch,
    })).toBe(0);
    expect(launch).toHaveBeenCalledOnce();
    expect(launchedAt).toBe(join(root, 'source-worktree'));
    expect(errors).toEqual([]);
  });

  it('rolls back a real failed clone', async () => {
    const root = makeRoot();
    const destination = join(root, 'checkout');
    const output: string[] = [];
    const errors: string[] = [];

    expect(await runClone({
      repositoryUrl: join(root, 'does-not-exist'),
      flags: { destination, noLaunch: true },
    }, realRunner(output, errors, root))).toBe(1);
    expect(existsSync(destination)).toBe(false);
    expect(errors.join('')).toMatch(/clone failed|rollback/i);
    expect(errors.join('')).toContain('removed partial checkout');
  });

  it('rolls back a cloned checkout when an injected worktree step fails', async () => {
    const root = makeRoot();
    const source = makeSource(root, 'source');
    const destination = join(root, 'checkout');
    const output: string[] = [];
    const errors: string[] = [];
    const base = realRunner(output, errors, root);
    const runSync = vi.fn((cmd: string, args: string[], cwd?: string): GitRunResult => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        return { status: 1, stdout: '', stderr: 'injected worktree failure' };
      }
      return base.runSync!(cmd, args, cwd);
    });

    expect(await runClone({ repositoryUrl: source, flags: { destination, noLaunch: true } }, { ...base, runSync })).toBe(1);
    expect(existsSync(destination)).toBe(false);
    expect(errors.join('')).toContain('injected worktree failure');
    expect(errors.join('')).toContain('Rollback:');
  });

  it('rejects credentials before argv, logs, or Git metadata can receive them', async () => {
    const root = makeRoot();
    const secret = 'clone-secret-317';
    const credentialUrl = `https://alice:${secret}@example.com/org/repo.git`;
    const output: string[] = [];
    const errors: string[] = [];
    const runSync = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    const capturedArgv = ['git', 'clone', credentialUrl, join(root, 'checkout')];
    const capturedLog = `git clone ${credentialUrl}`;
    const capturedMetadata = { origin: credentialUrl };

    // Positive controls: the instrument detects a planted credential in all
    // three surfaces before the product absence assertion is made.
    expect(JSON.stringify(capturedArgv)).toContain(secret);
    expect(capturedLog).toContain(secret);
    expect(JSON.stringify(capturedMetadata)).toContain(secret);

    expect(await runClone({ repositoryUrl: credentialUrl, flags: { destination: join(root, 'checkout'), noLaunch: true } }, {
      ...realRunner(output, errors, root),
      runSync,
    })).toBe(1);
    expect(runSync).not.toHaveBeenCalled();
    expect(output.join('')).not.toContain(secret);
    expect(errors.join('')).not.toContain(secret);
    expect(existsSync(join(root, 'checkout'))).toBe(false);
  });
});
