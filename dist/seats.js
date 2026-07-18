/**
 * The unified 0600 seat store (Queen rescope, scope A) — `seats.json`.
 *
 * Collapses the per-seat drone-session CREDENTIAL and its worktree BINDING into
 * ONE atomically-written record, keyed by the deterministic seat ref
 * (origin+trust+cube+role+operation). Because a record's `state` and its
 * `worktree` binding are written together in a single `withStore` commit, the
 * invariant "an ACTIVE credential without a binding" is UNREACHABLE BY
 * CONSTRUCTION: PREPARE mints `{credential, state:'pending'}` with NO worktree;
 * FINALIZE sets `state:'active' + server metadata + worktree + display` in one
 * commit; a reset deletes the whole record so credential+binding vanish together
 * (there is no cross-store 'partial').
 *
 * The single store flock (seat-store.withStore) serializes every read-compare-
 * write; there is no second lock and no composite. The raw bearer rests ONLY in
 * the 0600 file and is never returned past this module except by the sole
 * hydration reader; every other observation is digest-only.
 */
import os from 'os';
import path from 'path';
import { createHash } from 'node:crypto';
import { readStoreFile, withStore } from './seat-store.js';
export const SEATS_FILE = path.join(os.homedir(), '.config', 'borgmcp', 'seats.json');
const SEATS_VERSION = 1;
const REF_RE = /^borg-server-session:[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The deterministic per-seat ref (identical algorithm to the retired keychain account). */
export function seatRef(input) {
    const binding = createHash('sha256')
        .update(input.origin)
        .update('\0')
        .update(input.trustIdentity)
        .update('\0')
        .update(input.cubeId)
        .update('\0')
        .update(input.roleId)
        .update('\0')
        .update(input.operation.projectRoot)
        .update('\0')
        .update(input.operation.kind)
        .update('\0')
        .update(input.operation.operationKey)
        .digest('hex');
    return `borg-server-session:${binding}`;
}
function digestOf(bearer) {
    return createHash('sha256').update(bearer).digest('hex');
}
function emptyStore() {
    return { version: SEATS_VERSION, seats: {} };
}
function parseStore(raw) {
    const parsed = JSON.parse(raw);
    if (parsed &&
        typeof parsed === 'object' &&
        parsed.seats &&
        typeof parsed.seats === 'object' &&
        !Array.isArray(parsed.seats)) {
        return { version: SEATS_VERSION, seats: parsed.seats };
    }
    return null;
}
async function readStore() {
    const raw = await readStoreFile(SEATS_FILE);
    if (raw === null)
        return emptyStore();
    try {
        return parseStore(raw) ?? emptyStore();
    }
    catch {
        return emptyStore();
    }
}
/** True iff `record` is a well-formed seat for `ref` + `binding` (origin/trust/cube). */
function recordMatches(record, ref, binding) {
    return (record !== undefined &&
        record.origin === binding.origin &&
        record.trustIdentity === binding.trustIdentity &&
        record.cubeId === binding.cubeId &&
        (record.state === 'pending' || record.state === 'active') &&
        typeof record.credential === 'string' &&
        seatRef(record) === ref);
}
/**
 * TYPED, token-safe observation of the record at `ref` (CR#3). Lock-free read
 * (atomic rename → complete file); the authoritative delete/activate re-reads
 * under the flock. Returns only a digest + drone id, never the raw bearer.
 */
export async function observeSeat(ref, binding) {
    if (!REF_RE.test(ref))
        return { state: 'absent' };
    const store = await readStore();
    const record = store.seats[ref];
    if (!recordMatches(record, ref, binding))
        return { state: 'absent' };
    const digest = digestOf(record.credential);
    if (record.state === 'active') {
        return { state: 'active', digest, droneId: typeof record.droneId === 'string' ? record.droneId : '' };
    }
    return { state: 'pending', digest };
}
/**
 * The SOLE raw-bearer reader (SR-seven #5). Returns the ACTIVE bearer for `ref`
 * iff the record is active AND the binding matches — used only to hydrate the
 * live seat for authenticated requests. Every other caller observes digest-only.
 */
export async function getActiveSeatCredential(ref, binding) {
    if (!REF_RE.test(ref))
        return null;
    const store = await readStore();
    const record = store.seats[ref];
    if (!recordMatches(record, ref, binding) || record.state !== 'active')
        return null;
    return record.credential;
}
// ─── PREPARE / mint (no worktree yet) ────────────────────────────────────────
/**
 * Mint the client bearer for one seat, or return the existing record (pending or
 * active) so a lost-response retry re-sends the identical bearer. The minted
 * record has NO worktree binding — FINALIZE adds it atomically with activation,
 * so a pending record is never a live binding.
 */
export async function mintPendingSeat(input) {
    const ref = seatRef(input);
    return withStore(SEATS_FILE, emptyStore, parseStore, async (txn) => {
        const existing = txn.data.seats[ref];
        if (recordMatches(existing, ref, { origin: input.origin, trustIdentity: input.trustIdentity, cubeId: input.cubeId })) {
            return existing;
        }
        const record = {
            origin: input.origin,
            trustIdentity: input.trustIdentity,
            cubeId: input.cubeId,
            roleId: input.roleId,
            operation: input.operation,
            credential: input.credential,
            state: 'pending',
        };
        txn.data.seats[ref] = record;
        await txn.commit();
        return record;
    });
}
/**
 * ATOMIC compare-and-activate + bind (CR#2 + the scope-A collapse). Under ONE
 * flock: the exact pending/active record whose bearer digest matches
 * `expectedPendingDigest` is stamped ACTIVE with the server metadata AND the
 * worktree binding + display, in a single commit. A same-ref replacement or a
 * missing record fails closed (`replaced`/`missing`) — server metadata for bearer
 * A is never bound onto bearer B, and the digest guard holds even on the
 * no-expectation-digest paths (the SENT bearer's digest is always pinned).
 * Because `state:'active'` and `worktree` land together, ACTIVE-without-binding
 * is unreachable by construction.
 */
export async function activateAndBindSeat(input) {
    if (!UUID_RE.test(input.droneId) || !UUID_RE.test(input.sessionId)) {
        throw new Error('invalid Borg server session identity');
    }
    if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) {
        throw new Error('invalid Borg server session expiry');
    }
    const ref = seatRef(input);
    const binding = { origin: input.origin, trustIdentity: input.trustIdentity, cubeId: input.cubeId };
    return withStore(SEATS_FILE, emptyStore, parseStore, async (txn) => {
        const record = txn.data.seats[ref];
        if (!recordMatches(record, ref, binding))
            return 'missing';
        if (digestOf(record.credential) !== input.expectedPendingDigest)
            return 'replaced';
        txn.data.seats[ref] = {
            ...record,
            state: 'active',
            droneId: input.droneId,
            sessionId: input.sessionId,
            expiresAt: input.expiresAt,
            worktree: input.worktree,
            name: input.name,
            droneLabel: input.droneLabel,
            ...(input.roleName !== undefined ? { roleName: input.roleName } : {}),
            ...(input.roleClass !== undefined ? { roleClass: input.roleClass } : {}),
            ...(input.isHumanSeat !== undefined ? { isHumanSeat: input.isHumanSeat } : {}),
        };
        await txn.commit();
        return 'activated';
    });
}
// ─── Hydration / enumeration (scan by worktree) ──────────────────────────────
/** The exact ACTIVE seat bound to `worktree`, or null. A pending record (no
 *  worktree, or non-active) is NEVER surfaced as a live binding. */
export async function getActiveSeatForWorktree(worktree) {
    const store = await readStore();
    for (const [ref, record] of Object.entries(store.seats)) {
        if (record.state === 'active' && record.worktree === worktree && seatRef(record) === ref) {
            return record;
        }
    }
    return null;
}
/** True iff this worktree has ANY persisted seat record (active OR a bound
 *  pending), so a crash-in-gap PENDING seat is discoverable (not mislabeled). */
export async function hasSeatForWorktree(worktree) {
    const store = await readStore();
    return Object.values(store.seats).some((r) => r.worktree === worktree);
}
/** All ACTIVE bound seats — {worktree, record}. */
export async function readAllActiveSeats() {
    const store = await readStore();
    const out = [];
    for (const [ref, record] of Object.entries(store.seats)) {
        if (record.state === 'active' && typeof record.worktree === 'string' && seatRef(record) === ref) {
            out.push({ worktree: record.worktree, record });
        }
    }
    return out;
}
/**
 * Reset the seat bound to `worktree`: under ONE flock, re-check the exact FULL
 * binding (ref + drone id) and the token-safe observation, then DELETE the whole
 * record — credential AND binding vanish together in one commit (no 'partial',
 * no cross-store skew). Any drift (missing / different ref or drone / same-ref
 * digest replacement) is an honest no-op.
 */
export async function resetSeatForWorktree(expected) {
    return withStore(SEATS_FILE, emptyStore, parseStore, async (txn) => {
        const record = txn.data.seats[expected.ref];
        if (record === undefined ||
            record.worktree !== expected.worktree ||
            record.droneId !== expected.droneId ||
            seatRef(record) !== expected.ref) {
            // Look for whether ANY record still binds this worktree — if not, no-op.
            const anyBound = Object.values(txn.data.seats).some((r) => r.worktree === expected.worktree);
            return anyBound ? { outcome: 'changed' } : { outcome: 'no-binding' };
        }
        // Same-ref replacement guard: the live digest must still match the snapshot.
        const expDigest = expected.observation.state === 'absent' ? null : expected.observation.digest;
        if (expDigest !== null && digestOf(record.credential) !== expDigest) {
            return { outcome: 'changed' };
        }
        delete txn.data.seats[expected.ref];
        await txn.commit();
        return { outcome: 'reset', ref: expected.ref };
    });
}
/** Abort-scrub of the caller's OWN pending record only (CR#2 finalize abort):
 *  delete iff still pending AND digest matches — never an active record, never a
 *  same-ref replacement. */
export async function scrubPendingSeat(ref, binding, expectedPendingDigest) {
    if (!REF_RE.test(ref))
        return false;
    return withStore(SEATS_FILE, emptyStore, parseStore, async (txn) => {
        const record = txn.data.seats[ref];
        if (!recordMatches(record, ref, binding) || record.state !== 'pending')
            return false;
        if (digestOf(record.credential) !== expectedPendingDigest)
            return false;
        delete txn.data.seats[ref];
        await txn.commit();
        return true;
    });
}
/** Discard any record for one seat ref (eviction remint before a fresh mint). */
export async function clearSeat(ref) {
    if (!REF_RE.test(ref))
        throw new Error('invalid Borg server session credential reference');
    await withStore(SEATS_FILE, emptyStore, parseStore, async (txn) => {
        if (txn.data.seats[ref] !== undefined) {
            delete txn.data.seats[ref];
            await txn.commit();
        }
    });
}
/** Metadata-only refresh (name/label/role display) of the ACTIVE seat bound to
 *  `worktree` — CANNOT alter the credential, ref, identity, or worktree binding. */
export async function refreshSeatMetadata(worktree, display) {
    await withStore(SEATS_FILE, emptyStore, parseStore, async (txn) => {
        let changed = false;
        for (const [ref, record] of Object.entries(txn.data.seats)) {
            if (record.state === 'active' && record.worktree === worktree && seatRef(record) === ref) {
                txn.data.seats[ref] = {
                    ...record,
                    name: display.name,
                    droneLabel: display.droneLabel,
                    ...(display.roleName !== undefined ? { roleName: display.roleName } : {}),
                    ...(display.roleClass !== undefined ? { roleClass: display.roleClass } : {}),
                    ...(display.isHumanSeat !== undefined ? { isHumanSeat: display.isHumanSeat } : {}),
                };
                changed = true;
                break;
            }
        }
        if (changed)
            await txn.commit();
    });
}
/** @internal Test-only: point the store at a fixture path is done via HOME; this
 *  clears the module cache (there is none — every op reads fresh under the lock). */
//# sourceMappingURL=seats.js.map