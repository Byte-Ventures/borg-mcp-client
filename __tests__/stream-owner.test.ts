import { access, mkdir, mkdtemp, readFile, rename as fsRename, rm, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireStreamLease,
  readOwnershipSnapshot,
  streamLockPath,
} from '../src/stream-owner';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '22222222-2222-4222-8222-222222222222';
const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function tempLocksDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'borg-stream-owner-'));
  tempDirectories.push(directory);
  return directory;
}

describe('stream-owner lease', () => {
  it('reclaims a durable empty initialization directory', async () => {
    const locksDir = await tempLocksDir();
    const lockPath = streamLockPath(CUBE_ID, DRONE_ID, locksDir);
    await mkdir(lockPath, { recursive: true });
    const old = new Date('2026-05-28T11:59:00.000Z');
    await utimes(lockPath, old, old);

    const before = await readOwnershipSnapshot(CUBE_ID, DRONE_ID, {
      locksDir,
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    });
    expect(before.state).toBe('orphaned-initialization');

    const lease = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1001,
      processNonce: 'replacement',
      cwd: '/work/replacement',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    });
    expect(lease).not.toBeNull();
    expect((await readOwnershipSnapshot(CUBE_ID, DRONE_ID, {
      locksDir,
      pid: 1001,
      processNonce: 'replacement',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    })).state).toBe('owner');
  });

  it('does not reclaim a fresh owner directory while initialization may still be in flight', async () => {
    const locksDir = await tempLocksDir();
    const lockPath = streamLockPath(CUBE_ID, DRONE_ID, locksDir);
    await mkdir(lockPath, { recursive: true });
    const fresh = new Date('2026-05-28T12:00:00.000Z');
    await utimes(lockPath, fresh, fresh);

    const snapshot = await readOwnershipSnapshot(CUBE_ID, DRONE_ID, {
      locksDir,
      now: () => new Date('2026-05-28T12:00:01.000Z'),
    });
    expect(snapshot.state).toBe('initializing');
    expect(await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1002,
      processNonce: 'contender',
      now: () => new Date('2026-05-28T12:00:01.000Z'),
    })).toBeNull();
  });

  it('restores an orphan candidate when an owner appears during takeover verification', async () => {
    const locksDir = await tempLocksDir();
    const lockPath = streamLockPath(CUBE_ID, DRONE_ID, locksDir);
    await mkdir(lockPath, { recursive: true });
    const old = new Date('2026-05-28T11:59:00.000Z');
    await utimes(lockPath, old, old);

    const lease = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1002,
      processNonce: 'contender',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
      beforeTakeoverVerify: async (takeoverPath) => {
        await writeFile(path.join(takeoverPath, 'owner.json'), JSON.stringify({
          schemaVersion: 1,
          pid: 1001,
          processNonce: 'late-owner',
          cwd: '/work/late',
          startedAt: '2026-05-28T11:59:59.000Z',
          heartbeatAt: '2026-05-28T12:00:00.000Z',
        }) + '\n');
      },
    });
    expect(lease).toBeNull();
    expect((await readOwnershipSnapshot(CUBE_ID, DRONE_ID, {
      locksDir,
      pid: 1002,
      processNonce: 'contender',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    })).processNonce).toBe('late-owner');
  });

  it('cleans up a directory when initial owner-record creation fails', async () => {
    const locksDir = await tempLocksDir();
    const lockPath = streamLockPath(CUBE_ID, DRONE_ID, locksDir);
    await expect(acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1001,
      processNonce: 'failed-initializer',
      writeRecord: async () => { throw Object.assign(new Error('disk write failed'), { code: 'EIO' }); },
    })).rejects.toThrow('disk write failed');
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('allows only one owner for a cube/drone lease', async () => {
    const locksDir = await tempLocksDir();
    const first = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1001,
      processNonce: 'first',
      cwd: '/work/a',
      worktree: '/work/repo-builder',
      droneLabel: 'builder-1',
      cubeName: 'repo',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    });
    const second = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1002,
      processNonce: 'second',
      cwd: '/work/b',
      now: () => new Date('2026-05-28T12:00:01.000Z'),
    });

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    const snapshot = await readOwnershipSnapshot(CUBE_ID, DRONE_ID, {
      locksDir,
      pid: 1002,
      processNonce: 'second',
      now: () => new Date('2026-05-28T12:00:01.000Z'),
    });
    expect(snapshot.state).toBe('owned-by-other-process');
    expect(snapshot.pid).toBe(1001);
    expect(snapshot.cwd).toBe('/work/a');
    expect(snapshot.worktree).toBe('/work/repo-builder');
    expect(snapshot.droneLabel).toBe('builder-1');
  });

  it('reclaims a stale lease', async () => {
    const locksDir = await tempLocksDir();
    const first = await acquireStreamLease(CUBE_ID, DRONE_ID, 1_000, {
      locksDir,
      pid: 1001,
      processNonce: 'first',
      cwd: '/work/a',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    });
    expect(first).not.toBeNull();

    const second = await acquireStreamLease(CUBE_ID, DRONE_ID, 1_000, {
      locksDir,
      pid: 1002,
      processNonce: 'second',
      cwd: '/work/b',
      now: () => new Date('2026-05-28T12:00:03.000Z'),
    });
    expect(second).not.toBeNull();

    const snapshot = await readOwnershipSnapshot(CUBE_ID, DRONE_ID, {
      locksDir,
      pid: 1002,
      processNonce: 'second',
      now: () => new Date('2026-05-28T12:00:03.000Z'),
    });
    expect(snapshot.state).toBe('owner');
    expect(snapshot.pid).toBe(1002);
  });

  it('does not reclaim when the moved-aside owner changed before verification', async () => {
    const locksDir = await tempLocksDir();
    const first = await acquireStreamLease(CUBE_ID, DRONE_ID, 1_000, {
      locksDir,
      pid: 1001,
      processNonce: 'first',
      cwd: '/work/a',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    });
    expect(first).not.toBeNull();

    const second = await acquireStreamLease(CUBE_ID, DRONE_ID, 1_000, {
      locksDir,
      pid: 1002,
      processNonce: 'second',
      cwd: '/work/b',
      now: () => new Date('2026-05-28T12:00:03.000Z'),
      beforeTakeoverVerify: async (takeoverPath) => {
        await writeFile(
          path.join(takeoverPath, 'owner.json'),
          JSON.stringify(
            {
              schemaVersion: 1,
              pid: 1001,
              processNonce: 'first',
              cwd: '/work/a',
              startedAt: '2026-05-28T12:00:00.000Z',
              heartbeatAt: '2026-05-28T12:00:03.000Z',
            },
            null,
            2
          ) + '\n',
          'utf8'
        );
      },
    });

    expect(second).toBeNull();
    const snapshot = await readOwnershipSnapshot(CUBE_ID, DRONE_ID, {
      locksDir,
      pid: 1002,
      processNonce: 'second',
      now: () => new Date('2026-05-28T12:00:03.000Z'),
    });
    expect(snapshot.state).toBe('owned-by-other-process');
    expect(snapshot.pid).toBe(1001);
    expect(snapshot.heartbeatAt).toBe('2026-05-28T12:00:03.000Z');
  });

  it('uses pid-dead as an extra reclaim signal', async () => {
    const locksDir = await tempLocksDir();
    const first = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1001,
      processNonce: 'first',
      cwd: '/work/a',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    });
    expect(first).not.toBeNull();

    const second = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1002,
      processNonce: 'second',
      cwd: '/work/b',
      now: () => new Date('2026-05-28T12:00:01.000Z'),
      isPidAlive: (pid) => pid !== 1001,
    });
    expect(second).not.toBeNull();
  });

  it('uses the production PID probe to reclaim a dead owner within one acquisition', async () => {
    const locksDir = await tempLocksDir();
    const first = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 99_999_999,
      processNonce: 'dead-owner',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    });
    expect(first).not.toBeNull();

    const successor = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      now: () => new Date('2026-05-28T12:00:01.000Z'),
    });

    expect(successor).not.toBeNull();
    expect(successor!.record.pid).toBe(process.pid);
  });

  it('lets a fresh process acquire immediately after the owning process is killed', async () => {
    const locksDir = await tempLocksDir();
    const child = spawn(process.execPath, [
      '--import',
      'tsx',
      path.join(process.cwd(), '__tests__', 'fixtures', 'stream-owner-child.ts'),
      CUBE_ID,
      DRONE_ID,
      locksDir,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.stdout!.on('data', (chunk) => {
          if (String(chunk).includes('READY')) resolve();
        });
        child.once('exit', (code) => reject(new Error(`owner child exited early (${code})`)));
      });
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;

      expect(() => process.kill(child.pid!, 0)).toThrow();
      const deadOwner = await readOwnershipSnapshot(CUBE_ID, DRONE_ID, { locksDir });
      expect(deadOwner.pid).toBe(child.pid);

      const successor = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, { locksDir });
      expect(successor).not.toBeNull();
      expect(successor!.record.pid).toBe(process.pid);
      await successor!.release();
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('recovers a takeover claimant that dies after publishing its durable claim', async () => {
    const locksDir = await tempLocksDir();
    await acquireStreamLease(CUBE_ID, DRONE_ID, 1_000, {
      locksDir,
      pid: 1001,
      processNonce: 'dead-owner',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    });

    await expect(acquireStreamLease(CUBE_ID, DRONE_ID, 1_000, {
      locksDir,
      pid: 1002,
      processNonce: 'dead-claimant',
      now: () => new Date('2026-05-28T12:00:03.000Z'),
      isPidAlive: () => false,
      beforeTakeoverVerify: async () => {
        throw new Error('claimant crashed');
      },
    })).rejects.toThrow('claimant crashed');

    const successor = await acquireStreamLease(CUBE_ID, DRONE_ID, 1_000, {
      locksDir,
      pid: 1003,
      processNonce: 'successor',
      now: () => new Date('2026-05-28T12:00:04.000Z'),
      isPidAlive: (pid) => pid === 1003,
    });
    expect(successor).not.toBeNull();
    expect(successor!.record.processNonce).toBe('successor');
  });

  it('does not bypass a live takeover claimant', async () => {
    const locksDir = await tempLocksDir();
    await acquireStreamLease(CUBE_ID, DRONE_ID, 1_000, {
      locksDir,
      pid: 1001,
      processNonce: 'stale-owner',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    });

    let releaseClaim!: () => void;
    let markClaimReady!: () => void;
    const claimReady = new Promise<void>((resolve) => { markClaimReady = resolve; });
    const claimRelease = new Promise<void>((resolve) => { releaseClaim = resolve; });
    const claimant = acquireStreamLease(CUBE_ID, DRONE_ID, 1_000, {
      locksDir,
      pid: 1002,
      processNonce: 'live-claimant',
      now: () => new Date('2026-05-28T12:00:03.000Z'),
      isPidAlive: (pid) => pid === 1002,
      beforeTakeoverVerify: async () => {
        markClaimReady();
        await claimRelease;
      },
    });
    await claimReady;

    await expect(acquireStreamLease(CUBE_ID, DRONE_ID, 1_000, {
      locksDir,
      pid: 1003,
      processNonce: 'contender',
      now: () => new Date('2026-05-28T12:00:03.500Z'),
      isPidAlive: (pid) => pid === 1002 || pid === 1003,
    })).resolves.toBeNull();

    releaseClaim();
    await expect(claimant).resolves.not.toBeNull();
  });

  it('handles corrupt lease payload conservatively and reclaims it as stale', async () => {
    const locksDir = await tempLocksDir();
    const lockPath = streamLockPath(CUBE_ID, DRONE_ID, locksDir);
    await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1001,
      processNonce: 'first',
      cwd: '/work/a',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
    });
    await writeFile(path.join(lockPath, 'owner.json'), '{not-json\n', 'utf8');

    const snapshot = await readOwnershipSnapshot(CUBE_ID, DRONE_ID, { locksDir });
    expect(snapshot.state).toBe('owned-by-other-process');
    expect(snapshot.ageMs).toBe(Number.POSITIVE_INFINITY);

    const second = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1002,
      processNonce: 'second',
      cwd: '/work/b',
    });
    expect(second).not.toBeNull();
  });

  it('rejects a structured lease with an invalid PID before liveness probing', async () => {
    const locksDir = await tempLocksDir();
    const lockPath = streamLockPath(CUBE_ID, DRONE_ID, locksDir);
    await mkdir(lockPath, { recursive: true });
    await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify({
      schemaVersion: 1,
      pid: 0,
      processNonce: 'invalid-owner',
      cwd: '/work/invalid',
      startedAt: '2026-05-28T12:00:00.000Z',
      heartbeatAt: '2026-05-28T12:00:00.000Z',
    }) + '\n');

    const snapshot = await readOwnershipSnapshot(CUBE_ID, DRONE_ID, { locksDir });
    expect(snapshot.ageMs).toBe(Number.POSITIVE_INFINITY);
    await expect(acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1002,
      processNonce: 'replacement',
    })).resolves.not.toBeNull();
  });

  it('refreshes ownership with an atomic owner payload rewrite', async () => {
    const locksDir = await tempLocksDir();
    let now = new Date('2026-05-28T12:00:00.000Z');
    const lease = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1001,
      processNonce: 'first',
      cwd: '/work/a',
      now: () => now,
    });
    expect(lease).not.toBeNull();
    now = new Date('2026-05-28T12:00:10.000Z');

    await expect(lease!.refresh()).resolves.toBe(true);
    const raw = await readFile(path.join(lease!.lockPath, 'owner.json'), 'utf8');
    expect(JSON.parse(raw).heartbeatAt).toBe('2026-05-28T12:00:10.000Z');
  });

  it('does not delete a successor installed before an old owner releases', async () => {
    const locksDir = await tempLocksDir();
    const replacement = {
      schemaVersion: 1,
      pid: 1002,
      processNonce: 'release-successor',
      cwd: '/work/successor',
      startedAt: '2026-05-28T12:00:01.000Z',
      heartbeatAt: '2026-05-28T12:00:01.000Z',
    };
    const lease = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1001,
      processNonce: 'release-old-owner',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
      beforeLeaseReleaseMutation: async (lockPath) => {
        await fsRename(lockPath, `${lockPath}.displaced-old`);
        await mkdir(lockPath, { mode: 0o700 });
        await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify(replacement) + '\n');
      },
    });
    expect(lease).not.toBeNull();

    await lease!.release();

    const current = JSON.parse(await readFile(path.join(lease!.lockPath, 'owner.json'), 'utf8'));
    expect(current).toEqual(replacement);
    await expect(acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1003,
      processNonce: 'release-third-contender',
      now: () => new Date('2026-05-28T12:00:02.000Z'),
    })).resolves.toBeNull();
  });

  it('does not overwrite a successor installed before an old owner refreshes', async () => {
    const locksDir = await tempLocksDir();
    const replacement = {
      schemaVersion: 1,
      pid: 1002,
      processNonce: 'refresh-successor',
      cwd: '/work/successor',
      startedAt: '2026-05-28T12:00:01.000Z',
      heartbeatAt: '2026-05-28T12:00:01.000Z',
    };
    const lease = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1001,
      processNonce: 'refresh-old-owner',
      now: () => new Date('2026-05-28T12:00:00.000Z'),
      beforeLeaseRefreshMutation: async (lockPath) => {
        await fsRename(lockPath, `${lockPath}.displaced-old`);
        await mkdir(lockPath, { mode: 0o700 });
        await writeFile(path.join(lockPath, 'owner.json'), JSON.stringify(replacement) + '\n');
      },
    });
    expect(lease).not.toBeNull();

    await expect(lease!.refresh()).resolves.toBe(false);

    const current = JSON.parse(await readFile(path.join(lease!.lockPath, 'owner.json'), 'utf8'));
    expect(current).toEqual(replacement);
    await expect(acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, {
      locksDir,
      pid: 1003,
      processNonce: 'refresh-third-contender',
      now: () => new Date('2026-05-28T12:00:02.000Z'),
    })).resolves.toBeNull();
  });

  // A refresh renames the lock directory to `<lock>.takeover` while it
  // rewrites the record; a concurrent status read must still see the owner.
  it.each([false, true])('reports the owner during concurrent refreshes (privateRoot %s)', async (privateStorage) => {
    const home = await tempLocksDir();
    const root = path.join(home, '.config', 'borgmcp');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const deps = {
      locksDir: path.join(root, 'locks'),
      ...(privateStorage ? { privateRoot: { root, boundary: home } } : {}),
    };
    const lease = await acquireStreamLease(CUBE_ID, DRONE_ID, 70_000, deps);
    expect(lease).not.toBeNull();
    // Each refresh runs while snapshots are read back to back; the next refresh
    // starts only after the last overlapping read returned, so every read
    // overlaps at most one refresh (production refreshes are 20 s apart).
    const states: Record<string, number> = {};
    // Refresh until 60 reads have demonstrably finished inside a pending refresh
    // (bounded), instead of assuming how many reads fit in one refresh.
    let reads = 0, overlapped = 0;
    for (let refresh = 0; overlapped < 60 && refresh < 5000; refresh++) {
      let done = false;
      const pending = lease!.refresh().finally(() => { done = true; });
      while (!done) {
        const snapshot = await readOwnershipSnapshot(CUBE_ID, DRONE_ID, deps);
        states[snapshot.state] = (states[snapshot.state] ?? 0) + 1; reads++;
        if (!done) overlapped++;
        if (snapshot.state === 'owner') expect(snapshot.pid).toBe(process.pid);
      }
      expect(await pending).toBe(true);
    }
    expect(overlapped).toBeGreaterThanOrEqual(60);
    expect(states).toEqual({ owner: reads });
    await lease!.release();
    expect((await readOwnershipSnapshot(CUBE_ID, DRONE_ID, deps)).state).toBe('unowned');
  });

  it.each([
    ['stale heartbeat', { heartbeatAt: '2026-05-28T11:58:00.000Z' }, true],
    ['dead pid', {}, false],
    ['malformed record', { pid: 'not-a-pid' }, true],
  ])('reads a planted takeover leftover with a %s as unowned', async (_label, override, alive) => {
    const locksDir = await tempLocksDir();
    const claimPath = `${streamLockPath(CUBE_ID, DRONE_ID, locksDir)}.takeover`;
    await mkdir(claimPath, { recursive: true, mode: 0o700 });
    await writeFile(path.join(claimPath, 'owner.json'), JSON.stringify({
      schemaVersion: 1, pid: 4242, processNonce: 'planted', cwd: '/work/planted',
      startedAt: '2026-05-28T11:00:00.000Z', heartbeatAt: '2026-05-28T12:00:00.000Z', ...override,
    }));
    const deps = { locksDir, pid: 1001, processNonce: 'reader', now: () => new Date('2026-05-28T12:00:05.000Z'), isPidAlive: () => alive };
    expect(await readOwnershipSnapshot(CUBE_ID, DRONE_ID, deps)).toEqual({ state: 'unowned', lockPath: streamLockPath(CUBE_ID, DRONE_ID, locksDir) });
    // Positive control: the same leftover, fresh and alive, is the in-flight owner.
    if (!alive || 'heartbeatAt' in override) {
      await writeFile(path.join(claimPath, 'owner.json'), JSON.stringify({
        schemaVersion: 1, pid: 4242, processNonce: 'planted', cwd: '/work/planted',
        startedAt: '2026-05-28T11:00:00.000Z', heartbeatAt: '2026-05-28T12:00:00.000Z',
      }));
      const live = await readOwnershipSnapshot(CUBE_ID, DRONE_ID, { ...deps, isPidAlive: () => true });
      expect(live).toMatchObject({ state: 'owned-by-other-process', pid: 4242, ageMs: 5000 });
    }
  });

  // A validly shaped far-future heartbeat must not keep a phantom in-flight
  // owner visible; real pid liveness (this process), no liveness injection.
  it.each([false, true])('reads a future-dated planted takeover as unowned (privateRoot %s)', async (privateStorage) => {
    const home = await tempLocksDir();
    const root = path.join(home, '.config', 'borgmcp');
    const locksDir = path.join(root, 'locks');
    const claimPath = `${streamLockPath(CUBE_ID, DRONE_ID, locksDir)}.takeover`;
    await mkdir(claimPath, { recursive: true, mode: 0o700 });
    const file = path.join(claimPath, 'owner.json');
    const raw = JSON.stringify({ schemaVersion: 1, pid: process.pid, processNonce: 'planted-not-a-lease', cwd: home,
      startedAt: '2026-01-01T00:00:00.000Z', heartbeatAt: '2099-01-01T00:00:00.000Z' });
    await writeFile(file, raw, { mode: 0o600 });
    const deps = { locksDir, ...(privateStorage ? { privateRoot: { root, boundary: home } } : {}) };
    for (const now of ['2026-09-25T14:00:00.000Z', '2027-09-25T14:00:00.000Z', '2098-12-31T23:59:59.000Z']) {
      expect((await readOwnershipSnapshot(CUBE_ID, DRONE_ID, { ...deps, now: () => new Date(now) })).state).toBe('unowned');
    }
    // Positive control: the same record is reported once its heartbeat is fresh and not in the future.
    expect(await readOwnershipSnapshot(CUBE_ID, DRONE_ID, { ...deps, now: () => new Date('2099-01-01T00:00:05.000Z') }))
      .toMatchObject({ state: 'owned-by-other-process', pid: process.pid, ageMs: 5000 });
    expect(await readFile(file, 'utf8')).toBe(raw);
  });
});
