import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  parseResetLocalSeatArgs,
  runResetLocalSeat,
  type ResetLocalSeatDeps,
  type ResetLocalSeatFlags,
} from '../src/reset-local-seat-cmd.js';
import type {
  LocalSeatSnapshot,
  ResetLocalSeatOutcome,
} from '../src/cubes.js';

// ---------------------------------------------------------------------------
// Command-level tests (stub deps) — S0/S1/S2 flow + copy invariants.
// ---------------------------------------------------------------------------

const SNAPSHOT_PRESENT: LocalSeatSnapshot = {
  apiUrl: 'https://server.test',
  serverTrustIdentity: 'spki-sha256:server-a',
  cubeId: '11111111-1111-4111-8111-111111111111',
  droneId: '22222222-2222-4222-8222-222222222222',
  credentialRef: `borg-server-session:${'a'.repeat(64)}`,
  worktree: '/work/repo',
  observation: { state: 'active', digest: 'a'.repeat(64), droneId: '22222222-2222-4222-8222-222222222222' },
};

function makeDeps(overrides: Partial<ResetLocalSeatDeps> = {}): ResetLocalSeatDeps {
  return {
    snapshotLocalSeat: vi.fn(async () => SNAPSHOT_PRESENT),
    resetLocalSeatBinding: vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome),
    findProjectRoot: () => '/work/repo',
    normalizeHost: (h) => (h.startsWith('http') ? h : `https://${h}`),
    cwd: () => '/work/repo',
    isTTY: () => true,
    prompt: vi.fn(async () => 'y'),
    stdout: vi.fn(),
    stderr: vi.fn(),
    ...overrides,
  };
}

const out = (fn: unknown) => (fn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])).join('');

describe('runResetLocalSeat', () => {
  it('TTY confirm (y) resets, makes NO server-revocation claim, gives live re-enroll guidance', async () => {
    const stdout = vi.fn();
    const stderr = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stdout, stderr, resetLocalSeatBinding, isTTY: () => true, prompt: vi.fn(async () => 'y') });
    expect(await runResetLocalSeat({}, deps)).toBe(0);
    expect(resetLocalSeatBinding).toHaveBeenCalledTimes(1);
    const audit = out(stderr);
    expect(audit).toContain("this worktree's saved local seat");
    expect(audit).toContain('server, trust anchor, cube, and sibling worktrees unchanged');
    expect(audit).not.toMatch(/revoked server-side|server revoked/i);
    expect(out(stdout)).toContain('`borg assimilate --host https://server.test --enroll`');
  });

  it('TTY decline (empty → default No) makes NO changes and never touches the binding', async () => {
    const stderr = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stderr, resetLocalSeatBinding, isTTY: () => true, prompt: vi.fn(async () => '') });
    expect(await runResetLocalSeat({}, deps)).toBe(0);
    expect(resetLocalSeatBinding).not.toHaveBeenCalled();
    expect(out(stderr)).toContain('no changes made');
  });

  it('non-TTY WITHOUT --yes makes NO changes and directs to --yes (exit 1)', async () => {
    const stderr = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stderr, resetLocalSeatBinding, isTTY: () => false });
    expect(await runResetLocalSeat({}, deps)).toBe(1);
    expect(resetLocalSeatBinding).not.toHaveBeenCalled();
    expect(out(stderr)).toContain('--yes');
  });

  it('non-TTY WITH --yes resets without a prompt', async () => {
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const prompt = vi.fn(async () => { throw new Error('must not prompt in non-TTY'); });
    const deps = makeDeps({ resetLocalSeatBinding, isTTY: () => false, prompt });
    expect(await runResetLocalSeat({ yes: true }, deps)).toBe(0);
    expect(resetLocalSeatBinding).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
  });

  it('no local seat → honest no-op (exit 0), never re-checks or mutates', async () => {
    const stdout = vi.fn();
    const snapshotLocalSeat = vi.fn(async () => null);
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: 'x' }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stdout, snapshotLocalSeat, resetLocalSeatBinding });
    expect(await runResetLocalSeat({}, deps)).toBe(0);
    expect(resetLocalSeatBinding).not.toHaveBeenCalled();
    expect(out(stdout)).toMatch(/nothing to reset/i);
  });

  it('--host normalized-mismatch is a no-op BEFORE any prompt or mutation', async () => {
    const stdout = vi.fn();
    const prompt = vi.fn(async () => 'y');
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: 'x' }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stdout, prompt, resetLocalSeatBinding });
    expect(await runResetLocalSeat({ host: 'other.host' }, deps)).toBe(0);
    expect(prompt).not.toHaveBeenCalled();
    expect(resetLocalSeatBinding).not.toHaveBeenCalled();
    expect(out(stdout)).toMatch(/not https:\/\/other\.host/);
  });

  it('--host matching the saved seat proceeds to reset', async () => {
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'reset', credentialRef: SNAPSHOT_PRESENT.credentialRef }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ resetLocalSeatBinding, isTTY: () => false });
    expect(await runResetLocalSeat({ host: 'server.test', yes: true }, deps)).toBe(0);
    expect(resetLocalSeatBinding).toHaveBeenCalledTimes(1);
  });

  it("a 'changed' recheck outcome is an honest no-op (never clobbers a replacement)", async () => {
    const stdout = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => ({ outcome: 'changed' }) as ResetLocalSeatOutcome);
    const deps = makeDeps({ stdout, resetLocalSeatBinding, isTTY: () => false });
    expect(await runResetLocalSeat({ yes: true }, deps)).toBe(0);
    expect(out(stdout)).toMatch(/changed since it was read/);
  });

  it('a reset-binding throw fails closed (exit 1) with a retry-safe audit, no false success', async () => {
    const stderr = vi.fn();
    const resetLocalSeatBinding = vi.fn(async () => { throw new Error('store locked'); });
    const deps = makeDeps({ stderr, resetLocalSeatBinding, isTTY: () => false });
    expect(await runResetLocalSeat({ yes: true }, deps)).toBe(1);
    const audit = out(stderr);
    expect(audit).toContain('could not complete');
    expect(audit).not.toContain('was cleared');
  });
});

describe('parseResetLocalSeatArgs', () => {
  const ok = (r: ReturnType<typeof parseResetLocalSeatArgs>): ResetLocalSeatFlags => {
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    return r.flags;
  };

  it('parses --host / --host= / --yes / -y', () => {
    expect(ok(parseResetLocalSeatArgs([]))).toEqual({});
    expect(ok(parseResetLocalSeatArgs(['--yes']))).toEqual({ yes: true });
    expect(ok(parseResetLocalSeatArgs(['-y']))).toEqual({ yes: true });
    expect(ok(parseResetLocalSeatArgs(['--host', 'localhost:7091', '--yes']))).toEqual({ host: 'localhost:7091', yes: true });
    expect(ok(parseResetLocalSeatArgs(['--host=https://s.test']))).toEqual({ host: 'https://s.test' });
  });

  it('rejects --host without a value and unknown args', () => {
    expect(parseResetLocalSeatArgs(['--host']).ok).toBe(false);
    expect(parseResetLocalSeatArgs(['--host', '--yes']).ok).toBe(false);
    expect(parseResetLocalSeatArgs(['--bogus']).ok).toBe(false);
    expect(parseResetLocalSeatArgs(['role-arg']).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cubes.ts adapter tests — REAL single-store (seats.ts) + real fs fixture.
// ---------------------------------------------------------------------------

const originalHome = process.env.HOME;
const originalCwd = process.cwd();
const fixtures: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
  vi.resetModules();
});

const STAMP = {
  droneId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  expiresAt: '2026-07-20T00:00:00.000Z',
};
const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');
type Seats = typeof import('../src/seats.js');

async function setup() {
  const fixture = mkdtempSync(join(tmpdir(), 'borg-reset-seat-'));
  fixtures.push(fixture);
  mkdirSync(join(fixture, 'project', '.git'), { recursive: true });
  // Resolve the realpath so the worktree binding matches findProjectRoot()
  // (macOS /var → /private/var symlink resolution).
  const project = realpathSync(join(fixture, 'project'));
  process.env.HOME = fixture;
  process.chdir(project);
  vi.resetModules();
  const seats = await import('../src/seats.js');
  const cubes = await import('../src/cubes.js');
  return { fixture, project, seats, cubes };
}

function seatFor(worktree: string) {
  return {
    origin: 'https://localhost:8787', trustIdentity: 'sha256:test-server',
    cubeId: '11111111-1111-4111-8111-111111111111', roleId: '44444444-4444-4444-8444-444444444444',
    operation: { projectRoot: worktree, kind: 'seat' as const, operationKey: 'current-worktree' },
  };
}

async function seedActive(seats: Seats, worktree: string, bearer = 'b'.repeat(43), drone = STAMP.droneId) {
  const seat = seatFor(worktree);
  await seats.mintPendingSeat({ ...seat, credential: bearer });
  await seats.activateAndBindSeat({
    ...seat, droneId: drone, sessionId: STAMP.sessionId, expiresAt: STAMP.expiresAt,
    expectedPendingDigest: digestOf(bearer), worktree, name: 'local-cube', droneLabel: 'builder-1', roleName: 'Drone',
  });
  return seats.seatRef(seat);
}

describe('cubes.snapshotLocalSeat (real single store)', () => {
  it('reports state=active + a token-safe digest (never the raw bearer)', async () => {
    const { project, seats, cubes } = await setup();
    const bearer = 'secret-bearer-'.padEnd(43, 'z');
    const ref = await seedActive(seats, project, bearer);
    const snap = await cubes.snapshotLocalSeat();
    expect(snap).not.toBeNull();
    expect(snap!.observation).toEqual({ state: 'active', digest: digestOf(bearer), droneId: STAMP.droneId });
    expect(snap!.droneId).toBe(STAMP.droneId);
    expect(snap!.credentialRef).toBe(ref);
    expect(JSON.stringify(snap)).not.toContain(bearer);
  });

  it('returns null when this worktree has no active seat', async () => {
    const { cubes } = await setup();
    expect(await cubes.snapshotLocalSeat()).toBeNull();
  });
});

describe('cubes.resetLocalSeatBinding (real single store)', () => {
  it('ACTIVE: deletes the whole record (credential + binding gone together)', async () => {
    const { project, seats, cubes } = await setup();
    const ref = await seedActive(seats, project);
    const snap = (await cubes.snapshotLocalSeat())!;
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'reset', credentialRef: ref });
    expect(await seats.getActiveSeatForWorktree(project)).toBeNull();
    expect(await seats.getActiveSeatCredential(ref, { origin: seatFor(project).origin, trustIdentity: seatFor(project).trustIdentity, cubeId: seatFor(project).cubeId })).toBeNull();
  });

  it('same-ref digest replacement (prompt-gap re-enroll) is a no-op, record intact', async () => {
    const { project, seats, cubes } = await setup();
    const ref = await seedActive(seats, project, 'old-'.padEnd(43, 'a'));
    const snap = (await cubes.snapshotLocalSeat())!;
    // The seat was reset+re-enrolled: a FRESH bearer now occupies the SAME ref.
    await seats.clearSeat(ref);
    await seedActive(seats, project, 'new-'.padEnd(43, 'q'));
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'changed' });
    expect(await seats.getActiveSeatForWorktree(project)).not.toBeNull();
  });

  it('a drone-id change under the same ref is a full-binding change → no-op', async () => {
    const { project, seats, cubes } = await setup();
    const ref = await seedActive(seats, project);
    const snap = (await cubes.snapshotLocalSeat())!;
    // A remint wrote a new drone id under the same ref.
    await seats.clearSeat(ref);
    await seedActive(seats, project, 'b'.repeat(43), '99999999-9999-4999-8999-999999999999');
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'changed' });
    expect(await seats.getActiveSeatForWorktree(project)).not.toBeNull();
  });

  it('no-binding when nothing binds the worktree by commit time', async () => {
    const { project, seats, cubes } = await setup();
    const ref = await seedActive(seats, project);
    const snap = (await cubes.snapshotLocalSeat())!;
    await seats.clearSeat(ref); // the whole record vanished between snapshot and commit
    expect(await cubes.resetLocalSeatBinding(snap)).toEqual({ outcome: 'no-binding' });
  });
});
