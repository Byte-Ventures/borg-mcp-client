import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
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

  it('explains cwd-repository recovery when the requested remote mismatches', async () => {
    const root = makeRoot();
    const current = makeSource(root, 'current', 'current');
    const requested = makeSource(root, 'requested', 'requested');
    git(['remote', 'add', 'origin', current], current);
    const output: string[] = [];
    const errors: string[] = [];

    expect(await runClone({
      repositoryUrl: requested,
      flags: { noLaunch: true },
    }, realRunner(output, errors, current))).toBe(1);
    expect(errors.join('')).toContain('used the existing repository in your current directory');
    expect(errors.join('')).toContain('--destination');
    expect(errors.join('')).toContain('empty directory');
    expect(errors.join('')).toContain('left untouched');
    expect(errors.join('')).not.toContain('inspect and repair');
  });

  it.each([
    ['SSH user', 'ssh://alice@example.com:8443/Org/Repo.git', 'ssh://bob@example.com:8443/Org/Repo.git'],
    ['port', 'https://example.com:8443/Org/Repo.git', 'https://example.com/Org/Repo.git'],
    ['path case', 'https://example.com/Org/Repo.git', 'https://example.com/org/repo.git'],
  ])('does not reuse a checkout when remote identity differs by %s', async (_reason, actualOrigin, requestedOrigin) => {
    const root = makeRoot();
    const destination = join(root, 'checkout');
    makeSource(root, 'seed');
    git(['init', '-q', '-b', 'main', destination], root);
    git(['config', 'user.email', 'borg-test@example.invalid'], destination);
    git(['config', 'user.name', 'Borg Test'], destination);
    writeFileSync(join(destination, 'README.md'), 'existing\n');
    git(['add', 'README.md'], destination);
    git(['commit', '-q', '-m', 'initial'], destination);
    git(['remote', 'add', 'origin', actualOrigin], destination);

    const output: string[] = [];
    const errors: string[] = [];
    expect(await runClone({
      repositoryUrl: requestedOrigin,
      flags: { destination, noLaunch: true },
    }, realRunner(output, errors, root))).toBe(1);
    expect(errors.join('')).toContain('remote mismatch');
    expect(output.join('')).not.toContain('remote matches');
    expect(readFileSync(join(destination, 'README.md'), 'utf8')).toBe('existing\n');
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
    expect(errors.join('')).toContain(`destination ${destination} was not created`);
    expect(errors.join('')).not.toContain('removed partial checkout');
  });

  it('removes nested parents it created when a clone fails before creating a destination', async () => {
    const root = makeRoot();
    const destination = join(root, 'nested', 'deep', 'checkout');
    const output: string[] = [];
    const errors: string[] = [];

    expect(await runClone({
      repositoryUrl: join(root, 'does-not-exist'),
      flags: { destination, noLaunch: true },
    }, realRunner(output, errors, root))).toBe(1);
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(join(root, 'nested'))).toBe(false);
    expect(errors.join('')).toContain('created parent');
    expect(errors.join('')).toContain(`destination ${destination} was not created`);
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

  it('redacts a credential-bearing Git worktree diagnostic separately from clone failure', async () => {
    const root = makeRoot();
    const source = makeSource(root, 'source');
    const destination = join(root, 'checkout');
    const secret = 'worktree-secret-317';
    const output: string[] = [];
    const errors: string[] = [];
    const base = realRunner(output, errors, root);
    let rawDiagnostic = '';
    const runSync = vi.fn((cmd: string, args: string[], cwd?: string): GitRunResult => {
      if (cmd === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        rawDiagnostic = `fatal: redirected to https://example.com/org/repo.git?access_token=${secret}`;
        return {
          status: 1,
          stdout: '',
          stderr: rawDiagnostic,
        };
      }
      return base.runSync!(cmd, args, cwd);
    });

    expect(await runClone({
      repositoryUrl: source,
      flags: { destination, noLaunch: true },
    }, { ...base, runSync })).toBe(1);
    expect(rawDiagnostic).toContain(secret);
    expect(errors.join('')).toContain('<redacted>');
    expect(errors.join('')).not.toContain(secret);
  });

  it('removes a branch and registration left by a real failed worktree checkout', async () => {
    const root = makeRoot();
    const source = makeSource(root, 'source');
    const destination = join(root, 'checkout');
    const worktree = join(root, 'source-worktree');
    const branch = 'wt-source-worktree';
    const output: string[] = [];
    const errors: string[] = [];
    const base = realRunner(output, errors, root);
    const runSync = vi.fn((cmd: string, args: string[], cwd?: string): GitRunResult => {
      const result = base.runSync!(cmd, args, cwd);
      if (cmd === 'git' && args[0] === 'clone' && result.status === 0) {
        const hook = join(destination, '.git', 'hooks', 'post-checkout');
        writeFileSync(hook, '#!/bin/sh\nexit 17\n');
        chmodSync(hook, 0o755);
      }
      return result;
    });

    expect(await runClone({
      repositoryUrl: source,
      flags: { destination, noLaunch: true },
    }, { ...base, runSync })).toBe(1);
    expect(existsSync(destination)).toBe(false);
    expect(existsSync(worktree)).toBe(false);
    expect(spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], {
      cwd: root,
    }).status).not.toBe(0);
    expect(spawnSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: destination,
    }).status).not.toBe(0);
    expect(errors.join('')).toContain(`branch ${branch}`);
    expect(errors.join('')).toContain('Rollback:');
  });

  it('does not reuse an unrelated registered worktree branch', async () => {
    const root = makeRoot();
    const source = makeSource(root, 'source');
    const destination = join(root, 'checkout');
    const firstOutput: string[] = [];
    const firstErrors: string[] = [];
    expect(await runClone({
      repositoryUrl: source,
      flags: { destination, name: 'worker', branch: 'unrelated', noLaunch: true },
    }, realRunner(firstOutput, firstErrors, root))).toBe(0);

    const output: string[] = [];
    const errors: string[] = [];
    expect(await runClone({
      repositoryUrl: source,
      flags: { destination, name: 'worker', noLaunch: true },
    }, realRunner(output, errors, root))).toBe(0);
    expect(output.join('')).toContain('using "worker-2" instead');
    expect(git(['branch', '--show-current'], join(root, 'worker')).trim()).toBe('unrelated');
    expect(git(['branch', '--show-current'], join(root, 'worker-2')).trim()).toBe('wt-worker-2');
    expect(errors).toEqual([]);
  });

  it('rejects credentials before argv, logs, or Git metadata can receive them', async () => {
    const root = makeRoot();
    const secret = 'clone-secret-317';
    const credentialUrl = `https://alice:${secret}@example.com/org/repo.git`;
    const output: string[] = [];
    const errors: string[] = [];
    const runSync = vi.fn(() => ({ status: 0, stdout: '', stderr: '' }));

    expect(await runClone({ repositoryUrl: credentialUrl, flags: { destination: join(root, 'checkout'), noLaunch: true } }, {
      ...realRunner(output, errors, root),
      runSync,
    })).toBe(1);
    expect(runSync).not.toHaveBeenCalled();
    expect(output.join('')).not.toContain(secret);
    expect(errors.join('')).not.toContain(secret);
    expect(existsSync(join(root, 'checkout'))).toBe(false);
  });

  it('redacts credential-shaped invalid names at the clone call site', async () => {
    const root = makeRoot();
    const secret = 'name-secret-317';
    const errors: string[] = [];

    expect(await runClone({
      repositoryUrl: join(root, 'source'),
      flags: {
        name: `https://alice:${secret}@example.com/org/repo.git`,
        noLaunch: true,
      },
    }, { ...realRunner([], errors, root), runSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' })) })).toBe(1);
    expect(errors.join('')).toContain('invalid name');
    expect(errors.join('')).not.toContain(secret);
  });

  it('refuses credential-shaped branches before Git argv validation', async () => {
    const root = makeRoot();
    const secret = 'branch-secret-317';
    const branches = [
      `https://alice:${secret}@example.com/org/repo.git`,
      `oauth2:${secret}@host:org/repo.git`,
      `https://example.com/org/repo.git?access_token=${secret}`,
    ];

    for (const branch of branches) {
      const errors: string[] = [];
      const calls: string[][] = [];
      const runSync = vi.fn((cmd: string, args: string[]): GitRunResult => {
        calls.push([cmd, ...args]);
        return { status: 1, stdout: '', stderr: '' };
      });
      expect(await runClone({
        repositoryUrl: join(root, 'source'),
        flags: { branch, noLaunch: true },
      }, { ...realRunner([], errors, root), runSync })).toBe(1);
      expect(calls.some((call) => call.includes('check-ref-format'))).toBe(false);
      expect(errors.join('')).toContain('invalid branch name');
      expect(errors.join('')).not.toContain(secret);
    }
  });

  it('passes an ordinary branch argument to Git byte-identically', async () => {
    const root = makeRoot();
    const calls: string[][] = [];
    const runSync = vi.fn((cmd: string, args: string[]): GitRunResult => {
      calls.push([cmd, ...args]);
      return { status: 1, stdout: '', stderr: '' };
    });

    expect(await runClone({
      repositoryUrl: join(root, 'source'),
      flags: { branch: 'feature/reviewer', noLaunch: true },
    }, { ...realRunner([], [], root), runSync })).toBe(1);
    expect(calls).toEqual([['git', 'check-ref-format', '--branch', 'feature/reviewer']]);
  });

  it('fails closed on an unparseable credential-shaped existing origin', async () => {
    const root = makeRoot();
    const destination = makeSource(root, 'checkout');
    const secret = 'malformed-secret-317';
    const malformedOrigin = `oauth2:${secret}@host:org/repo.git`;
    git(['remote', 'add', 'origin', malformedOrigin], destination);
    const errors: string[] = [];

    expect(await runClone({
      repositoryUrl: 'https://example.com/org/repo.git',
      flags: { destination, noLaunch: true },
    }, realRunner([], errors, root))).toBe(1);
    expect(errors.join('')).toContain('credential-bearing origin remote');
    expect(errors.join('')).not.toContain(secret);
  });

  it('redacts credentials from a Git-followed URL in the actual diagnostic path', async () => {
    const root = makeRoot();
    const secret = 'followed-secret-317';
    const output: string[] = [];
    const errors: string[] = [];
    const capturedArgv: string[][] = [];
    const runSync = vi.fn((cmd: string, args: string[]): GitRunResult => {
      capturedArgv.push([cmd, ...args]);
      if (args[0] === 'clone') {
        return {
          status: 128,
          stdout: '',
          stderr: `fatal: redirected to https://example.com/org/repo.git?access_token=${secret}`,
        };
      }
      return { status: 1, stdout: '', stderr: '' };
    });

    expect(await runClone({
      repositoryUrl: 'https://example.com/org/repo.git',
      flags: { destination: join(root, 'checkout'), noLaunch: true },
    }, {
      ...realRunner(output, errors, root),
      runSync,
    })).toBe(1);
    expect(capturedArgv.find((args) => args[1] === 'clone')).toEqual([
      'git', 'clone', 'https://example.com/org/repo.git', join(root, 'checkout'),
    ]);
    expect(errors.join('')).toContain('<redacted>');
    expect(errors.join('')).not.toContain(secret);
  });

  it('validates that argv, output, and Git metadata instruments can each observe a planted value', async () => {
    const root = makeRoot();
    const argvSecret = 'argv-secret-317';
    const argv: string[][] = [];
    const argvErrors: string[] = [];
    const argvRunSync = vi.fn((cmd: string, args: string[]): GitRunResult => {
      argv.push([cmd, ...args]);
      return { status: 1, stdout: '', stderr: '' };
    });
    await runClone({
      repositoryUrl: join(root, `source-${argvSecret}`),
      flags: { destination: join(root, 'argv-checkout'), noLaunch: true },
    }, { ...realRunner([], argvErrors, root), runSync: argvRunSync });
    expect(argv.flat().join(' ')).toContain(argvSecret);

    const logSecret = 'log-secret-317';
    const logErrors: string[] = [];
    let rawLog = '';
    const logRunSync = vi.fn((cmd: string, args: string[]): GitRunResult => {
      if (args[0] === 'clone') {
        rawLog = `fatal: redirected to https://example.com/org/repo.git?access_token=${logSecret}`;
        return { status: 1, stdout: '', stderr: rawLog };
      }
      return { status: 1, stdout: '', stderr: '' };
    });
    await runClone({
      repositoryUrl: join(root, 'source-log'),
      flags: { destination: join(root, 'log-checkout'), noLaunch: true },
    }, { ...realRunner([], logErrors, root), runSync: logRunSync });
    expect(rawLog).toContain(logSecret);
    expect(logErrors.join('')).not.toContain(logSecret);

    const metadataSecret = 'metadata-secret-317';
    const source = makeSource(root, `source-${metadataSecret}`);
    const metadataDestination = join(root, 'metadata-checkout');
    expect(await runClone({
      repositoryUrl: source,
      flags: { destination: metadataDestination, noLaunch: true },
    }, realRunner([], [], root))).toBe(0);
    expect(readFileSync(join(metadataDestination, '.git', 'config'), 'utf8')).toContain(metadataSecret);
  });
});
