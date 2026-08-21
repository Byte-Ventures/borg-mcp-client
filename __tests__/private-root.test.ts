import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  borgConfigRoot,
  borgHomeRoot,
  ensurePrivateBorgConfigRoot,
  ensurePrivateBorgConfigRootSync,
} from '../src/private-root.js';

const fixtures: string[] = [];
const originalStateRoot = process.env.BORG_STATE_ROOT;

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalStateRoot;
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('ensurePrivateBorgConfigRootSync', () => {
  it('rejects a non-canonical path', async () => {
    const { base } = await fixture();
    const nonCanonical = `${base}/missing/../root`;
    expect(() => ensurePrivateBorgConfigRootSync(nonCanonical)).toThrow(/not canonical/);
  });

  it.each(['symlink', 'file'] as const)('rejects a %s instead of a real directory', async (kind) => {
    const { base, root } = await fixture();
    await mkdir(join(base, '.config'), { mode: 0o700 });
    if (kind === 'symlink') {
      const target = join(base, 'target');
      await mkdir(target, { mode: 0o700 });
      await symlink(target, root);
    } else {
      await writeFile(root, 'not a directory');
    }

    expect(() => ensurePrivateBorgConfigRootSync(root)).toThrow(/real directory/);
  });

  it('rejects a root not owned by the current uid when uid checks are available', async () => {
    if (typeof process.getuid !== 'function') return;
    const { root } = await fixture();
    await mkdir(root, { recursive: true, mode: 0o700 });
    vi.spyOn(process, 'getuid').mockReturnValue(process.getuid() + 1);

    expect(() => ensurePrivateBorgConfigRootSync(root)).toThrow(/not owned by the current user/);
  });

  it('rejects a group or world-writable root', async () => {
    const { root } = await fixture();
    await mkdir(root, { recursive: true, mode: 0o777 });
    await chmod(root, 0o777);

    expect(() => ensurePrivateBorgConfigRootSync(root)).toThrow(/writable by other users/);
  });

  it('tightens a safe legacy mode to 0700', async () => {
    const { root } = await fixture();
    await mkdir(root, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);

    ensurePrivateBorgConfigRootSync(root);

    expect((await lstat(root)).mode & 0o777).toBe(0o700);
  });

  it('re-verifies the final directory mode after chmod', async () => {
    const { root } = await fixture();
    await mkdir(root, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);
    const chmodSync = fs.chmodSync;
    vi.spyOn(fs, 'chmodSync').mockImplementation((path, mode) => {
      chmodSync(path, mode);
      chmodSync(path, 0o755);
    });

    expect(() => ensurePrivateBorgConfigRootSync(root)).toThrow(/not private/);
  });
});

async function fixture(): Promise<{ base: string; root: string }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'borg-private-root-')));
  fixtures.push(base);
  return { base, root: join(base, '.config', 'borgmcp') };
}

describe('BORG_STATE_ROOT', () => {
  it('replaces the effective home root for all Borg-owned paths', async () => {
    const { base } = await fixture();
    process.env.BORG_STATE_ROOT = base;

    expect(borgHomeRoot()).toBe(base);
    expect(borgConfigRoot()).toBe(join(base, '.config', 'borgmcp'));
  });

  it('rejects a relative or non-canonical override', () => {
    process.env.BORG_STATE_ROOT = 'relative-state-root';
    expect(() => borgHomeRoot()).toThrow(/BORG_STATE_ROOT must be an absolute canonical path/);
  });

  it('rejects a symlink-valued override before any credential path is resolved', async () => {
    const { base } = await fixture();
    const target = join(base, 'target');
    const link = join(base, 'root-link');
    await mkdir(target, { recursive: true, mode: 0o700 });
    await symlink(target, link);
    process.env.BORG_STATE_ROOT = link;

    expect(() => borgHomeRoot()).toThrow(/BORG_STATE_ROOT must be an absolute canonical path/);
    expect(() => borgConfigRoot()).toThrow(/BORG_STATE_ROOT must be an absolute canonical path/);
  });
});

describe('ensurePrivateBorgConfigRoot', () => {
  it('creates an absent Borg root as 0700 under umask 022', async () => {
    const { root } = await fixture();
    const previous = process.umask(0o022);
    try {
      await ensurePrivateBorgConfigRoot(root);
    } finally {
      process.umask(previous);
    }
    expect((await lstat(root)).mode & 0o777).toBe(0o700);
  });

  it('tightens a safe legacy 0755 root without changing its contents', async () => {
    const { root } = await fixture();
    await mkdir(root, { recursive: true, mode: 0o755 });
    await chmod(root, 0o755);
    const marker = join(root, 'marker.txt');
    await writeFile(marker, 'preserve me');

    await ensurePrivateBorgConfigRoot(root);

    expect((await lstat(root)).mode & 0o777).toBe(0o700);
    expect(await readFile(marker, 'utf8')).toBe('preserve me');
  });

  it('rejects a group/world-writable root instead of repairing it', async () => {
    const { root } = await fixture();
    await mkdir(root, { recursive: true, mode: 0o777 });
    await chmod(root, 0o777);

    await expect(ensurePrivateBorgConfigRoot(root)).rejects.toThrow(/writable by other users/);
    expect((await lstat(root)).mode & 0o777).toBe(0o777);
  });

  it('rejects a symlink root', async () => {
    const { base, root } = await fixture();
    const target = join(base, 'target');
    await mkdir(target, { mode: 0o700 });
    await mkdir(join(base, '.config'), { mode: 0o700 });
    await symlink(target, root);

    await expect(ensurePrivateBorgConfigRoot(root)).rejects.toThrow(/real directory/);
  });
});
