/**
 * Real-fs tests for the unified 0600 seat store (Queen rescope, scope A).
 * Proves: credential+binding written as ONE atomic unit (ACTIVE-without-binding
 * unreachable by construction), reset deletes BOTH together, and the atomic
 * compare-and-activate fails closed on a same-ref replacement / missing record
 * (incl the no-expectation-digest paths). HOME points at a fixture so the store
 * resolves inside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

  it('CR4: a corrupt seats.json FAILS CLOSED — observation throws, mint never overwrites (byte-preservation)', async () => {
    const { dir, seats } = await load();
    const path = storeJson(dir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const corrupt = '{ "seats": { truncated';
    writeFileSync(path, corrupt);
    chmodSync(path, 0o600); // isolate the malformed-detection path from the perm check
    const ref = seats.seatRef(SEAT);
    // A lock-free observation over a malformed store fails closed (does not read empty).
    await expect(seats.observeSeat(ref, BIND)).rejects.toThrow(/malformed|unsupported version/i);
    // A mint under the flock also fails closed and never overwrites the corrupt bytes.
    await expect(seats.mintPendingSeat({ ...SEAT, credential: 'k'.repeat(43) })).rejects.toThrow(
      /malformed|unsupported version/i,
    );
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
  });

  it('CR4: a wrong-version seats.json FAILS CLOSED and is preserved (never erased)', async () => {
    const { dir, seats } = await load();
    const path = storeJson(dir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const wrongVersion = JSON.stringify({ version: 999, seats: {} });
    writeFileSync(path, wrongVersion);
    chmodSync(path, 0o600);
    await expect(seats.mintPendingSeat({ ...SEAT, credential: 'k'.repeat(43) })).rejects.toThrow(
      /malformed|unsupported version/i,
    );
    expect(readFileSync(path, 'utf8')).toBe(wrongVersion);
  });

  it('CR#2: a valid-JSON but schema-INVALID seat record FAILS CLOSED and preserves the bytes', async () => {
    const { dir, seats } = await load();
    const path = storeJson(dir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // version 1, seats is an object — but the single entry is invalid many ways:
    // its key is not the record's derived ref, state is bogus, credential missing.
    const invalid = JSON.stringify({
      version: 1,
      seats: {
        ['borg-server-session:' + 'a'.repeat(64)]: {
          origin: SEAT.origin,
          trustIdentity: SEAT.trustIdentity,
          cubeId: SEAT.cubeId,
          roleId: SEAT.roleId,
          operation: SEAT.operation,
          state: 'bogus-state',
        },
      },
    });
    writeFileSync(path, invalid);
    chmodSync(path, 0o600);
    const ref = seats.seatRef(SEAT);
    await expect(seats.observeSeat(ref, BIND)).rejects.toThrow(/malformed|unsupported version/i);
    await expect(seats.mintPendingSeat({ ...SEAT, credential: 'k'.repeat(43) })).rejects.toThrow(
      /malformed|unsupported version/i,
    );
    // The invalid bytes are preserved exactly — never erased/overwritten.
    expect(readFileSync(path, 'utf8')).toBe(invalid);
  });

  it('CR#2: an ACTIVE record missing required binding fields FAILS CLOSED (no inconsistent active)', async () => {
    const { dir, seats } = await load();
    const path = storeJson(dir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const ref = seats.seatRef(SEAT);
    // A well-keyed record marked ACTIVE but WITHOUT droneId/sessionId/expiresAt/worktree.
    const inconsistent = JSON.stringify({
      version: 1,
      seats: {
        [ref]: {
          origin: SEAT.origin,
          trustIdentity: SEAT.trustIdentity,
          cubeId: SEAT.cubeId,
          roleId: SEAT.roleId,
          operation: SEAT.operation,
          credential: 'k'.repeat(43),
          state: 'active',
        },
      },
    });
    writeFileSync(path, inconsistent);
    chmodSync(path, 0o600);
    await expect(seats.observeSeat(ref, BIND)).rejects.toThrow(/malformed|unsupported version/i);
    expect(readFileSync(path, 'utf8')).toBe(inconsistent);
  });

  it('CR#2: a group/other-readable seats.json FAILS CLOSED on READ (0600 enforced on read)', async () => {
    const { dir, seats } = await load();
    const path = storeJson(dir);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const valid = JSON.stringify({ version: 1, seats: {} });
    writeFileSync(path, valid);
    chmodSync(path, 0o644); // world-readable secret at rest — must be refused on READ
    const ref = seats.seatRef(SEAT);
    await expect(seats.observeSeat(ref, BIND)).rejects.toThrow(/insecure permissions|0600/i);
    expect(readFileSync(path, 'utf8')).toBe(valid);
  });

  it('CR#2: a MISSING seats.json still initializes empty (ENOENT is the only empty-init path)', async () => {
    const { seats } = await load();
    const ref = seats.seatRef(SEAT);
    // No file on disk → observation reads empty (absent), and a mint succeeds.
    await expect(seats.observeSeat(ref, BIND)).resolves.toEqual({ state: 'absent' });
    await expect(seats.mintPendingSeat({ ...SEAT, credential: 'k'.repeat(43) })).resolves.toBeTruthy();
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

describe('seats store — sibling attaches never move/unseat an active binding (CR1)', () => {
  const inPlaceOp = { projectRoot: '/work/repo', kind: 'seat' as const, operationKey: 'current-worktree' };
  const bindActive = (
    seats: typeof import('../src/seats.js'),
    operation: typeof inPlaceOp,
    bearer: string,
    worktree: string,
  ) =>
    seats.activateAndBindSeat({
      ...SEAT, operation, ...STAMP, expectedPendingDigest: digestOf(bearer), worktree,
      name: 'local-cube', droneLabel: 'builder', roleName: 'Drone',
    });

  it('distinct sibling operation keys mint DISTINCT refs; an ACTIVE in-place seat is untouched', async () => {
    const { seats } = await load();
    // An ACTIVE in-place seat bound to /wt/one.
    await seats.mintPendingSeat({ ...SEAT, operation: inPlaceOp, credential: 'a'.repeat(43) });
    expect(await bindActive(seats, inPlaceOp, 'a'.repeat(43), '/wt/one')).toBe('activated');
    const inPlaceRef = seats.seatRef({ ...SEAT, operation: inPlaceOp });

    // Two implicit siblings with DISTINCT (per-invocation-unique) keys.
    const sibA = { projectRoot: '/work/repo', kind: 'sibling' as const, operationKey: 'implicit-sibling:AAA' };
    const sibB = { projectRoot: '/work/repo', kind: 'sibling' as const, operationKey: 'implicit-sibling:BBB' };
    const refA = seats.seatRef({ ...SEAT, operation: sibA });
    const refB = seats.seatRef({ ...SEAT, operation: sibB });
    // All three seats resolve to DISTINCT refs — no collision onto one seat.
    expect(new Set([inPlaceRef, refA, refB]).size).toBe(3);

    // Sibling A: ABSENT + revalidate (as assimilate now passes) → mint → bind /wt/two.
    const pa = await seats.prepareSeat({
      expected: { kind: 'absent' }, revalidate: true,
      seed: { ...SEAT, operation: sibA, credential: 'b'.repeat(43) },
    });
    expect(pa.ok).toBe(true);
    expect(await bindActive(seats, sibA, 'b'.repeat(43), '/wt/two')).toBe('activated');

    // The ACTIVE in-place seat is UNTOUCHED — still bound to /wt/one at its own ref.
    const one = await seats.getActiveSeatForWorktree('/wt/one');
    expect(one?.worktree).toBe('/wt/one');
    expect(one && seats.seatRef(one)).toBe(inPlaceRef);
    // And sibling A landed at its own distinct ref/worktree.
    const two = await seats.getActiveSeatForWorktree('/wt/two');
    expect(two && seats.seatRef(two)).toBe(refA);
  });

  it('a sibling ABSENT revalidation ABORTS when an ACTIVE record already holds the ref (never moved)', async () => {
    const { seats } = await load();
    const sib = { projectRoot: '/work/repo', kind: 'sibling' as const, operationKey: 'named-sibling:review' };
    await seats.prepareSeat({ expected: { kind: 'absent' }, revalidate: true, seed: { ...SEAT, operation: sib, credential: 'a'.repeat(43) } });
    expect(await bindActive(seats, sib, 'a'.repeat(43), '/wt/review')).toBe('activated');

    // A second sibling attach that lands on the SAME ref (e.g. same --worktree name)
    // with a fresh bearer: ABSENT sees an ACTIVE record → abort, never reuse/move it.
    const p2 = await seats.prepareSeat({
      expected: { kind: 'absent' }, revalidate: true,
      seed: { ...SEAT, operation: sib, credential: 'c'.repeat(43) },
    });
    expect(p2.ok).toBe(false);
    // The active seat is unchanged (still /wt/review, original bearer digest).
    const rev = await seats.getActiveSeatForWorktree('/wt/review');
    expect(rev?.worktree).toBe('/wt/review');
    expect(await seats.observeSeat(seats.seatRef({ ...SEAT, operation: sib }), BIND)).toMatchObject({
      state: 'active', digest: digestOf('a'.repeat(43)),
    });
  });
});

describe('CR#3: findIncompleteSiblingAttempt — recover a crash-orphaned unbound pending sibling', () => {
  const SRC = '/work/repo';
  const KEY = { origin: SEAT.origin, trustIdentity: SEAT.trustIdentity, cubeId: SEAT.cubeId, projectRoot: SRC };
  const siblingOp = { projectRoot: SRC, kind: 'sibling' as const, operationKey: 'implicit-sibling:RUN-1' };

  it('returns the UNBOUND pending sibling record keyed by source repo (the persisted attempt identity)', async () => {
    const { seats } = await load();
    await seats.mintPendingSeat({ ...SEAT, operation: siblingOp, credential: 'a'.repeat(43) });
    const found = await seats.findIncompleteSiblingAttempt(KEY);
    expect(found).not.toBeNull();
    expect(found!.operation).toEqual(siblingOp);
    expect(found!.state).toBe('pending');
    expect(seats.seatRef(found!)).toBe(seats.seatRef({ ...SEAT, operation: siblingOp }));
  });

  it('is null when NONE exists (a first sibling mints fresh)', async () => {
    const { seats } = await load();
    expect(await seats.findIncompleteSiblingAttempt(KEY)).toBeNull();
  });

  it('ignores a BOUND pending sibling (already discoverable by its worktree)', async () => {
    const { seats } = await load();
    await seats.mintPendingSeat({ ...SEAT, operation: siblingOp, credential: 'a'.repeat(43) });
    expect(await seats.bindPendingSeatToWorktree({
      ...SEAT, operation: siblingOp, expectedPendingDigest: digestOf('a'.repeat(43)),
      worktree: '/wt/two', name: 'c', droneLabel: 'd', roleName: 'Drone',
    })).toBe('bound');
    // Bound → no longer an unbound in-flight attempt → not returned (freed for the next sibling).
    expect(await seats.findIncompleteSiblingAttempt(KEY)).toBeNull();
  });

  it('ignores an ACTIVE sibling record and a kind=seat record and a DIFFERENT source repo', async () => {
    const { seats } = await load();
    // ACTIVE sibling (bound + activated).
    await seats.mintPendingSeat({ ...SEAT, operation: siblingOp, credential: 'a'.repeat(43) });
    await seats.activateAndBindSeat({
      ...SEAT, operation: siblingOp, ...STAMP, expectedPendingDigest: digestOf('a'.repeat(43)),
      worktree: '/wt/two', name: 'c', droneLabel: 'd', roleName: 'Drone',
    });
    // An in-place (kind=seat) unbound pending — must NOT be treated as a sibling attempt.
    const seatOp = { projectRoot: SRC, kind: 'seat' as const, operationKey: 'current-worktree' };
    await seats.mintPendingSeat({ ...SEAT, operation: seatOp, credential: 'e'.repeat(43) });
    // A sibling for a DIFFERENT source repo.
    const otherOp = { projectRoot: '/other/repo', kind: 'sibling' as const, operationKey: 'implicit-sibling:X' };
    await seats.mintPendingSeat({ ...SEAT, operation: otherOp, credential: 'f'.repeat(43) });
    expect(await seats.findIncompleteSiblingAttempt(KEY)).toBeNull();
    // But the different-repo key DOES find its own unbound pending sibling.
    expect(await seats.findIncompleteSiblingAttempt({ ...KEY, projectRoot: '/other/repo' })).not.toBeNull();
  });
});
