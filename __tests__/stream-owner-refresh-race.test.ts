import { afterEach, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireStreamLease, readOwnershipSnapshot, streamLockPath } from '../src/stream-owner.js';

// Deterministic single-refresh schedule: the snapshot has opened the canonical
// lock directory; one real refresh renames it away, so the owner-leaf read gets
// a real ENOENT; the refresh then restores the same directory and succeeds.
const CUBE = '11111111-1111-4111-8111-111111111111', DRONE = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.doUnmock('node:fs/promises'); vi.resetModules();
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

it('reports the owner when one refresh restores the lock after a missing owner read', async () => {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'owner-restore-'))); roots.push(root);
  const lock = streamLockPath(CUBE, DRONE, root);
  let claimReady!: () => void, releaseWrite!: () => void;
  const claimed = new Promise<void>(resolve => claimReady = resolve), writeGate = new Promise<void>(resolve => releaseWrite = resolve);
  let pause = false, refresh: Promise<boolean> | undefined;
  const originalRead = fs.readFile.bind(fs);
  const deps = { locksDir: root, writeRecord: async (path: string, record: unknown) => {
    if (pause) { claimReady(); await writeGate; }
    const temp = join(path, 'owner.tmp'); await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 }); await fs.rename(temp, join(path, 'owner.json'));
  } };
  const lease = (await acquireStreamLease(CUBE, DRONE, 70_000, deps))!;
  let intercepted = false, missing = false;
  try {
    vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      if (!intercepted && args[0] === join(lock, 'owner.json')) {
        intercepted = true; pause = true; refresh = lease.refresh(); await claimed;
        let error: unknown;
        try { await originalRead(...args); } catch (e) { error = e; missing = (e as NodeJS.ErrnoException).code === 'ENOENT'; }
        releaseWrite(); expect(await refresh).toBe(true);
        if (error) throw error;
      }
      return originalRead(...args);
    }) as typeof fs.readFile);
    const snapshot = await readOwnershipSnapshot(CUBE, DRONE, deps);
    expect(intercepted && missing).toBe(true);
    expect(snapshot).toMatchObject({ state: 'owner', pid: process.pid });
  } finally { releaseWrite(); await refresh; await lease.release(); }
});

it('reports the owner for a private lease when one refresh restores the lock after a missing owner read', async () => {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'owner-private-restore-'))); roots.push(home);
  const root = join(home, '.config', 'borgmcp'), locksDir = join(root, 'locks');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const lock = streamLockPath(CUBE, DRONE, locksDir), deps = { locksDir, privateRoot: { root, boundary: home } };
  let claimReady!: () => void, releaseWrite!: () => void;
  const claimed = new Promise<void>(resolve => claimReady = resolve), gate = new Promise<void>(resolve => releaseWrite = resolve);
  let refresh: Promise<boolean> | undefined, intercepted = false, missing = false;
  const originalLstat = fs.lstat.bind(fs), originalRename = fs.rename.bind(fs);
  let hook = (...args: Parameters<typeof fs.lstat>) => originalLstat(...args);
  // The private reader imports lstat by name; route it through a replaceable hook.
  vi.doMock('node:fs/promises', () => ({ ...fs, lstat: (...args: Parameters<typeof fs.lstat>) => hook(...args) }));
  vi.resetModules();
  const owner = await import('../src/stream-owner.js');
  const lease = (await owner.acquireStreamLease(CUBE, DRONE, 70_000, deps))!;
  try {
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      await originalRename(from, to); if (from === lock) { claimReady(); await gate; }
    });
    hook = async (...args) => {
      if (!intercepted && args[0] === join(lock, 'owner.json')) {
        intercepted = true; refresh = lease.refresh(); await claimed;
        let error: unknown;
        try { await originalLstat(...args); } catch (e) { error = e; missing = (e as NodeJS.ErrnoException).code === 'ENOENT'; }
        releaseWrite(); expect(await refresh).toBe(true);
        if (error) throw error;
      }
      return originalLstat(...args);
    };
    const snapshot = await owner.readOwnershipSnapshot(CUBE, DRONE, deps);
    expect(intercepted && missing).toBe(true);
    expect(snapshot).toMatchObject({ state: 'owner', pid: process.pid });
  } finally { releaseWrite(); await refresh; await lease.release(); }
});
