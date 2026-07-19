/**
 * Cross-process serialization over the single 0600 credential store flock (Queen
 * rescope). The reaper-lock-internals tests were DELETED with the per-account
 * reaper machinery; what survives is the mechanism-INDEPENDENT invariant: N
 * independent processes racing to mint a pending tuple serialize to ONE exact
 * tuple, and a later process resumes that exact tuple. HOME points each child at
 * a fresh fixture so config resolves the real credentials.json inside it.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
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

async function runChild(mode: string, fixture: string): Promise<any> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', child, mode],
    { env: { ...process.env, HOME: fixture }, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) =>
    rm(fixture, { recursive: true, force: true })));
});

describe('cross-process credential-store serialization (single flock)', () => {
  it.each(['enrollment', 'cube'] as const)(
    'returns one exact %s tuple from N independent processes (the flock serializes the RCW)',
    async (mode) => {
      const fixture = await mkdtemp(join(tmpdir(), `borg-pending-${mode}-`));
      fixtures.push(fixture);
      const outputs = await Promise.all(Array.from({ length: 8 }, () =>
        runChild(mode, fixture) as Promise<{ retryKey: string; credential?: string }>));

      // All 8 racing processes must converge on ONE minted tuple — the store lock
      // makes the get→(mint)→set atomic across processes.
      expect([...new Set(outputs.map((output) => output.retryKey))]).toHaveLength(1);
      if (mode === 'enrollment') {
        expect([...new Set(outputs.map((output) => output.credential))]).toHaveLength(1);
      }
    },
  );

  it('resumes the exact persisted enrollment tuple in a new process after response loss', async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'borg-pending-resume-'));
    fixtures.push(fixture);
    const ambiguous = await runChild('ambiguous', fixture) as {
      bodies: Array<{ payload: unknown }>;
    };
    // The ambiguous enroll retried with the EXACT persisted tuple (same body).
    expect(ambiguous.bodies).toHaveLength(2);
    expect(ambiguous.bodies[1].payload).toEqual(ambiguous.bodies[0].payload);

    const resumed = await runChild('resume', fixture) as {
      bodies: Array<{ payload: unknown }>;
      token: string;
    };
    expect(resumed.bodies).toHaveLength(1);
    expect(resumed.bodies[0].payload).toEqual(ambiguous.bodies[0].payload);
    expect(resumed.token).toBe(
      (ambiguous.bodies[0].payload as { client_credential: string }).client_credential,
    );
  });
});
