/**
 * CR#2 — ghost-free convergence of a SIBLING attach whose activation failed.
 *
 * The bug: on a SIBLING attach whose atomic activate+bind fails, the record stays
 * PENDING at R_sib = seatRef({projectRoot: ORIGINAL, kind:'sibling', operationKey})
 * with NO worktree. assimilate preserves the spawned worktree (/wt/two) and tells
 * the operator to rerun FROM it. Naively that rerun derives a DIFFERENT ref
 * ({projectRoot:/wt/two, kind:'seat', 'current-worktree'}) → cannot resolve the
 * pending bearer → re-mints → the server (correlating by bearer digest) mints a
 * SECOND (ghost) seat.
 *
 * The fix (CR#2): the activation-failure path BINDS the pending record to the
 * spawned worktree (bindPendingSeatToWorktree — worktree locator set, state STAYS
 * pending). The rerun-from-that-worktree discovers it (getSeatForWorktree),
 * re-derives the EXACT original operation from the stored record, and re-sends the
 * IDENTICAL pending bearer under an ABSENT/pending-reuse expectation. prepareSeat
 * REUSES the pending record (same bearer), the server digest-correlates and REUSES
 * the seat, and the atomic activate+bind converges — ONE seat, no ghost.
 *
 * This exercises the REAL production chain (prepareSeat, sendBorgServerAttach with
 * its real activate/bindPending thunks, bindPendingSeatToWorktree, activateAndBind,
 * getSeatForWorktree) against a fake server that models the exact digest-correlation
 * the real server uses (one seat per DISTINCT bearer digest). HOME points at a
 * fixture so the single 0600 seat store resolves inside it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const originalHome = process.env.HOME;
const fixtures: string[] = [];
afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  for (const f of fixtures.splice(0)) rmSync(f, { recursive: true, force: true });
  vi.resetModules();
});

async function load() {
  const dir = mkdtempSync(join(tmpdir(), 'borg-cr2-'));
  fixtures.push(dir);
  process.env.HOME = dir;
  vi.resetModules();
  const seats = await import('../src/seats.js');
  const handshake = await import('../src/server-handshake.js');
  return { dir, seats, handshake };
}

const ORIGIN = 'https://server.example.com';
const TRUST = 'spki-sha256:server-a';
const CUBE_ID = '11111111-1111-4111-8111-111111111111';
const ROLE_ID = '22222222-2222-4222-8222-222222222222';
const PARENT_CRED = 'p'.repeat(43);
const ORIGINAL = '/work/myrepo';
const WT_TWO = '/home/test/.borg/worktrees/myrepo/review-1';
const digestOf = (s: string) => createHash('sha256').update(s).digest('hex');

/**
 * A fake Borg server that correlates attach requests by the SENT bearer's digest —
 * exactly one seat/drone per DISTINCT digest (a second, different bearer would mint a
 * SECOND drone: the ghost this fix must prevent). Records every sent bearer so the
 * test can prove the rerun re-sent the identical one (reused, not reminted).
 */
function fakeDigestCorrelatingServer() {
  const bySeatDigest = new Map<string, { droneId: string; created: boolean }>();
  const sentBearers: string[] = [];
  let nextDrone = 0;
  const droneIdFor = (n: number) => `${(n + 3).toString().repeat(8)}-${'4'.repeat(4)}-4${'4'.repeat(3)}-8${'4'.repeat(3)}-${'4'.repeat(12)}`;
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const bearer = body.payload.session_credential as string;
    sentBearers.push(bearer);
    const d = digestOf(bearer);
    let seat = bySeatDigest.get(d);
    const created = seat === undefined;
    if (seat === undefined) {
      seat = { droneId: droneIdFor(nextDrone++), created: true };
      bySeatDigest.set(d, seat);
    }
    return new Response(JSON.stringify({
      protocol_version: '2',
      request_id: 'attach-r',
      payload: {
        result: created ? 'created' : 'reused',
        cube: { id: CUBE_ID, name: 'myrepo' },
        role: { id: ROLE_ID, name: 'Drone', role_class: 'worker' },
        drone: { id: seat.droneId, label: 'one-of-one-drone' },
        session: { id: '99999999-9999-4999-8999-999999999999', expires_at: '2026-07-20T00:00:00.000Z' },
      },
    }), { status: created ? 201 : 200 });
  });
  return { fetchImpl, seatCount: () => bySeatDigest.size, sentBearers };
}

type SeatOp = { projectRoot: string; kind: 'seat' | 'sibling'; operationKey: string };
const seatInput = (operation: SeatOp) => ({
  origin: ORIGIN, trustIdentity: TRUST, cubeId: CUBE_ID, roleId: ROLE_ID, operation,
});

describe('CR#2: sibling activation-failure → preserved-worktree rerun converges ghost-free', () => {
  it('re-sends the EXACT pending bearer and converges to a SINGLE active seat (no duplicate/ghost server seat)', async () => {
    const { seats, handshake } = await load();
    const server = fakeDigestCorrelatingServer();

    // ── RUN 1: a SIBLING attach whose activation fails ───────────────────────
    // The source repo is the stable sibling namespace; the operation key is
    // per-invocation-unique (CR#1) so distinct implicit siblings never collide.
    const siblingOp = { projectRoot: ORIGINAL, kind: 'sibling' as const, operationKey: 'implicit-sibling:run-1-uuid' };
    const bearerA = randomBytes(32).toString('base64url');
    // PREPARE: a fresh sibling seat (ABSENT; revalidate:false — no in-place binding
    // to revalidate) mints the PENDING record at R_sib under the single store flock.
    const prep1 = await seats.prepareSeat({
      expected: { kind: 'absent' }, revalidate: false, seed: { ...seatInput(siblingOp), credential: bearerA },
    });
    expect(prep1.ok).toBe(true);
    const R_sib = seats.seatRef(seatInput(siblingOp));

    // SEND the pending bearer (network only). The server creates the FIRST seat.
    const prepared1 = await handshake.sendBorgServerAttach(
      ORIGIN, TRUST, PARENT_CRED,
      { cubeId: CUBE_ID, roleId: ROLE_ID, operation: siblingOp },
      prep1.ok ? prep1.record.credential : '',
      { fetchImpl: server.fetchImpl as unknown as typeof fetch },
    );
    expect(prepared1.result).toBe('created');
    expect(server.seatCount()).toBe(1);

    // ACTIVATION FAILS (a store race / lock): the atomic activate+bind does NOT
    // commit, so the record stays PENDING at R_sib with NO worktree. The
    // activation-failure path then BINDS that pending record to the preserved
    // spawned worktree (state STAYS pending) so the rerun can discover it.
    const bindOutcome = await prepared1.bindPending({
      worktree: WT_TWO, name: 'myrepo', droneLabel: 'one-of-one-drone', roleName: 'Drone', roleClass: 'worker',
    });
    expect(bindOutcome).toBe('bound');

    // The bound-pending record: pending, bound to WT_TWO, still at R_sib, and NOT
    // hydratable as a live seat (getActiveSeatForWorktree requires state==='active').
    const bound = await seats.getSeatForWorktree(WT_TWO);
    expect(bound).toMatchObject({ state: 'pending', worktree: WT_TWO, operation: siblingOp });
    expect(seats.seatRef(bound!)).toBe(R_sib);
    expect(await seats.getActiveSeatForWorktree(WT_TWO)).toBeNull();

    // ── RUN 2: rerun FROM the preserved worktree (/wt/two) ───────────────────
    // The resume path reads the bound-pending record, re-derives the EXACT stored
    // operation (the ORIGINAL sibling op — NOT /wt/two's derived current-worktree
    // seat op) and, because the record is PENDING, uses an ABSENT/pending-reuse
    // expectation. A per-invocation-unique fresh bearer would be MINTED, but
    // prepareSeat REUSES the extant pending record → the identical bearer is re-sent.
    const resumed = await seats.getSeatForWorktree(WT_TWO);
    expect(resumed!.state).toBe('pending');
    const resumedOp = resumed!.operation; // === siblingOp, re-derived from the store
    const wouldBeFreshBearer = randomBytes(32).toString('base64url');

    const prep2 = await seats.prepareSeat({
      expected: { kind: 'absent' }, seed: { ...seatInput(resumedOp), credential: wouldBeFreshBearer },
    });
    expect(prep2.ok).toBe(true);
    // Convergence proof #1: the bearer is REUSED, not reminted (fresh seed ignored).
    expect(prep2.ok && prep2.record.credential).toBe(bearerA);

    const prepared2 = await handshake.sendBorgServerAttach(
      ORIGIN, TRUST, PARENT_CRED,
      { cubeId: CUBE_ID, roleId: ROLE_ID, operation: resumedOp },
      prep2.ok ? prep2.record.credential : '',
      { fetchImpl: server.fetchImpl as unknown as typeof fetch },
    );
    // Convergence proof #2: the server digest-correlated the identical bearer and
    // REUSED the seat — no second (ghost) seat was minted.
    expect(prepared2.result).toBe('reused');
    expect(server.seatCount()).toBe(1);

    // FINALIZE: the atomic activate+bind now converges — pending → ACTIVE, bound to
    // the preserved worktree, in one commit.
    const activated = await prepared2.activate({
      worktree: WT_TWO, name: 'myrepo', droneLabel: 'one-of-one-drone', roleName: 'Drone', roleClass: 'worker',
    });
    expect(activated).toBe('activated');

    // ── Post-conditions: EXACTLY ONE seat, active, at the ORIGINAL sibling ref ──
    expect(server.seatCount()).toBe(1);
    // The identical bearer was sent on BOTH runs (reused, not reminted).
    expect(server.sentBearers).toEqual([bearerA, bearerA]);
    const active = await seats.getActiveSeatForWorktree(WT_TWO);
    expect(active).toMatchObject({ state: 'active', worktree: WT_TWO });
    expect(seats.seatRef(active!)).toBe(R_sib);
    // No ghost record at the naive rerun ref ({projectRoot:/wt/two, kind:'seat'}).
    const naiveRerunRef = seats.seatRef(seatInput({ projectRoot: WT_TWO, kind: 'seat', operationKey: 'current-worktree' }));
    expect(naiveRerunRef).not.toBe(R_sib);
    const all = await seats.readAllActiveSeats();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ worktree: WT_TWO });
  });

  it('bindPendingSeatToWorktree keeps the record PENDING (non-hydratable) and fails closed on a same-ref bearer replacement', async () => {
    const { seats, handshake } = await load();
    const server = fakeDigestCorrelatingServer();
    const siblingOp = { projectRoot: ORIGINAL, kind: 'sibling' as const, operationKey: 'implicit-sibling:x' };
    const bearerA = randomBytes(32).toString('base64url');
    await seats.prepareSeat({ expected: { kind: 'absent' }, revalidate: false, seed: { ...seatInput(siblingOp), credential: bearerA } });
    const prepared = await handshake.sendBorgServerAttach(
      ORIGIN, TRUST, PARENT_CRED, { cubeId: CUBE_ID, roleId: ROLE_ID, operation: siblingOp }, bearerA,
      { fetchImpl: server.fetchImpl as unknown as typeof fetch },
    );
    expect(await prepared.bindPending({ worktree: WT_TWO, name: 'myrepo', droneLabel: 'd', roleName: 'Drone' })).toBe('bound');
    // Still pending → NOT surfaced as a live seat.
    expect(await seats.getActiveSeatForWorktree(WT_TWO)).toBeNull();

    // A same-ref bearer replacement in the gap: bind must fail closed (never bind the
    // worktree onto a different bearer). Scrub + remint a fresh bearer at R_sib.
    const R_sib = seats.seatRef(seatInput(siblingOp));
    await seats.clearSeat(R_sib);
    await seats.mintPendingSeat({ ...seatInput(siblingOp), credential: randomBytes(32).toString('base64url') });
    // The prepared handle still carries bearerA's digest → replaced (fail-closed).
    expect(await prepared.bindPending({ worktree: '/home/test/.borg/worktrees/myrepo/review-2', name: 'myrepo', droneLabel: 'd' })).toBe('replaced');
  });
});
