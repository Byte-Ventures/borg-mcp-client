/**
 * Single-store PREPARE + FINALIZE (collapsed seat model).
 *
 * prepareSeat REVALIDATES the typed expectation and MINTS the PENDING record under
 * ONE store flock (CR#1 PREPARE-time abort); the merged activate+bind
 * (activateAndBindSeat) stamps the exact digest-matched PENDING record ACTIVE and
 * binds the worktree in ONE commit (CR#2 fail-closed on missing/replaced; CR#5 the
 * pending record survives an aborted FINALIZE as the rerunnable locator). The
 * crash-in-gap resume path is prepareSeat's idempotent mint-or-reuse (identical
 * bearer re-sent), NOT a "store lost" error. HOME points at a fixture so the store
 * resolves inside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const originalHome = process.env.HOME;
const fixtures: string[] = [];
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
  vi.resetModules();
});

async function load() {
  const dir = mkdtempSync(join(tmpdir(), 'borg-prepare-'));
  fixtures.push(dir);
  process.env.HOME = dir;
  vi.resetModules();
  const seats = await import('../src/seats.js');
  return { dir, seats };
}

const SEAT = {
  origin: 'https://localhost:8787',
  trustIdentity: 'sha256:server-a',
  cubeId: '11111111-1111-4111-8111-111111111111',
  roleId: '44444444-4444-4444-8444-444444444444',
  operation: { projectRoot: '/work/repo', kind: 'seat' as const, operationKey: 'current-worktree' },
};
const STAMP = {
  droneId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333',
  expiresAt: '2026-07-20T00:00:00.000Z',
};
const WORKTREE = '/work/repo';
const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');
const storeJson = (dir: string) => join(dir, '.config', 'borgmcp', 'seats.json');
const readOrEmpty = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

type Seats = typeof import('../src/seats.js');
const seed = (credential: string) => ({ ...SEAT, credential });

function activate(seats: Seats, bearer: string, worktree = WORKTREE) {
  return seats.activateAndBindSeat({
    ...SEAT, ...STAMP, expectedPendingDigest: digestOf(bearer), worktree,
    name: 'local-cube', droneLabel: 'builder-1', roleName: 'Drone',
  });
}

async function seedActive(seats: Seats, bearer: string) {
  await seats.mintPendingSeat({ ...SEAT, credential: bearer });
  expect(await activate(seats, bearer)).toBe('activated');
  return { ref: seats.seatRef(SEAT), digest: digestOf(bearer) };
}

describe('prepareSeat (CR#1 — revalidate + mint under ONE store flock)', () => {
  it('ABSENT fresh in-place (no prior record): MINTS a pending record', async () => {
    const { dir, seats } = await load();
    const res = await seats.prepareSeat({ expected: { kind: 'absent' }, seed: seed('b'.repeat(43)) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.state).toBe('pending');
    expect(readOrEmpty(storeJson(dir))).toContain('"state": "pending"');
  });

  it('ABSENT mismatch (an ACTIVE record already holds this seat): ABORTS, mints nothing', async () => {
    const { seats } = await load();
    await seedActive(seats, 'b'.repeat(43));
    const res = await seats.prepareSeat({ expected: { kind: 'absent' }, seed: seed('c'.repeat(43)) });
    expect(res).toEqual({ ok: false, reason: 'expectation-mismatch' });
  });

  it('EXACT match (ref + drone id + live digest): REUSES the active record (re-sends the identical bearer)', async () => {
    const { seats } = await load();
    const bearer = 'live-bearer-'.padEnd(43, 'z');
    const { ref, digest } = await seedActive(seats, bearer);
    const res = await seats.prepareSeat({
      expected: { kind: 'exact', credentialRef: ref, droneId: STAMP.droneId, sessionDigest: digest },
      seed: seed('ignored-fresh-'.padEnd(43, 'x')),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.credential).toBe(bearer); // reused, not the fresh seed
  });

  it('EXACT mismatch (no prior record — a reset removed it before PREPARE): ABORTS', async () => {
    const { seats } = await load();
    const res = await seats.prepareSeat({
      expected: { kind: 'exact', credentialRef: seats.seatRef(SEAT), droneId: STAMP.droneId },
      seed: seed('b'.repeat(43)),
    });
    expect(res).toEqual({ ok: false, reason: 'expectation-mismatch' });
  });

  it('EXACT digest mismatch (same-ref replacement before PREPARE): ABORTS', async () => {
    const { seats } = await load();
    const { ref } = await seedActive(seats, 'old-bearer-'.padEnd(43, 'a'));
    const res = await seats.prepareSeat({
      expected: { kind: 'exact', credentialRef: ref, droneId: STAMP.droneId, sessionDigest: 'a'.repeat(64) },
      seed: seed('b'.repeat(43)),
    });
    expect(res).toEqual({ ok: false, reason: 'expectation-mismatch' });
  });

  it('EXACT drone-id mismatch (full-binding pin): ABORTS', async () => {
    const { seats } = await load();
    const { ref } = await seedActive(seats, 'b'.repeat(43));
    const res = await seats.prepareSeat({
      expected: { kind: 'exact', credentialRef: ref, droneId: 'different-drone' },
      seed: seed('c'.repeat(43)),
    });
    expect(res).toEqual({ ok: false, reason: 'expectation-mismatch' });
  });

  it('EXACT ref-only + scrubBeforeMint (eviction remint): discards the prior record then MINTS a fresh bearer', async () => {
    const { seats } = await load();
    const { ref } = await seedActive(seats, 'old-bearer-'.padEnd(43, 'a'));
    const res = await seats.prepareSeat({
      expected: { kind: 'exact', credentialRef: ref, droneId: STAMP.droneId },
      scrubBeforeMint: true,
      seed: seed('fresh-bearer-'.padEnd(43, 'q')),
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.record.state).toBe('pending');
      expect(res.record.credential).toBe('fresh-bearer-'.padEnd(43, 'q'));
    }
  });

  it('revalidate:false (fresh sibling): MINTS even though a current-worktree binding exists — no bypass, no abort', async () => {
    const { seats } = await load();
    await seedActive(seats, 'b'.repeat(43));
    // A sibling has a DISTINCT operation → distinct ref; revalidate:false skips the check.
    const siblingSeed = {
      ...SEAT,
      operation: { projectRoot: WORKTREE, kind: 'sibling' as const, operationKey: 'named-sibling:review-1' },
      credential: 'sib-bearer-'.padEnd(43, 's'),
    };
    const res = await seats.prepareSeat({ expected: { kind: 'absent' }, revalidate: false, seed: siblingSeed });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.operation.kind).toBe('sibling');
  });
});

describe('crash-in-gap resume (idempotent mint-or-reuse, NOT a store-lost error)', () => {
  it('a PENDING record from a lost/crashed FINALIZE is REUSED by a fresh ABSENT prepare (identical bearer), then activate+bind converges', async () => {
    const { seats } = await load();
    const bearer = 'pending-bearer-'.padEnd(43, 'p');
    // PREPARE minted, then the process crashed before activate+bind (pending, no worktree).
    await seats.mintPendingSeat({ ...SEAT, credential: bearer });
    expect(await seats.getActiveSeatForWorktree(WORKTREE)).toBeNull();
    // Re-run: ABSENT (a pending record is not a live binding) REUSES it — same bearer re-sent.
    const res = await seats.prepareSeat({ expected: { kind: 'absent' }, seed: seed('would-be-fresh-'.padEnd(43, 'x')) });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.record.credential).toBe(bearer);
    // FINALIZE now converges with the identical bearer.
    expect(await activate(seats, bearer)).toBe('activated');
    expect(await seats.getActiveSeatForWorktree(WORKTREE)).toMatchObject({ state: 'active', worktree: WORKTREE });
  });
});

describe('FINALIZE — merged activate+bind fails closed (CR#2/#5)', () => {
  it('activate+bind commits: state=active AND worktree land together', async () => {
    const { dir, seats } = await load();
    const bearer = 'b'.repeat(43);
    const prep = await seats.prepareSeat({ expected: { kind: 'absent' }, seed: seed(bearer) });
    expect(prep.ok).toBe(true);
    expect(await activate(seats, bearer)).toBe('activated');
    const parsed = JSON.parse(readOrEmpty(storeJson(dir))) as { seats: Record<string, { state: string; worktree?: string }> };
    for (const r of Object.values(parsed.seats)) {
      if (r.state === 'active') expect(typeof r.worktree).toBe('string');
    }
  });

  it('RACE 2: an offline reset deleted the pending in the gap → activate+bind is MISSING (no orphan ACTIVE)', async () => {
    const { seats } = await load();
    const bearer = 'b'.repeat(43);
    await seats.mintPendingSeat({ ...SEAT, credential: bearer });
    // Offline reset committed in the network gap: the whole record is gone.
    await seats.clearSeat(seats.seatRef(SEAT));
    expect(await activate(seats, bearer)).toBe('missing');
    expect(await seats.getActiveSeatForWorktree(WORKTREE)).toBeNull();
  });

  it('same-ref replacement in the gap (fresh bearer): activate+bind is REPLACED (never binds bearer A onto bearer B)', async () => {
    const { seats } = await load();
    await seats.mintPendingSeat({ ...SEAT, credential: 'original-'.padEnd(43, 'a') });
    await seats.clearSeat(seats.seatRef(SEAT));
    await seats.mintPendingSeat({ ...SEAT, credential: 'fresh-'.padEnd(43, 'q') });
    // Activating with the ORIGINAL digest → replaced; the pending record survives.
    expect(await activate(seats, 'original-'.padEnd(43, 'a'))).toBe('replaced');
    expect(readOrEmpty(storeJson(process.env.HOME! + '/.config/borgmcp/seats.json')))
      .not.toContain('"state": "active"');
  });
});
