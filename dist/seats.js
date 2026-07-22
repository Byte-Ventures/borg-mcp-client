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
import { LegacySessionCredentialCollisionError } from './server-errors.js';
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
const ROLE_CLASSES = new Set(['queen', 'worker']);
const OPERATION_KINDS = new Set(['seat', 'sibling']);
function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
}
function isValidOperation(value) {
    if (value === null || typeof value !== 'object')
        return false;
    const op = value;
    return (isNonEmptyString(op.projectRoot) &&
        typeof op.kind === 'string' &&
        OPERATION_KINDS.has(op.kind) &&
        isNonEmptyString(op.operationKey));
}
/**
 * CR#2: FULL per-entry validation. Every key/value/invariant of a seat record is
 * checked — the ref is well-formed and self-consistent (the map key equals the
 * record's derived ref), state ∈ {pending,active}, the credential is a non-empty
 * string, the operation is well-shaped, an ACTIVE record carries ALL its required
 * server + binding fields, and a PENDING record carries NO active-only session
 * id. A single invalid entry ⇒ the whole store is rejected
 * (fail closed at the caller, bytes preserved) — never a silent cast.
 */
function isValidSeatRecord(ref, value) {
    if (!REF_RE.test(ref))
        return false;
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const r = value;
    // Identity + credential + operation.
    if (!isNonEmptyString(r.origin) ||
        !isNonEmptyString(r.trustIdentity) ||
        !isNonEmptyString(r.cubeId) ||
        !isNonEmptyString(r.roleId) ||
        !isValidOperation(r.operation) ||
        !isNonEmptyString(r.credential)) {
        return false;
    }
    if (r.state !== 'pending' && r.state !== 'active')
        return false;
    // Optional display/typed fields, validated when present.
    if (r.name !== undefined && typeof r.name !== 'string')
        return false;
    if (r.droneLabel !== undefined && typeof r.droneLabel !== 'string')
        return false;
    if (r.roleName !== undefined && typeof r.roleName !== 'string')
        return false;
    if (r.roleClass !== undefined && (typeof r.roleClass !== 'string' || !ROLE_CLASSES.has(r.roleClass)))
        return false;
    if (r.isHumanSeat !== undefined && typeof r.isHumanSeat !== 'boolean')
        return false;
    if (r.worktree !== undefined && typeof r.worktree !== 'string')
        return false;
    if (r.droneId !== undefined && (typeof r.droneId !== 'string' || !UUID_RE.test(r.droneId)))
        return false;
    if (r.sessionId !== undefined && (typeof r.sessionId !== 'string' || !UUID_RE.test(r.sessionId)))
        return false;
    // State-consistency invariants (no inconsistent active|pending).
    if (r.state === 'active') {
        // An ACTIVE record MUST carry its full server session + worktree binding.
        if (typeof r.droneId !== 'string' ||
            typeof r.sessionId !== 'string' ||
            typeof r.worktree !== 'string' ||
            typeof r.name !== 'string' ||
            typeof r.droneLabel !== 'string') {
            return false;
        }
    }
    else {
        // A PENDING record must NOT carry active-only server session fields.
        if (r.sessionId !== undefined)
            return false;
    }
    // The map key must equal the record's derived ref (no cross-key aliasing).
    return seatRef(value) === ref;
}
/**
 * CR4 + CR#2: parse + FULL version/schema/per-entry validation. Returns null (→ fail
 * closed at the caller, bytes preserved) for any malformed JSON, wrong version, or
 * ANY invalid entry; never throws and never coerces an invalid file into a
 * valid-looking or empty store.
 */
function parseStore(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const candidate = parsed;
        if (candidate.version === SEATS_VERSION &&
            candidate.seats &&
            typeof candidate.seats === 'object' &&
            !Array.isArray(candidate.seats)) {
            const seats = candidate.seats;
            for (const [ref, record] of Object.entries(seats)) {
                if (record !== null &&
                    typeof record === 'object' &&
                    !Array.isArray(record) &&
                    Object.prototype.hasOwnProperty.call(record, 'replacement')) {
                    const { replacement, ...withoutReplacement } = record;
                    const exactReplacement = replacement !== null &&
                        typeof replacement === 'object' &&
                        !Array.isArray(replacement) &&
                        Object.keys(replacement).length === 1 &&
                        typeof replacement.credential === 'string' &&
                        /^[A-Za-z0-9_-]{43}$/.test(replacement.credential);
                    let canonicalOrigin = false;
                    try {
                        const origin = new URL(String(withoutReplacement.origin));
                        canonicalOrigin = origin.protocol === 'https:' && origin.origin === withoutReplacement.origin;
                    }
                    catch {
                        canonicalOrigin = false;
                    }
                    if (withoutReplacement.state === 'active' &&
                        exactReplacement &&
                        canonicalOrigin &&
                        isValidSeatRecord(ref, withoutReplacement)) {
                        throw new LegacySessionCredentialCollisionError(withoutReplacement.origin);
                    }
                    return null;
                }
                if (!isValidSeatRecord(ref, record))
                    return null;
            }
            return { version: SEATS_VERSION, seats: seats };
        }
    }
    return null;
}
async function readStore() {
    const raw = await readStoreFile(SEATS_FILE);
    // CR4 fail-closed: ENOENT alone initializes empty. A present-but-malformed /
    // wrong-version / schema-invalid store MUST NOT read as empty (a following commit
    // would erase every seat); throw so the on-disk bytes are preserved.
    if (raw === null)
        return emptyStore();
    const parsed = parseStore(raw);
    if (parsed === null) {
        throw new Error('Borg seat store is malformed or has an unsupported version; refusing to read it');
    }
    return parsed;
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
 * CR#1 PREPARE-time abort in the single-store model. Under ONE store flock:
 * REVALIDATE the typed expectation against the record currently at the seat ref
 * (EXACT: the exact prior ACTIVE record must still hold — ref, optional drone id,
 * optional live-bearer digest; ABSENT: no ACTIVE record may hold this seat), then
 * — only if it holds — MINT the pending record in the SAME lock hold. A pre-existing
 * valid record (pending from a lost-response retry, or the active record being
 * reattached) is REUSED so the identical bearer is re-sent. `scrubBeforeMint`
 * discards a known-invalid saved record (eviction remint) before minting, still
 * under the one flock. On a mismatch NOTHING is minted or scrubbed (abort).
 */
export async function prepareSeat(input) {
    const { expected, revalidate = true, scrubBeforeMint = false, seed } = input;
    const ref = seatRef(seed);
    const binding = { origin: seed.origin, trustIdentity: seed.trustIdentity, cubeId: seed.cubeId };
    return withStore(SEATS_FILE, emptyStore, parseStore, async (txn) => {
        if (revalidate) {
            const prior = txn.data.seats[ref];
            let mismatch;
            if (expected.kind === 'exact') {
                const holds = recordMatches(prior, ref, binding) &&
                    prior.state === 'active' &&
                    ref === expected.credentialRef &&
                    (expected.droneId === undefined || prior.droneId === expected.droneId) &&
                    (expected.sessionDigest === undefined || digestOf(prior.credential) === expected.sessionDigest);
                mismatch = !holds;
            }
            else {
                // ABSENT: an ACTIVE record holding this seat is a mismatch. A PENDING record
                // (a lost-response retry / crash-in-gap) is NOT a live binding and is reused
                // below so the identical bearer is re-sent.
                mismatch = recordMatches(prior, ref, binding) && prior.state === 'active';
            }
            if (mismatch)
                return { ok: false, reason: 'expectation-mismatch' };
        }
        if (scrubBeforeMint) {
            delete txn.data.seats[ref];
        }
        const existing = txn.data.seats[ref];
        if (recordMatches(existing, ref, binding)) {
            // Idempotent reuse: re-send the exact bearer the server already digest-bound
            // (a lost-response retry, a crash-in-gap pending, or an active reattach).
            return { ok: true, record: existing };
        }
        const record = {
            origin: seed.origin,
            trustIdentity: seed.trustIdentity,
            cubeId: seed.cubeId,
            roleId: seed.roleId,
            operation: seed.operation,
            credential: seed.credential,
            state: 'pending',
        };
        txn.data.seats[ref] = record;
        await txn.commit();
        return { ok: true, record };
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
/**
 * CR#2: bind an existing PENDING record to a worktree WITHOUT activating it. On a
 * SIBLING attach whose atomic activate+bind failed, the spawned worktree is
 * preserved for an operator-driven rerun (CR#5). This stamps the worktree locator +
 * display (and, if known, the drone id) onto the EXACT digest-matched PENDING record
 * so the rerun FROM that worktree can DISCOVER and RESUME it — re-sending the
 * identical bearer the server already digest-bound, converging on the SAME seat (no
 * ghost). The record STAYS `state:'pending'`: it is non-hydratable as a live seat
 * (getActiveSeatForWorktree still requires state==='active'), so this introduces no
 * ACTIVE-without-activation state. Under ONE store flock (CR#3), fail-closed (CR#4):
 * a missing / already-ACTIVE / same-ref-replaced record is a typed no-op — never
 * binds a worktree onto a different bearer, never mutates an ACTIVE record.
 */
export async function bindPendingSeatToWorktree(input) {
    if (input.droneId !== undefined && !UUID_RE.test(input.droneId)) {
        throw new Error('invalid Borg server session identity');
    }
    const ref = seatRef(input);
    const binding = { origin: input.origin, trustIdentity: input.trustIdentity, cubeId: input.cubeId };
    return withStore(SEATS_FILE, emptyStore, parseStore, async (txn) => {
        const record = txn.data.seats[ref];
        if (!recordMatches(record, ref, binding))
            return 'missing';
        // Never touch an ACTIVE record, and never bind a worktree onto a same-ref
        // replacement — the record's live digest must still equal the sent bearer's.
        if (record.state !== 'pending' || digestOf(record.credential) !== input.expectedPendingDigest) {
            return 'replaced';
        }
        txn.data.seats[ref] = {
            ...record,
            // state STAYS 'pending' — NOT activated. Only the worktree locator + display
            // (+ drone id) land, so the preserved worktree owns a discoverable, resumable
            // pending record without becoming a live/hydratable binding.
            worktree: input.worktree,
            name: input.name,
            droneLabel: input.droneLabel,
            ...(input.droneId !== undefined ? { droneId: input.droneId } : {}),
            ...(input.roleName !== undefined ? { roleName: input.roleName } : {}),
            ...(input.roleClass !== undefined ? { roleClass: input.roleClass } : {}),
            ...(input.isHumanSeat !== undefined ? { isHumanSeat: input.isHumanSeat } : {}),
        };
        await txn.commit();
        return 'bound';
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
/**
 * CR#2: the seat bound to `worktree` regardless of state — an ACTIVE seat OR a
 * bound-PENDING record (a sibling whose activation failed, bound to its preserved
 * worktree by `bindPendingSeatToWorktree`). Used ONLY by the resume path to recover
 * a bound-pending record's stored `operation` + `state` so the rerun can re-derive
 * the EXACT seat ref and re-send the identical bearer. A bound-pending record is
 * still NON-hydratable as a live seat — `getActiveSeatForWorktree` (and hence
 * `getActiveCube`) still require state==='active', so this reader does NOT weaken
 * the no-ACTIVE-without-binding / non-hydratable-pending invariants.
 */
export async function getSeatForWorktree(worktree) {
    const store = await readStore();
    for (const [ref, record] of Object.entries(store.seats)) {
        if (record.worktree === worktree && seatRef(record) === ref) {
            return record;
        }
    }
    return null;
}
/**
 * CR#3: find an in-flight IMPLICIT-sibling attempt for `binding` — a PENDING,
 * kind==='sibling' record whose operation.projectRoot is the source repo and which
 * has NO worktree binding yet (unbound). Such a record is the persisted, collision-
 * safe attempt identity left when a crash struck AFTER the server accepted the attach
 * but BEFORE the worktree bind: its per-invocation-unique operationKey would otherwise
 * be undiscoverable, so a rerun would mint a NEW bearer and the server (digest-
 * correlating) would create a GHOST seat. Recovering it lets the rerun re-derive the
 * EXACT ref and re-send the identical bearer (the server reuses its seat). A BOUND
 * pending sibling (already discoverable by its worktree) and an ACTIVE record are NOT
 * returned — so a COMPLETED sibling frees the source-repo key and the next distinct
 * sibling mints a fresh identity. Deterministic first match.
 */
export async function findIncompleteSiblingAttempt(binding) {
    const store = await readStore();
    for (const [ref, record] of Object.entries(store.seats)) {
        if (record.state === 'pending' &&
            record.worktree === undefined &&
            record.operation.kind === 'sibling' &&
            record.origin === binding.origin &&
            record.trustIdentity === binding.trustIdentity &&
            record.cubeId === binding.cubeId &&
            record.operation.projectRoot === binding.projectRoot &&
            seatRef(record) === ref) {
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
/** Metadata-only refresh of one exact ACTIVE seat. The expected tuple prevents
 * a delayed response from updating a replacement seat that reused the worktree. */
export async function refreshSeatMetadata(worktree, expected, display) {
    if (!REF_RE.test(expected.credentialRef))
        return false;
    return withStore(SEATS_FILE, emptyStore, parseStore, async (txn) => {
        const record = txn.data.seats[expected.credentialRef];
        if (record?.state !== 'active' || record.worktree !== worktree ||
            record.cubeId !== expected.cubeId || record.droneId !== expected.droneId ||
            seatRef(record) !== expected.credentialRef)
            return false;
        txn.data.seats[expected.credentialRef] = {
            ...record,
            name: display.name,
            droneLabel: display.droneLabel,
            ...(display.roleName !== undefined ? { roleName: display.roleName } : {}),
            ...(display.roleClass !== undefined ? { roleClass: display.roleClass } : {}),
            ...(display.isHumanSeat !== undefined ? { isHumanSeat: display.isHumanSeat } : {}),
        };
        await txn.commit();
        return true;
    });
}
/** @internal Test-only: point the store at a fixture path is done via HOME; this
 *  clears the module cache (there is none — every op reads fresh under the lock). */
//# sourceMappingURL=seats.js.map