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
export declare const SEATS_FILE: string;
export interface SeatOperation {
    projectRoot: string;
    kind: 'seat' | 'sibling';
    operationKey: string;
}
/** One seat = its credential + binding + display, written as one atomic unit. */
export interface SeatRecord {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: SeatOperation;
    credential: string;
    state: 'pending' | 'active';
    droneId?: string;
    sessionId?: string;
    expiresAt?: string;
    worktree?: string;
    name?: string;
    droneLabel?: string;
    roleName?: string;
    roleClass?: 'queen' | 'worker';
    isHumanSeat?: boolean;
}
/** The deterministic per-seat ref (identical algorithm to the retired keychain account). */
export declare function seatRef(input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: SeatOperation;
}): string;
export type SeatObservation = {
    state: 'active';
    digest: string;
    droneId: string;
} | {
    state: 'pending';
    digest: string;
} | {
    state: 'absent';
};
/**
 * TYPED, token-safe observation of the record at `ref` (CR#3). Lock-free read
 * (atomic rename → complete file); the authoritative delete/activate re-reads
 * under the flock. Returns only a digest + drone id, never the raw bearer.
 */
export declare function observeSeat(ref: string, binding: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
}): Promise<SeatObservation>;
/**
 * The SOLE raw-bearer reader (SR-seven #5). Returns the ACTIVE bearer for `ref`
 * iff the record is active AND the binding matches — used only to hydrate the
 * live seat for authenticated requests. Every other caller observes digest-only.
 */
export declare function getActiveSeatCredential(ref: string, binding: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
}): Promise<string | null>;
/**
 * Mint the client bearer for one seat, or return the existing record (pending or
 * active) so a lost-response retry re-sends the identical bearer. The minted
 * record has NO worktree binding — FINALIZE adds it atomically with activation,
 * so a pending record is never a live binding.
 */
export declare function mintPendingSeat(input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: SeatOperation;
    credential: string;
}): Promise<SeatRecord>;
/**
 * Typed prepare-time expectation for the single-store attach (CR#1). EXACT — the
 * exact prior ACTIVE record must STILL hold at prepare time (its ref, and, when
 * pinned, its drone id and its live-bearer digest). ABSENT — no ACTIVE record may
 * hold this seat (a fresh enroll / a fresh sibling seat). Field name `credentialRef`
 * is kept for call-site parity with the retired cross-store ExpectedBinding.
 */
export type SeatExpectation = {
    kind: 'exact';
    credentialRef: string;
    droneId?: string;
    sessionDigest?: string;
} | {
    kind: 'absent';
};
export type PrepareSeatOutcome = {
    ok: true;
    record: SeatRecord;
} | {
    ok: false;
    reason: 'expectation-mismatch';
};
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
export declare function prepareSeat(input: {
    expected: SeatExpectation;
    /** Default true. When false (a fresh sibling target key that cannot yet hold a
     *  record) the mint runs under the flock but no expectation is revalidated. */
    revalidate?: boolean;
    /** Eviction remint: delete the known-invalid saved record for this seat BEFORE
     *  minting a fresh bearer, still inside the one flock. */
    scrubBeforeMint?: boolean;
    seed: {
        origin: string;
        trustIdentity: string;
        cubeId: string;
        roleId: string;
        operation: SeatOperation;
        credential: string;
    };
}): Promise<PrepareSeatOutcome>;
export type ActivateSeatOutcome = 'activated' | 'missing' | 'replaced';
/** The worktree binding + display supplied at FINALIZE (known only once the target
 *  worktree is decided). Merged atomically with activation by activateAndBindSeat. */
export interface SeatBinding {
    worktree: string;
    name: string;
    droneLabel: string;
    roleName?: string;
    roleClass?: 'queen' | 'worker';
    isHumanSeat?: boolean;
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
export declare function activateAndBindSeat(input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: SeatOperation;
    droneId: string;
    sessionId: string;
    expiresAt: string;
    expectedPendingDigest: string;
    worktree: string;
    name: string;
    droneLabel: string;
    roleName?: string;
    roleClass?: 'queen' | 'worker';
    isHumanSeat?: boolean;
}): Promise<ActivateSeatOutcome>;
export type BindPendingSeatOutcome = 'bound' | 'missing' | 'replaced';
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
export declare function bindPendingSeatToWorktree(input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: SeatOperation;
    expectedPendingDigest: string;
    droneId?: string;
    worktree: string;
    name: string;
    droneLabel: string;
    roleName?: string;
    roleClass?: 'queen' | 'worker';
    isHumanSeat?: boolean;
}): Promise<BindPendingSeatOutcome>;
/** The exact ACTIVE seat bound to `worktree`, or null. A pending record (no
 *  worktree, or non-active) is NEVER surfaced as a live binding. */
export declare function getActiveSeatForWorktree(worktree: string): Promise<SeatRecord | null>;
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
export declare function getSeatForWorktree(worktree: string): Promise<SeatRecord | null>;
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
export declare function findIncompleteSiblingAttempt(binding: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    projectRoot: string;
}): Promise<SeatRecord | null>;
/** True iff this worktree has ANY persisted seat record (active OR a bound
 *  pending), so a crash-in-gap PENDING seat is discoverable (not mislabeled). */
export declare function hasSeatForWorktree(worktree: string): Promise<boolean>;
/** All ACTIVE bound seats — {worktree, record}. */
export declare function readAllActiveSeats(): Promise<Array<{
    worktree: string;
    record: SeatRecord;
}>>;
export type ResetSeatOutcome = {
    outcome: 'reset';
    ref: string;
} | {
    outcome: 'no-binding';
} | {
    outcome: 'changed';
};
/**
 * Reset the seat bound to `worktree`: under ONE flock, re-check the exact FULL
 * binding (ref + drone id) and the token-safe observation, then DELETE the whole
 * record — credential AND binding vanish together in one commit (no 'partial',
 * no cross-store skew). Any drift (missing / different ref or drone / same-ref
 * digest replacement) is an honest no-op.
 */
export declare function resetSeatForWorktree(expected: {
    worktree: string;
    ref: string;
    /** CR#4: undefined for a bound-PENDING record with no drone id yet — the reset
     *  matches undefined-vs-undefined and still deletes the exact record. */
    droneId?: string;
    observation: SeatObservation;
}): Promise<ResetSeatOutcome>;
/** Abort-scrub of the caller's OWN pending record only (CR#2 finalize abort):
 *  delete iff still pending AND digest matches — never an active record, never a
 *  same-ref replacement. */
export declare function scrubPendingSeat(ref: string, binding: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
}, expectedPendingDigest: string): Promise<boolean>;
/** Discard any record for one seat ref (eviction remint before a fresh mint). */
export declare function clearSeat(ref: string): Promise<void>;
/** Metadata-only refresh (name/label/role display) of the ACTIVE seat bound to
 *  `worktree` — CANNOT alter the credential, ref, identity, or worktree binding. */
export declare function refreshSeatMetadata(worktree: string, display: {
    name: string;
    droneLabel: string;
    roleName?: string;
    roleClass?: 'queen' | 'worker';
    isHumanSeat?: boolean;
}): Promise<void>;
/** @internal Test-only: point the store at a fixture path is done via HOME; this
 *  clears the module cache (there is none — every op reads fresh under the lock). */
//# sourceMappingURL=seats.d.ts.map