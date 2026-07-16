import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
});
