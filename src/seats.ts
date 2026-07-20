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
const SEATS_VERSION = 1 as const;
const REF_RE = /^borg-server-session:[a-f0-9]{64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SeatOperation {
  projectRoot: string;
  kind: 'seat' | 'sibling';
  operationKey: string;
}

/** One seat = its credential + binding + display, written as one atomic unit. */
export interface SeatRecord {
  // identity (the ref inputs)
  origin: string;
  trustIdentity: string;
  cubeId: string;
  roleId: string;
  operation: SeatOperation;
  // credential
  credential: string;
  state: 'pending' | 'active';
  // server metadata (active only)
  droneId?: string;
  sessionId?: string;
  expiresAt?: string;
  // binding + display (set atomically at FINALIZE; absent while pending)
  worktree?: string;
  name?: string;
  droneLabel?: string;
  roleName?: string;
  roleClass?: 'queen' | 'worker';
  isHumanSeat?: boolean;
}

interface SeatsFile {
  version: number;
  seats: Record<string, SeatRecord>;
}

/** The deterministic per-seat ref (identical algorithm to the retired keychain account). */
export function seatRef(input: {
  origin: string;
  trustIdentity: string;
  cubeId: string;
  roleId: string;
  operation: SeatOperation;
}): string {
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

function digestOf(bearer: string): string {
  return createHash('sha256').update(bearer).digest('hex');
}

function emptyStore(): SeatsFile {
  return { version: SEATS_VERSION, seats: {} };
}

const ROLE_CLASSES = new Set(['queen', 'worker']);
const OPERATION_KINDS = new Set(['seat', 'sibling']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidOperation(value: unknown): value is SeatOperation {
  if (value === null || typeof value !== 'object') return false;
  const op = value as Record<string, unknown>;
  return (
    isNonEmptyString(op.projectRoot) &&
    typeof op.kind === 'string' &&
    OPERATION_KINDS.has(op.kind) &&
    isNonEmptyString(op.operationKey)
  );
}

/**
 * CR#2: FULL per-entry validation. Every key/value/invariant of a seat record is
 * checked — the ref is well-formed and self-consistent (the map key equals the
 * record's derived ref), state ∈ {pending,active}, the credential is a non-empty
 * string, the operation is well-shaped, an ACTIVE record carries ALL its required
 * server + binding fields, and a PENDING record carries NO active-only fields
 * (session id / expiry). A single invalid entry ⇒ the whole store is rejected
 * (fail closed at the caller, bytes preserved) — never a silent cast.
 */
function isValidSeatRecord(ref: string, value: unknown): value is SeatRecord {
  if (!REF_RE.test(ref)) return false;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  // Identity + credential + operation.
  if (
    !isNonEmptyString(r.origin) ||
    !isNonEmptyString(r.trustIdentity) ||
    !isNonEmptyString(r.cubeId) ||
    !isNonEmptyString(r.roleId) ||
    !isValidOperation(r.operation) ||
    !isNonEmptyString(r.credential)
  ) {
    return false;
  }
  if (r.state !== 'pending' && r.state !== 'active') return false;
  // Optional display/typed fields, validated when present.
  if (r.name !== undefined && typeof r.name !== 'string') return false;
  if (r.droneLabel !== undefined && typeof r.droneLabel !== 'string') return false;
  if (r.roleName !== undefined && typeof r.roleName !== 'string') return false;
  if (r.roleClass !== undefined && (typeof r.roleClass !== 'string' || !ROLE_CLASSES.has(r.roleClass))) return false;
  if (r.isHumanSeat !== undefined && typeof r.isHumanSeat !== 'boolean') return false;
  if (r.worktree !== undefined && typeof r.worktree !== 'string') return false;
  if (r.droneId !== undefined && (typeof r.droneId !== 'string' || !UUID_RE.test(r.droneId))) return false;
  if (r.sessionId !== undefined && (typeof r.sessionId !== 'string' || !UUID_RE.test(r.sessionId))) return false;
  if (
    r.expiresAt !== undefined &&
    (typeof r.expiresAt !== 'string' || !Number.isFinite(Date.parse(r.expiresAt)))
  ) {
    return false;
  }
  // State-consistency invariants (no inconsistent active|pending).
  if (r.state === 'active') {
    // An ACTIVE record MUST carry its full server session + worktree binding.
    if (
      typeof r.droneId !== 'string' ||
      typeof r.sessionId !== 'string' ||
      typeof r.expiresAt !== 'string' ||
      typeof r.worktree !== 'string' ||
      typeof r.name !== 'string' ||
      typeof r.droneLabel !== 'string'
    ) {
      return false;
    }
  } else {
    // A PENDING record must NOT carry active-only server session fields.
    if (r.sessionId !== undefined || r.expiresAt !== undefined) return false;
  }
  // The map key must equal the record's derived ref (no cross-key aliasing).
  return seatRef(value as SeatRecord) === ref;
}

/**
 * CR4 + CR#2: parse + FULL version/schema/per-entry validation. Returns null (→ fail
 * closed at the caller, bytes preserved) for any malformed JSON, wrong version, or
 * ANY invalid entry; never throws and never coerces an invalid file into a
 * valid-looking or empty store.
 */
function parseStore(raw: string): SeatsFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const candidate = parsed as { version?: unknown; seats?: unknown };
    if (
      candidate.version === SEATS_VERSION &&
      candidate.seats &&
      typeof candidate.seats === 'object' &&
      !Array.isArray(candidate.seats)
    ) {
      const seats = candidate.seats as Record<string, unknown>;
      for (const [ref, record] of Object.entries(seats)) {
        if (!isValidSeatRecord(ref, record)) return null;
      }
      return { version: SEATS_VERSION, seats: seats as Record<string, SeatRecord> };
    }
  }
  return null;
}

async function readStore(): Promise<SeatsFile> {
  const raw = await readStoreFile(SEATS_FILE);
  // CR4 fail-closed: ENOENT alone initializes empty. A present-but-malformed /
  // wrong-version / schema-invalid store MUST NOT read as empty (a following commit
  // would erase every seat); throw so the on-disk bytes are preserved.
  if (raw === null) return emptyStore();
  const parsed = parseStore(raw);
  if (parsed === null) {
    throw new Error(
      'Borg seat store is malformed or has an unsupported version; refusing to read it',
    );
  }
  return parsed;
}

/** True iff `record` is a well-formed seat for `ref` + `binding` (origin/trust/cube). */
function recordMatches(
  record: SeatRecord | undefined,
  ref: string,
  binding: { origin: string; trustIdentity: string; cubeId: string },
): record is SeatRecord {
  return (
    record !== undefined &&
    record.origin === binding.origin &&
    record.trustIdentity === binding.trustIdentity &&
    record.cubeId === binding.cubeId &&
    (record.state === 'pending' || record.state === 'active') &&
    typeof record.credential === 'string' &&
    seatRef(record) === ref
  );
}

// ─── Observation (digest-only; raw bearer never returned) ────────────────────

export type SeatObservation =
  | { state: 'active'; digest: string; droneId: string }
  | { state: 'pending'; digest: string }
  | { state: 'absent' };

/**
 * TYPED, token-safe observation of the record at `ref` (CR#3). Lock-free read
 * (atomic rename → complete file); the authoritative delete/activate re-reads
 * under the flock. Returns only a digest + drone id, never the raw bearer.
 */
export async function observeSeat(
  ref: string,
  binding: { origin: string; trustIdentity: string; cubeId: string },
): Promise<SeatObservation> {
  if (!REF_RE.test(ref)) return { state: 'absent' };
  const store = await readStore();
  const record = store.seats[ref];
  if (!recordMatches(record, ref, binding)) return { state: 'absent' };
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
export async function getActiveSeatCredential(
  ref: string,
  binding: { origin: string; trustIdentity: string; cubeId: string },
): Promise<string | null> {
  if (!REF_RE.test(ref)) return null;
  const store = await readStore();
  const record = store.seats[ref];
  if (!recordMatches(record, ref, binding) || record.state !== 'active') return null;
  return record.credential;
}

// ─── PREPARE / mint (no worktree yet) ────────────────────────────────────────

/**
 * Mint the client bearer for one seat, or return the existing record (pending or
 * active) so a lost-response retry re-sends the identical bearer. The minted
 * record has NO worktree binding — FINALIZE adds it atomically with activation,
 * so a pending record is never a live binding.
 */
export async function mintPendingSeat(input: {
  origin: string;
  trustIdentity: string;
  cubeId: string;
  roleId: string;
  operation: SeatOperation;
  credential: string;
}): Promise<SeatRecord> {
  const ref = seatRef(input);
  return withStore<SeatsFile, SeatRecord>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    const existing = txn.data.seats[ref];
    if (recordMatches(existing, ref, { origin: input.origin, trustIdentity: input.trustIdentity, cubeId: input.cubeId })) {
      return existing;
    }
    const record: SeatRecord = {
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

// ─── PREPARE (revalidate typed expectation + mint, under ONE flock) ──────────

/**
 * Typed prepare-time expectation for the single-store attach (CR#1). EXACT — the
 * exact prior ACTIVE record must STILL hold at prepare time (its ref, and, when
 * pinned, its drone id and its live-bearer digest). ABSENT — no ACTIVE record may
 * hold this seat (a fresh enroll / a fresh sibling seat). Field name `credentialRef`
 * is kept for call-site parity with the retired cross-store ExpectedBinding.
 */
export type SeatExpectation =
  | { kind: 'exact'; credentialRef: string; droneId?: string; sessionDigest?: string }
  | { kind: 'absent' };

export type PrepareSeatOutcome =
  | { ok: true; record: SeatRecord }
  | { ok: false; reason: 'expectation-mismatch' };

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
export async function prepareSeat(input: {
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
}): Promise<PrepareSeatOutcome> {
  const { expected, revalidate = true, scrubBeforeMint = false, seed } = input;
  const ref = seatRef(seed);
  const binding = { origin: seed.origin, trustIdentity: seed.trustIdentity, cubeId: seed.cubeId };
  return withStore<SeatsFile, PrepareSeatOutcome>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    if (revalidate) {
      const prior = txn.data.seats[ref];
      let mismatch: boolean;
      if (expected.kind === 'exact') {
        const holds =
          recordMatches(prior, ref, binding) &&
          prior.state === 'active' &&
          ref === expected.credentialRef &&
          (expected.droneId === undefined || prior.droneId === expected.droneId) &&
          (expected.sessionDigest === undefined || digestOf(prior.credential) === expected.sessionDigest);
        mismatch = !holds;
      } else {
        // ABSENT: an ACTIVE record holding this seat is a mismatch. A PENDING record
        // (a lost-response retry / crash-in-gap) is NOT a live binding and is reused
        // below so the identical bearer is re-sent.
        mismatch = recordMatches(prior, ref, binding) && prior.state === 'active';
      }
      if (mismatch) return { ok: false as const, reason: 'expectation-mismatch' as const };
    }
    if (scrubBeforeMint) {
      delete txn.data.seats[ref];
    }
    const existing = txn.data.seats[ref];
    if (recordMatches(existing, ref, binding)) {
      // Idempotent reuse: re-send the exact bearer the server already digest-bound
      // (a lost-response retry, a crash-in-gap pending, or an active reattach).
      return { ok: true as const, record: existing };
    }
    const record: SeatRecord = {
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
    return { ok: true as const, record };
  });
}

// ─── FINALIZE (activate + bind in ONE commit) ────────────────────────────────

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
export async function activateAndBindSeat(input: {
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
}): Promise<ActivateSeatOutcome> {
  if (!UUID_RE.test(input.droneId) || !UUID_RE.test(input.sessionId)) {
    throw new Error('invalid Borg server session identity');
  }
  if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error('invalid Borg server session expiry');
  }
  const ref = seatRef(input);
  const binding = { origin: input.origin, trustIdentity: input.trustIdentity, cubeId: input.cubeId };
  return withStore<SeatsFile, ActivateSeatOutcome>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    const record = txn.data.seats[ref];
    if (!recordMatches(record, ref, binding)) return 'missing';
    if (digestOf(record.credential) !== input.expectedPendingDigest) return 'replaced';
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

// ─── CR#2: bind a PENDING record to a preserved worktree (no activation) ─────

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
export async function bindPendingSeatToWorktree(input: {
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
}): Promise<BindPendingSeatOutcome> {
  if (input.droneId !== undefined && !UUID_RE.test(input.droneId)) {
    throw new Error('invalid Borg server session identity');
  }
  const ref = seatRef(input);
  const binding = { origin: input.origin, trustIdentity: input.trustIdentity, cubeId: input.cubeId };
  return withStore<SeatsFile, BindPendingSeatOutcome>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    const record = txn.data.seats[ref];
    if (!recordMatches(record, ref, binding)) return 'missing';
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
export async function getActiveSeatForWorktree(worktree: string): Promise<SeatRecord | null> {
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
export async function getSeatForWorktree(worktree: string): Promise<SeatRecord | null> {
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
export async function findIncompleteSiblingAttempt(binding: {
  origin: string;
  trustIdentity: string;
  cubeId: string;
  projectRoot: string;
}): Promise<SeatRecord | null> {
  const store = await readStore();
  for (const [ref, record] of Object.entries(store.seats)) {
    if (
      record.state === 'pending' &&
      record.worktree === undefined &&
      record.operation.kind === 'sibling' &&
      record.origin === binding.origin &&
      record.trustIdentity === binding.trustIdentity &&
      record.cubeId === binding.cubeId &&
      record.operation.projectRoot === binding.projectRoot &&
      seatRef(record) === ref
    ) {
      return record;
    }
  }
  return null;
}

/** True iff this worktree has ANY persisted seat record (active OR a bound
 *  pending), so a crash-in-gap PENDING seat is discoverable (not mislabeled). */
export async function hasSeatForWorktree(worktree: string): Promise<boolean> {
  const store = await readStore();
  return Object.values(store.seats).some((r) => r.worktree === worktree);
}

/** All ACTIVE bound seats — {worktree, record}. */
export async function readAllActiveSeats(): Promise<Array<{ worktree: string; record: SeatRecord }>> {
  const store = await readStore();
  const out: Array<{ worktree: string; record: SeatRecord }> = [];
  for (const [ref, record] of Object.entries(store.seats)) {
    if (record.state === 'active' && typeof record.worktree === 'string' && seatRef(record) === ref) {
      out.push({ worktree: record.worktree, record });
    }
  }
  return out;
}

// ─── Reset / scrub / metadata (all single-commit) ────────────────────────────

export type ResetSeatOutcome =
  | { outcome: 'reset'; ref: string }
  | { outcome: 'no-binding' }
  | { outcome: 'changed' };

/**
 * Reset the seat bound to `worktree`: under ONE flock, re-check the exact FULL
 * binding (ref + drone id) and the token-safe observation, then DELETE the whole
 * record — credential AND binding vanish together in one commit (no 'partial',
 * no cross-store skew). Any drift (missing / different ref or drone / same-ref
 * digest replacement) is an honest no-op.
 */
export async function resetSeatForWorktree(expected: {
  worktree: string;
  ref: string;
  /** CR#4: undefined for a bound-PENDING record with no drone id yet — the reset
   *  matches undefined-vs-undefined and still deletes the exact record. */
  droneId?: string;
  observation: SeatObservation;
}): Promise<ResetSeatOutcome> {
  return withStore<SeatsFile, ResetSeatOutcome>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    const record = txn.data.seats[expected.ref];
    if (
      record === undefined ||
      record.worktree !== expected.worktree ||
      record.droneId !== expected.droneId ||
      seatRef(record) !== expected.ref
    ) {
      // Look for whether ANY record still binds this worktree — if not, no-op.
      const anyBound = Object.values(txn.data.seats).some((r) => r.worktree === expected.worktree);
      return anyBound ? { outcome: 'changed' as const } : { outcome: 'no-binding' as const };
    }
    // Same-ref replacement guard: the live digest must still match the snapshot.
    const expDigest = expected.observation.state === 'absent' ? null : expected.observation.digest;
    if (expDigest !== null && digestOf(record.credential) !== expDigest) {
      return { outcome: 'changed' as const };
    }
    delete txn.data.seats[expected.ref];
    await txn.commit();
    return { outcome: 'reset' as const, ref: expected.ref };
  });
}

/** Abort-scrub of the caller's OWN pending record only (CR#2 finalize abort):
 *  delete iff still pending AND digest matches — never an active record, never a
 *  same-ref replacement. */
export async function scrubPendingSeat(
  ref: string,
  binding: { origin: string; trustIdentity: string; cubeId: string },
  expectedPendingDigest: string,
): Promise<boolean> {
  if (!REF_RE.test(ref)) return false;
  return withStore<SeatsFile, boolean>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    const record = txn.data.seats[ref];
    if (!recordMatches(record, ref, binding) || record.state !== 'pending') return false;
    if (digestOf(record.credential) !== expectedPendingDigest) return false;
    delete txn.data.seats[ref];
    await txn.commit();
    return true;
  });
}

/** Discard any record for one seat ref (eviction remint before a fresh mint). */
export async function clearSeat(ref: string): Promise<void> {
  if (!REF_RE.test(ref)) throw new Error('invalid Borg server session credential reference');
  await withStore<SeatsFile, void>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    if (txn.data.seats[ref] !== undefined) {
      delete txn.data.seats[ref];
      await txn.commit();
    }
  });
}

/** Metadata-only refresh of one exact ACTIVE seat. The expected tuple prevents
 * a delayed response from updating a replacement seat that reused the worktree. */
export async function refreshSeatMetadata(
  worktree: string,
  expected: { credentialRef: string; cubeId: string; droneId: string },
  display: { name: string; droneLabel: string; roleName?: string; roleClass?: 'queen' | 'worker'; isHumanSeat?: boolean },
): Promise<boolean> {
  if (!REF_RE.test(expected.credentialRef)) return false;
  return withStore<SeatsFile, boolean>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    const record = txn.data.seats[expected.credentialRef];
    if (record?.state !== 'active' || record.worktree !== worktree ||
        record.cubeId !== expected.cubeId || record.droneId !== expected.droneId ||
        seatRef(record) !== expected.credentialRef) return false;
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
