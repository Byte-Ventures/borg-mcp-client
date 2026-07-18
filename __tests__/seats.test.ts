/**
 * Real-fs tests for the unified 0600 seat store (Queen rescope, scope A).
 * Proves: credential+binding written as ONE atomic unit (ACTIVE-without-binding
 * unreachable by construction), reset deletes BOTH together, and the atomic
 * compare-and-activate fails closed on a same-ref replacement / missing record
 * (incl the no-expectation-digest paths). HOME points at a fixture so the store
 * resolves inside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'borg-seats-'));
  fixtures.push(dir);
  process.env.HOME = dir;
  // Fresh module so SEATS_FILE (computed from HOME at load) resolves in-fixture.
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
const BIND = { origin: SEAT.origin, trustIdentity: SEAT.trustIdentity, cubeId: SEAT.cubeId };
const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');
const storeJson = (dir: string) => join(dir, '.config', 'borgmcp', 'seats.json');
const readOrEmpty = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

async function activateOk(seats: typeof import('../src/seats.js'), bearer: string, worktree = '/work/repo') {
  return seats.activateAndBindSeat({
    ...SEAT, ...STAMP, expectedPendingDigest: digestOf(bearer), worktree,
    name: 'local-cube', droneLabel: 'builder-1', roleName: 'Drone',
  });
}

describe('seats store — one atomic unit (ACTIVE-without-binding unreachable)', () => {
  it('a PENDING record has NO worktree binding (a pending seat is never a live binding)', async () => {
    const { dir, seats } = await load();
    const rec = await seats.mintPendingSeat({ ...SEAT, credential: 'b'.repeat(43) });
    expect(rec.state).toBe('pending');
    expect(rec.worktree).toBeUndefined();
    // Not surfaced as a live binding for its worktree.
    expect(await seats.getActiveSeatForWorktree('/work/repo')).toBeNull();
    // But discoverable (crash-in-gap resume).
    expect(readOrEmpty(storeJson(dir))).toContain('"state": "pending"');
  });

  it('FINALIZE sets state=active AND worktree in ONE commit — the store never holds an active record without a worktree', async () => {
    const { dir, seats } = await load();
    const bearer = 'live-bearer-'.padEnd(43, 'z');
    await seats.mintPendingSeat({ ...SEAT, credential: bearer });
    expect(await activateOk(seats, bearer)).toBe('activated');
    const parsed = JSON.parse(readOrEmpty(storeJson(dir))) as { seats: Record<string, any> };
    const records = Object.values(parsed.seats);
    // By construction: every ACTIVE record on disk carries a worktree.
    for (const r of records) {
      if (r.state === 'active') expect(typeof r.worktree).toBe('string');
    }
    const live = await seats.getActiveSeatForWorktree('/work/repo');
    expect(live).toMatchObject({ state: 'active', worktree: '/work/repo', droneId: STAMP.droneId, name: 'local-cube' });
  });

  it('the store file is 0600', async () => {
    const { dir, seats } = await load();
    await seats.mintPendingSeat({ ...SEAT, credential: 'b'.repeat(43) });
    expect(statSync(storeJson(dir)).mode & 0o777).toBe(0o600);
  });
});

describe('seats store — atomic compare-and-activate fails closed (CR#2)', () => {
  it('REPLACED: a same-ref replacement (fresh bearer) is never activated with this response’s metadata', async () => {
    const { dir, seats } = await load();
    await seats.mintPendingSeat({ ...SEAT, credential: 'original-bearer-'.padEnd(43, 'a') });
    // A reset+re-enroll replaced the pending bearer under the SAME ref.
    await seats.clearSeat(seats.seatRef(SEAT));
    await seats.mintPendingSeat({ ...SEAT, credential: 'fresh-bearer-'.padEnd(43, 'q') });
    // Activating with the ORIGINAL digest → replaced, not activated.
    expect(await activateOk(seats, 'original-bearer-'.padEnd(43, 'a'))).toBe('replaced');
    expect(readOrEmpty(storeJson(dir))).toContain('"state": "pending"');
    expect(await seats.getActiveSeatForWorktree('/work/repo')).toBeNull();
  });

  it('MISSING: a deleted record (a concurrent reset won) activates nothing', async () => {
    const { seats } = await load();
    expect(await activateOk(seats, 'never-minted-'.padEnd(43, 'x'))).toBe('missing');
  });

  it('idempotent: re-activating the same-bearer active record succeeds (retried FINALIZE)', async () => {
    const { seats } = await load();
    const bearer = 'b'.repeat(43);
    await seats.mintPendingSeat({ ...SEAT, credential: bearer });
    expect(await activateOk(seats, bearer)).toBe('activated');
    expect(await activateOk(seats, bearer)).toBe('activated');
  });
});

describe('seats store — reset deletes credential AND binding together', () => {
  async function seedActive(seats: typeof import('../src/seats.js'), bearer = 'b'.repeat(43)) {
    await seats.mintPendingSeat({ ...SEAT, credential: bearer });
    await activateOk(seats, bearer);
    return seats.seatRef(SEAT);
  }

  it('reset removes the whole record — credential + binding gone in one commit (no partial)', async () => {
    const { dir, seats } = await load();
    const ref = await seedActive(seats);
    const obs = await seats.observeSeat(ref, BIND);
    expect(await seats.resetSeatForWorktree({ worktree: '/work/repo', ref, droneId: STAMP.droneId, observation: obs }))
      .toEqual({ outcome: 'reset', ref });
    // Both gone: no active binding, no credential.
    expect(await seats.getActiveSeatForWorktree('/work/repo')).toBeNull();
    expect(await seats.getActiveSeatCredential(ref, BIND)).toBeNull();
    expect(readOrEmpty(storeJson(dir))).not.toContain(ref);
  });

  it('reset is a no-op on a drone-id change under the same ref (full-binding pin, CR#3)', async () => {
    const { seats } = await load();
    const ref = await seedActive(seats);
    const obs = await seats.observeSeat(ref, BIND);
    // Snapshot pins a DIFFERENT drone id than the live record.
    const res = await seats.resetSeatForWorktree({ worktree: '/work/repo', ref, droneId: 'different-drone', observation: obs });
    expect(res).toEqual({ outcome: 'changed' });
    expect(await seats.getActiveSeatForWorktree('/work/repo')).not.toBeNull();
  });

  it('reset is a no-op on a same-ref digest replacement (prompt-gap re-enroll)', async () => {
    const { seats } = await load();
    const ref = await seedActive(seats, 'old-bearer-'.padEnd(43, 'a'));
    const staleObs = await seats.observeSeat(ref, BIND);
    // A fresh bearer replaced the record under the same ref (still active, new digest).
    await seats.clearSeat(ref);
    await seats.mintPendingSeat({ ...SEAT, credential: 'new-bearer-'.padEnd(43, 'q') });
    await activateOk(seats, 'new-bearer-'.padEnd(43, 'q'));
    const res = await seats.resetSeatForWorktree({ worktree: '/work/repo', ref, droneId: STAMP.droneId, observation: staleObs });
    expect(res).toEqual({ outcome: 'changed' });
    expect(await seats.getActiveSeatForWorktree('/work/repo')).not.toBeNull();
  });

  it('reset no-binding when nothing binds the worktree', async () => {
    const { seats } = await load();
    const res = await seats.resetSeatForWorktree({
      worktree: '/work/repo', ref: seats.seatRef(SEAT), droneId: STAMP.droneId, observation: { state: 'absent' },
    });
    expect(res).toEqual({ outcome: 'no-binding' });
  });
});

describe('seats store — observation + sole raw-bearer reader (CR#3, SR#5)', () => {
  it('observeSeat is typed active|pending|absent and NEVER returns the raw bearer', async () => {
    const { seats } = await load();
    const ref = seats.seatRef(SEAT);
    expect(await seats.observeSeat(ref, BIND)).toEqual({ state: 'absent' });
    await seats.mintPendingSeat({ ...SEAT, credential: 'secret-bearer-'.padEnd(43, 'z') });
    const pending = await seats.observeSeat(ref, BIND);
    expect(pending).toEqual({ state: 'pending', digest: digestOf('secret-bearer-'.padEnd(43, 'z')) });
    expect(JSON.stringify(pending)).not.toContain('secret-bearer');
    await activateOk(seats, 'secret-bearer-'.padEnd(43, 'z'));
    const active = await seats.observeSeat(ref, BIND);
    expect(active).toEqual({ state: 'active', digest: digestOf('secret-bearer-'.padEnd(43, 'z')), droneId: STAMP.droneId });
    expect(JSON.stringify(active)).not.toContain('secret-bearer');
  });

  it('getActiveSeatCredential returns the bearer ONLY for an active, binding-matched record', async () => {
    const { seats } = await load();
    const ref = seats.seatRef(SEAT);
    await seats.mintPendingSeat({ ...SEAT, credential: 'k'.repeat(43) });
    // Pending → no raw bearer (non-hydratable).
    expect(await seats.getActiveSeatCredential(ref, BIND)).toBeNull();
    await activateOk(seats, 'k'.repeat(43));
    expect(await seats.getActiveSeatCredential(ref, BIND)).toBe('k'.repeat(43));
    // Wrong binding → null.
    expect(await seats.getActiveSeatCredential(ref, { ...BIND, cubeId: '99999999-9999-4999-8999-999999999999' })).toBeNull();
  });
});
