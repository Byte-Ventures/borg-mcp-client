/**
 * CR#3 process-restart E2E: a crash-orphaned IMPLICIT-sibling attempt is recovered by
 * a SEPARATE OS process (a rerun) which re-sends the IDENTICAL bearer under the SAME
 * seat ref — so the real digest-correlating server reuses its seat and NO ghost is
 * minted. Two independent `node --import tsx` invocations share one HOME fixture, so
 * the real 0600 seat store (seats.json) persists across the restart.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const fixtures: string[] = [];
const child = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sibling-retry-identity-child.ts');

async function runChild(mode: 'run1' | 'run2', home: string): Promise<any> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', child, mode],
    { env: { ...process.env, HOME: home }, maxBuffer: 1024 * 1024 },
  );
  return JSON.parse(stdout);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((f) => rm(f, { recursive: true, force: true })));
});

describe('CR#3: implicit-sibling retry identity survives a PROCESS RESTART (ghost-free)', () => {
  it('a rerun (separate process) re-derives the EXACT ref and re-sends the identical bearer', async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'borg-sibling-retry-'));
    fixtures.push(home);

    // Process 1: mint fresh → attach (server accepts) → crash before bind.
    const run1 = await runChild('run1', home) as { sentBearer: string; operationKey: string };
    expect(run1.operationKey).toMatch(/^implicit-sibling:/);

    // Process 2 (a genuine restart, same HOME): recover the in-flight attempt.
    const run2 = await runChild('run2', home) as {
      sentBearer: string; operationKey: string; freshSeed: string; reused: boolean; ref: string;
    };

    // Convergence: the rerun re-derived the SAME operationKey (→ same seat ref)…
    expect(run2.operationKey).toBe(run1.operationKey);
    // …REUSED the extant pending record (the fresh seed was ignored)…
    expect(run2.sentBearer).not.toBe(run2.freshSeed);
    // …and re-sent the IDENTICAL bearer run1 sent → the digest-correlating server
    // reuses its seat (no second/ghost seat).
    expect(run2.sentBearer).toBe(run1.sentBearer);
    expect(run2.reused).toBe(true);
  });
});
