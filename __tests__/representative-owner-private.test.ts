import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bindingFor } from './fixtures/representative-mock-backend.js';

let root: string;
let owner: ReturnType<typeof import('../src/representative-owner.js').createRepresentativeOwner>;
const original = process.env.BORG_STATE_ROOT;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'representative-private-')));
  process.env.BORG_STATE_ROOT = root;
  vi.resetModules();
});
afterEach(async () => {
  await owner?.close().catch(() => {});
  if (original === undefined) delete process.env.BORG_STATE_ROOT;
  else process.env.BORG_STATE_ROOT = original;
  await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const { createRepresentativeOwner, representativeOwnerDeps } = await import('../src/representative-owner.js');
  const { streamLockPath } = await import('../src/stream-owner.js');
  const binding = bindingFor(join(root, 'work'));
  owner = createRepresentativeOwner();
  const namespace = join(root, '.config', 'borgmcp', 'representative-host-locks');
  const lock = streamLockPath(binding.cubeId, binding.representativeDroneId, representativeOwnerDeps(binding).locksDir);
  const outside = join(root, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await writeFile(join(outside, 'sentinel'), 'untouched', { mode: 0o600 });
  return { binding, namespace, lock, outside };
}

it.each(['symlink', 'mode'] as const)('refuses a static namespace %s before acquisition or status', async kind => {
  const f = await fixture();
  await mkdir(join(root, '.config', 'borgmcp'), { recursive: true, mode: 0o700 });
  if (kind === 'symlink') await symlink(f.outside, f.namespace);
  else { await mkdir(f.namespace, { mode: 0o700 }); await chmod(f.namespace, 0o777); }
  await expect(owner.ensure(f.binding)).rejects.toMatchObject({ code: 'REPRESENTATIVE_OWNERSHIP_REQUIRED' });
  await expect(owner.snapshot(f.binding)).rejects.toMatchObject({ code: 'REPRESENTATIVE_OWNERSHIP_REQUIRED' });
  expect(await readdir(f.outside)).toEqual(['sentinel']);
  expect(await readFile(join(f.outside, 'sentinel'), 'utf8')).toBe('untouched');
});

it('refresh never follows the predictable old temporary leaf symlink', async () => {
  const f = await fixture();
  await owner.ensure(f.binding);
  const record = JSON.parse(await readFile(join(f.lock, 'owner.json'), 'utf8'));
  await symlink(join(f.outside, 'sentinel'), join(f.lock, `owner.json.${record.processNonce}.tmp`));
  await owner.ensure(f.binding);
  expect(await readFile(join(f.outside, 'sentinel'), 'utf8')).toBe('untouched');
  expect(await readdir(f.outside)).toEqual(['sentinel']);
});

it('fresh lease directories are 0700 and records are 0600; absent status creates nothing', async () => {
  const f = await fixture();
  expect((await owner.snapshot(f.binding)).state).toBe('unowned');
  await expect(lstat(f.namespace)).rejects.toMatchObject({ code: 'ENOENT' });
  await owner.ensure(f.binding);
  for (const dir of [f.namespace, join(f.namespace, '..'), f.lock]) {
    expect((await lstat(dir)).mode & 0o777).toBe(0o700);
  }
  expect((await lstat(join(f.lock, 'owner.json'))).mode & 0o777).toBe(0o600);
});

it.each(['authority', 'cube', 'lease', 'owner', 'takeover'] as const)('refuses a static %s symlink on inspection and refresh', async level => {
  const f = await fixture();
  await owner.ensure(f.binding);
  const { dirname } = await import('node:path');
  const target = level === 'authority' ? dirname(dirname(f.lock))
    : level === 'cube' ? dirname(f.lock)
    : level === 'lease' ? f.lock
    : join(f.lock, level === 'owner' ? 'owner.json' : 'takeover.json');
  await rm(target, { recursive: true, force: true });
  await symlink(level === 'owner' || level === 'takeover' ? join(f.outside, 'sentinel') : f.outside, target);
  if (level !== 'takeover') {
    await expect(owner.snapshot(f.binding)).rejects.toMatchObject({ code: 'REPRESENTATIVE_OWNERSHIP_REQUIRED' });
  }
  await expect(owner.ensure(f.binding)).rejects.toMatchObject({ code: 'REPRESENTATIVE_OWNERSHIP_REQUIRED' });
  expect(await readFile(join(f.outside, 'sentinel'), 'utf8')).toBe('untouched');
  expect(await readdir(f.outside)).toEqual(['sentinel']);
});

it('refuses a collision at the random exclusive leaf without touching its target', async () => {
  vi.doMock('node:crypto', async importOriginal => ({
    ...await importOriginal<typeof import('node:crypto')>(),
    randomBytes: () => Buffer.from('112233445566', 'hex'),
  }));
  try {
    const f = await fixture();
    await owner.ensure(f.binding);
    await symlink(join(f.outside, 'sentinel'), join(f.lock, `owner.json.${process.pid}.112233445566.tmp`));
    await expect(owner.ensure(f.binding)).rejects.toMatchObject({ code: 'REPRESENTATIVE_OWNERSHIP_REQUIRED' });
    expect(await readFile(join(f.outside, 'sentinel'), 'utf8')).toBe('untouched');
  } finally { vi.doUnmock('node:crypto'); }
});

it('refuses a world-writable config ancestor without changing its mode', async () => {
  const f = await fixture();
  const config = join(root, '.config');
  await mkdir(config, { mode: 0o700 });
  await chmod(config, 0o777);
  await expect(owner.ensure(f.binding)).rejects.toMatchObject({ code: 'REPRESENTATIVE_OWNERSHIP_REQUIRED' });
  await expect(owner.snapshot(f.binding)).rejects.toMatchObject({ code: 'REPRESENTATIVE_OWNERSHIP_REQUIRED' });
  expect((await lstat(config)).mode & 0o777).toBe(0o777);
  expect(await readdir(config)).toEqual([]);
});
