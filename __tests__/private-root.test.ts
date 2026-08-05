import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  borgConfigRoot,
  borgHomeRoot,
  ensurePrivateBorgConfigRoot,
} from '../src/private-root.js';

const fixtures: string[] = [];
const originalStateRoot = process.env.BORG_STATE_ROOT;

afterEach(async () => {
  if (originalStateRoot === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = originalStateRoot;
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(): Promise<{ base: string; root: string }> {
  const base = await mkdtemp(join(tmpdir(), 'borg-private-root-'));
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
