import { access, mkdir, mkdtemp, readFile, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acquireStreamLease,
  readOwnershipSnapshot,
  streamLockPath,
} from '../src/stream-owner';

const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const DRONE_ID = '22222222-2222-4222-8222-222222222222';

async function tempLocksDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'borg-stream-owner-'));
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
});
