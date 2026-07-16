import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];
const child = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'server-pending-concurrency-child.ts',
);

async function runChild(
  mode: string,
  fixture: string,
  stateFile: string,
  extraEnv: Record<string, string> = {},
): Promise<any> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', child, mode],
    {
      env: {
        ...process.env,
        HOME: fixture,
        BORG_TEST_KEYCHAIN_STATE: stateFile,
        ...extraEnv,
      },
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}

function enrollmentLockPath(fixture: string): string {
  const binding = createHash('sha256')
    .update('https://localhost:8787')
    .update('\0')
    .update('sha256:server-a')
    .digest('hex');
  const account = `borg-server-enrollment-pending:${binding}`;
  const lockName = createHash('sha256').update(account).digest('hex');
  return join(fixture, '.config', 'borgmcp', 'local-keychain-locks', `${lockName}.lock`);
}

async function waitForMarkers(directory: string, count: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await readdir(directory)).length >= count) return;
    } catch {
      // The child creates the marker directory after reaching the hook.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error(`timed out waiting for ${count} lock-race markers`);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) =>
    rm(fixture, { recursive: true, force: true })));
});

describe('cross-process pending tuple serialization', () => {
  it.each(['enrollment', 'cube'] as const)(
    'returns one exact %s tuple from N independent processes',
    async (mode) => {
      const fixture = await mkdtemp(join(tmpdir(), `borg-pending-${mode}-`));
      fixtures.push(fixture);
      const stateFile = join(fixture, 'keychain.json');
      const outputs = await Promise.all(Array.from({ length: 8 }, async () => {
        return await runChild(mode, fixture, stateFile) as {
          retryKey: string;
          credential?: string;
        };
      }));

      expect([...new Set(outputs.map((output) => output.retryKey))]).toHaveLength(1);
      if (mode === 'enrollment') {
        expect([...new Set(outputs.map((output) => output.credential))]).toHaveLength(1);
      }
    },
  );

  it('resumes the exact persisted enrollment tuple in a new process after response loss', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'borg-pending-resume-'));
    fixtures.push(fixture);
    const stateFile = join(fixture, 'keychain.json');
    const ambiguous = await runChild('ambiguous', fixture, stateFile) as {
      bodies: Array<{ payload: unknown }>;
    };
    expect(ambiguous.bodies).toHaveLength(2);
    expect(ambiguous.bodies[1].payload).toEqual(ambiguous.bodies[0].payload);

    const resumed = await runChild('resume', fixture, stateFile) as {
      bodies: Array<{ payload: unknown }>;
      token: string;
    };
    expect(resumed.bodies).toHaveLength(1);
    expect(resumed.bodies[0].payload).toEqual(ambiguous.bodies[0].payload);
    expect(resumed.token).toBe(
      (ambiguous.bodies[0].payload as { client_credential: string }).client_credential,
    );
  });

  it('atomically elects one stale reaper before a successor lease is published', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'borg-pending-stale-reaper-'));
    fixtures.push(fixture);
    const stateFile = join(fixture, 'keychain.json');
    const lockPath = enrollmentLockPath(fixture);
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    await writeFile(lockPath, '99999999', { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockPath, stale, stale);

    const hookDirectory = join(fixture, 'stale-hook');
    const hookRelease = join(fixture, 'release-stale');
    const env = {
      BORG_TEST_LOCK_HOOK_DIR: hookDirectory,
      BORG_TEST_LOCK_HOOK_RELEASE: hookRelease,
      BORG_TEST_LOCK_HOOK_STAGE: 'stale',
    };
    const contenders = [
      runChild('enrollment', fixture, stateFile, env),
      runChild('enrollment', fixture, stateFile, env),
    ];
    await waitForMarkers(hookDirectory, 2);
    await writeFile(hookRelease, 'go');
    const outputs = await Promise.all(contenders) as Array<{
      retryKey: string;
      credential: string;
    }>;

    expect([...new Set(outputs.map((output) => output.retryKey))]).toHaveLength(1);
    expect([...new Set(outputs.map((output) => output.credential))]).toHaveLength(1);
  });

  it('does not let an old owner cleanup unlink a published successor lease', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'borg-pending-owner-cleanup-'));
    fixtures.push(fixture);
    const stateFile = join(fixture, 'keychain.json');
    const lockPath = enrollmentLockPath(fixture);
    const firstHook = join(fixture, 'cleanup-first');
    const firstRelease = join(fixture, 'release-first');
    const first = runChild('enrollment', fixture, stateFile, {
      BORG_TEST_LOCK_HOOK_DIR: firstHook,
      BORG_TEST_LOCK_HOOK_RELEASE: firstRelease,
      BORG_TEST_LOCK_HOOK_STAGE: 'cleanup',
    });
    await waitForMarkers(firstHook, 1);

    // Simulate an external stale cleanup after the first owner's operation but
    // before its finally block. The successor is published while the old owner
    // remains paused; identity-bound cleanup must leave that successor intact.
    await unlink(lockPath);
    const secondHook = join(fixture, 'cleanup-second');
    const secondRelease = join(fixture, 'release-second');
    const second = runChild('enrollment', fixture, stateFile, {
      BORG_TEST_LOCK_HOOK_DIR: secondHook,
      BORG_TEST_LOCK_HOOK_RELEASE: secondRelease,
      BORG_TEST_LOCK_HOOK_STAGE: 'cleanup',
    });
    await waitForMarkers(secondHook, 1);

    await writeFile(firstRelease, 'go');
    const firstOutput = await first as { retryKey: string; credential: string };
    await expect(stat(lockPath)).resolves.toBeDefined();
    await writeFile(secondRelease, 'go');
    const secondOutput = await second as { retryKey: string; credential: string };

    expect(secondOutput).toEqual(firstOutput);
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('binds stale metadata and lease bytes across canonical replacement', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'borg-pending-stat-read-'));
    fixtures.push(fixture);
    const stateFile = join(fixture, 'keychain.json');
    const lockPath = enrollmentLockPath(fixture);
    const lockDirectory = dirname(lockPath);
    const lockName = basename(lockPath, '.lock');
    const oldOwnerId = randomUUID();
    const oldOwnerPath = join(lockDirectory, `${lockName}.${oldOwnerId}.owner`);
    await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
    await writeFile(oldOwnerPath, JSON.stringify({
      version: 1,
      pid: 99999999,
      ownerId: oldOwnerId,
    }), { mode: 0o600 });
    await link(oldOwnerPath, lockPath);
    const stale = new Date(Date.now() - 60_000);
    await Promise.all([
      utimes(oldOwnerPath, stale, stale),
      utimes(lockPath, stale, stale),
    ]);

    const inspectorHook = join(fixture, 'stat-inspector');
    const inspectorRelease = join(fixture, 'release-inspector');
    const inspector = runChild('enrollment', fixture, stateFile, {
      BORG_TEST_LOCK_HOOK_DIR: inspectorHook,
      BORG_TEST_LOCK_HOOK_RELEASE: inspectorRelease,
      BORG_TEST_LOCK_HOOK_STAGE: 'stat',
    });
    await waitForMarkers(inspectorHook, 1);

    // This process reaps old inode O, publishes successor N, persists the
    // tuple, then exits before cleanup so N is a genuine crashed stale lease.
    const crashHook = join(fixture, 'crashed-successor');
    const crashedSuccessor = runChild('enrollment', fixture, stateFile, {
      BORG_TEST_LOCK_HOOK_DIR: crashHook,
      BORG_TEST_LOCK_HOOK_STAGE: 'owner-crash',
    }).catch(() => null);
    await waitForMarkers(crashHook, 1);
    await crashedSuccessor;

    const successorLease = JSON.parse(await readFile(lockPath, 'utf8')) as {
      ownerId: string;
    };
    const successorOwnerPath = join(
      lockDirectory,
      `${lockName}.${successorLease.ownerId}.owner`,
    );
    await Promise.all([
      utimes(successorOwnerPath, stale, stale),
      utimes(lockPath, stale, stale),
    ]);

    // The paused inspector must read O from its already-open descriptor, not
    // ownerIdN from the replaced pathname. It then loops, safely reaps N, and
    // returns the one tuple already persisted by the crashed successor.
    await writeFile(inspectorRelease, 'go');
    const output = await inspector as { retryKey: string; credential: string };
    const stored = Object.values(JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, string>)
      .map((value) => JSON.parse(value) as { retryKey?: string; credential?: string })
      .find((value) => value.retryKey === output.retryKey);
    expect(stored).toMatchObject(output);
    await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(lockDirectory)).filter((name) =>
      name.endsWith('.owner') || name.includes('.reaping'))).toEqual([]);
  });

  it.each([
    ['owner-inode', 'claim-crash'],
    ['legacy-pid', 'claim-crash'],
    ['owner-inode', 'active-crash'],
    ['legacy-pid', 'active-crash'],
  ] as const)(
    'recovers a %s stale lease after a %s process death',
    async (format, crashStage) => {
      const fixture = await mkdtemp(join(tmpdir(), `borg-pending-${format}-${crashStage}-`));
      fixtures.push(fixture);
      const stateFile = join(fixture, 'keychain.json');
      const lockPath = enrollmentLockPath(fixture);
      const lockDirectory = dirname(lockPath);
      const lockName = basename(lockPath, '.lock');
      await mkdir(lockDirectory, { recursive: true, mode: 0o700 });

      if (format === 'owner-inode') {
        const ownerId = randomUUID();
        const ownerPath = join(lockDirectory, `${lockName}.${ownerId}.owner`);
        await writeFile(ownerPath, JSON.stringify({
          version: 1,
          pid: 99999999,
          ownerId,
        }), { mode: 0o600 });
        await link(ownerPath, lockPath);
      } else {
        await writeFile(lockPath, '99999999', { mode: 0o600 });
      }
      const stale = new Date(Date.now() - 60_000);
      await utimes(lockPath, stale, stale);

      const crashHook = join(fixture, `${format}-${crashStage}`);
      const crashedReaper = runChild('enrollment', fixture, stateFile, {
        BORG_TEST_LOCK_HOOK_DIR: crashHook,
        BORG_TEST_LOCK_HOOK_STAGE: crashStage,
      }).catch(() => null);
      await waitForMarkers(crashHook, 1);
      await crashedReaper;

      const pendingClaimPath = `${lockPath}.reaping`;
      const activeClaimPath = `${lockPath}.reaping-active`;
      if (crashStage === 'claim-crash') {
        await expect(stat(pendingClaimPath)).resolves.toBeDefined();
        await expect(access(activeClaimPath)).rejects.toMatchObject({ code: 'ENOENT' });
      } else {
        await expect(stat(activeClaimPath)).resolves.toBeDefined();
        await expect(access(pendingClaimPath)).rejects.toMatchObject({ code: 'ENOENT' });
        // Advance the deterministic crash-recovery clock without a 30-second
        // wall-clock delay. A live active completer is never stolen early.
        await utimes(activeClaimPath, stale, stale);
      }

      const outputs = await Promise.all(Array.from({ length: 3 }, async () => {
        return await runChild('enrollment', fixture, stateFile) as {
          retryKey: string;
          credential: string;
        };
      }));
      expect([...new Set(outputs.map((output) => output.retryKey))]).toHaveLength(1);
      expect([...new Set(outputs.map((output) => output.credential))]).toHaveLength(1);
      await expect(access(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(lockDirectory)).filter((name) =>
        name.endsWith('.owner') || name.includes('.reaping'))).toEqual([]);
    },
  );
});
