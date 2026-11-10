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
 * the 0600 file and is returned only to the attach sender or active hydration
 * reader; identity observations are digest-only.
 */

import path from 'path';
import { lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { readStoreFile, withStore } from './seat-store.js';
import { LegacySessionCredentialCollisionError } from './server-errors.js';
import { borgConfigRoot } from './private-root.js';
import { shellEscape } from './shell-escape.js';
import { deriveAttachmentReceipt, decodeAttachmentReceipt, ErrorCode, type ReconcileAttachmentAction, type ReconcileAttachmentResponse } from 'borgmcp-shared';

export const SEATS_FILE = path.join(borgConfigRoot(), 'seats.json');
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
  attachmentAttempt?: string;
  /** Monotonic store-local order assigned when this record is bound active. */
  bindingOrder?: number;
  // server metadata (active only)
  droneId?: string;
  sessionId?: string;
  // binding + display (set atomically at FINALIZE; absent while pending)
  worktree?: string;
  commonDir?: string;
  repositoryOrigin?: string;
  name?: string;
  droneLabel?: string;
  roleName?: string;
  roleClass?: 'queen' | 'worker';
  isHumanSeat?: boolean;
}

interface SeatsFile {
  version: number;
  seats: Record<string, SeatRecord>;
  attachments: Record<string, AttachmentAttempt>;
}

export interface AttachmentAttempt {
  attempt: string;
  receipt: string;
  origin: string;
  trustIdentity: string;
  clientId: string;
  cubeId: string;
  roleId: string;
  priorDroneId?: string;
  credentialRef: string;
  pendingDigest: string;
  operation: SeatOperation;
  targetWorktree?: string;
  disposition: 'unresolved' | 'ack-pending' | 'finalized' | 'cleanup-only' | 'retired';
  droneId?: string;
  sessionId?: string;
}

export class AttachmentRecoveryRequiredError extends Error {
  constructor(readonly attempt: string, origin: string) {
    super(`An earlier attachment needs recovery before creating another connection. Run: borg recover-attachment --host ${shellEscape(origin)} --attempt ${attempt}`);
    this.name = 'AttachmentRecoveryRequiredError';
  }
}

export class AttachmentAttemptUnavailableError extends Error {
  constructor() {
    super('The requested attachment recovery attempt is not available from this worktree and authority.');
    this.name = 'AttachmentAttemptUnavailableError';
  }
}

function operationClass(operation: SeatOperation, targetWorktree?: string): string {
  return operation.kind === 'seat' || targetWorktree === operation.projectRoot ? 'seat' : operation.operationKey.startsWith('implicit-sibling:')
    ? 'implicit-sibling' : operation.operationKey;
}

export function isAttachmentAttempt(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function cleanupAttachment(store: SeatsFile, record: SeatRecord): void {
  const entry = record.attachmentAttempt === undefined ? undefined : store.attachments[String(record.attachmentAttempt)];
  if (entry && entry.pendingDigest === digestOf(record.credential) && entry.disposition !== 'retired') {
    entry.disposition = 'cleanup-only';
  }
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
  return { version: SEATS_VERSION, seats: {}, attachments: {} };
}

const ROLE_CLASSES = new Set(['queen', 'worker']);
const OPERATION_KINDS = new Set(['seat', 'sibling']);
const SEAT_BEARER_RE = /^[A-Za-z0-9_-]{43,1024}$/;
const rejectedSeatRefs = new Set<string>();

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
 * record's derived ref), state ∈ {pending,active}, the credential is an exact
 * 32-byte base64url bearer, the operation is well-shaped, an ACTIVE record carries
 * ALL its required server + binding fields, and a PENDING record carries NO
 * active-only session id. A single invalid entry ⇒ the whole store is rejected
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
    typeof r.credential !== 'string' ||
    !SEAT_BEARER_RE.test(r.credential)
  ) {
    return false;
  }
  if (r.state !== 'pending' && r.state !== 'active') return false;
  if (r.attachmentAttempt !== undefined && !isAttachmentAttempt(r.attachmentAttempt)) return false;
  if (r.bindingOrder !== undefined &&
      (typeof r.bindingOrder !== 'number' || !Number.isSafeInteger(r.bindingOrder) || r.bindingOrder < 1)) return false;
  // Optional display/typed fields, validated when present.
  if (r.name !== undefined && typeof r.name !== 'string') return false;
  if (r.droneLabel !== undefined && typeof r.droneLabel !== 'string') return false;
  if (r.roleName !== undefined && typeof r.roleName !== 'string') return false;
  if (r.roleClass !== undefined && (typeof r.roleClass !== 'string' || !ROLE_CLASSES.has(r.roleClass))) return false;
  if (r.isHumanSeat !== undefined && typeof r.isHumanSeat !== 'boolean') return false;
  if (r.worktree !== undefined && typeof r.worktree !== 'string') return false;
  if (r.commonDir !== undefined && !isNonEmptyString(r.commonDir)) return false;
  if (r.repositoryOrigin !== undefined && !isNonEmptyString(r.repositoryOrigin)) return false;
  if (r.droneId !== undefined && (typeof r.droneId !== 'string' || !UUID_RE.test(r.droneId))) return false;
  if (r.sessionId !== undefined && (typeof r.sessionId !== 'string' || !UUID_RE.test(r.sessionId))) return false;
  // State-consistency invariants (no inconsistent active|pending).
  if (r.state === 'active') {
    // An ACTIVE record MUST carry its full server session + worktree binding.
    if (
      typeof r.droneId !== 'string' ||
      typeof r.sessionId !== 'string' ||
      typeof r.worktree !== 'string' ||
      typeof r.name !== 'string' ||
      typeof r.droneLabel !== 'string'
    ) {
      return false;
    }
  } else {
    // A PENDING record must NOT carry active-only server session fields.
    if (r.sessionId !== undefined || r.bindingOrder !== undefined) return false;
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
    const candidate = parsed as { version?: unknown; seats?: unknown; attachments?: unknown };
    if (
      candidate.version === SEATS_VERSION &&
      candidate.seats &&
      typeof candidate.seats === 'object' &&
      !Array.isArray(candidate.seats)
    ) {
      const seats = candidate.seats as Record<string, unknown>;
      for (const [ref, record] of Object.entries(seats)) {
        if (
          record !== null &&
          typeof record === 'object' &&
          !Array.isArray(record) &&
          Object.prototype.hasOwnProperty.call(record, 'replacement')
        ) {
          const { replacement, ...withoutReplacement } = record as Record<string, unknown>;
          const exactReplacement =
            replacement !== null &&
            typeof replacement === 'object' &&
            !Array.isArray(replacement) &&
            Object.keys(replacement).length === 1 &&
            typeof (replacement as { credential?: unknown }).credential === 'string' &&
            SEAT_BEARER_RE.test((replacement as { credential: string }).credential);
          let canonicalOrigin = false;
          try {
            const origin = new URL(String(withoutReplacement.origin));
            canonicalOrigin = origin.protocol === 'https:' && origin.origin === withoutReplacement.origin;
          } catch {
            canonicalOrigin = false;
          }
          if (
            withoutReplacement.state === 'active' &&
            exactReplacement &&
            canonicalOrigin &&
            isValidSeatRecord(ref, withoutReplacement)
          ) {
            throw new LegacySessionCredentialCollisionError(withoutReplacement.origin as string);
          }
          return null;
        }
        if (!isValidSeatRecord(ref, record)) return null;
      }
      const hasAttachments = Object.hasOwn(candidate, 'attachments');
      const attachments = hasAttachments ? candidate.attachments : {};
      if (typeof attachments !== 'object' || attachments === null || Array.isArray(attachments)) return null;
      for (const [key, value] of Object.entries(attachments)) {
        if (!isValidAttachmentAttempt(key, value)) return null;
        const record = seats[value.credentialRef] as SeatRecord | undefined;
        if (record && digestOf(record.credential) === value.pendingDigest && record.attachmentAttempt !== value.attempt) return null;
      }
      for (const record of Object.values(seats) as SeatRecord[]) {
        if (record.attachmentAttempt !== undefined) {
          const entry = (attachments as Record<string, AttachmentAttempt>)[String(record.attachmentAttempt)];
          if (!entry || entry.credentialRef !== seatRef(record) || entry.pendingDigest !== digestOf(record.credential)) return null;
          if (record.state === 'active' &&
              (!['ack-pending', 'finalized'].includes(entry.disposition) || entry.droneId !== record.droneId ||
               entry.sessionId !== record.sessionId || entry.targetWorktree !== record.worktree)) return null;
          if (record.state === 'pending' && entry.disposition !== 'unresolved') return null;
        }
      }
      const store: SeatsFile = { version: SEATS_VERSION, seats: seats as Record<string, SeatRecord>,
        attachments: attachments as Record<string, AttachmentAttempt> };
      repairOrderedDuplicateBindings(store);
      return store;
    }
  }
  return null;
}

function isValidAttachmentAttempt(key: string, value: unknown): value is AttachmentAttempt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as AttachmentAttempt;
  try { decodeAttachmentReceipt(entry.receipt); } catch { return false; }
  return isAttachmentAttempt(entry.attempt) && entry.attempt === key &&
    /^[a-f0-9]{64}$/.test(entry.pendingDigest) &&
    isNonEmptyString(entry.origin) && isNonEmptyString(entry.trustIdentity) &&
    UUID_RE.test(entry.clientId) && UUID_RE.test(entry.cubeId) && UUID_RE.test(entry.roleId) &&
    (entry.priorDroneId === undefined || UUID_RE.test(entry.priorDroneId)) &&
    isValidOperation(entry.operation) && entry.credentialRef === seatRef(entry) &&
    (entry.targetWorktree === undefined || isNonEmptyString(entry.targetWorktree)) &&
    ['unresolved', 'ack-pending', 'finalized', 'cleanup-only', 'retired'].includes(entry.disposition) &&
    (entry.droneId === undefined || UUID_RE.test(entry.droneId)) &&
    (entry.sessionId === undefined || UUID_RE.test(entry.sessionId)) &&
    (!['ack-pending', 'finalized'].includes(entry.disposition) || (entry.droneId !== undefined && entry.sessionId !== undefined));
}

export async function readAttachmentAttempt(input: {
  attempt: string; origin: string; trustIdentity: string; clientId: string; worktree: string;
}): Promise<AttachmentAttempt> {
  const entry = (await readStore()).attachments[String(input.attempt)];
  if (!entry || entry.origin !== input.origin || entry.trustIdentity !== input.trustIdentity ||
      entry.clientId !== input.clientId ||
      (entry.operation.projectRoot !== input.worktree && entry.targetWorktree !== input.worktree)) {
    throw new AttachmentAttemptUnavailableError();
  }
  return entry;
}

export async function reserveAttachmentTarget(attempt: string, targetWorktree: string, failedCollisionTarget?: string): Promise<void> {
  await withStore<SeatsFile, void>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    const entry = txn.data.attachments[String(attempt)];
    const record = entry && txn.data.seats[entry.credentialRef];
    if (!entry || !record || record.attachmentAttempt !== attempt || record.state !== 'pending' ||
        entry.pendingDigest !== digestOf(record.credential) || entry.disposition !== 'unresolved' ||
        (failedCollisionTarget === undefined
          ? entry.targetWorktree !== undefined && entry.targetWorktree !== targetWorktree
          : entry.targetWorktree !== failedCollisionTarget || record.worktree !== undefined ||
            !await absentAttachmentTarget(failedCollisionTarget) || !await absentAttachmentTarget(targetWorktree)) ||
        Object.values(txn.data.attachments).some(other => other.attempt !== attempt && other.targetWorktree === targetWorktree &&
          other.disposition !== 'finalized' && other.disposition !== 'retired') ||
        Object.values(txn.data.seats).some(candidate => candidate !== record && candidate.worktree === targetWorktree)) {
      throw new Error('Attachment target changed; no connection was rebound');
    }
    entry.targetWorktree = targetWorktree;
    await txn.commit();
  });
}

export type AttachmentRecoveryState =
  | { kind: 'pending'; entry: AttachmentAttempt; record: SeatRecord }
  | { kind: 'active' | 'retired' | 'cleanup-only' | 'target-missing' };

async function absentAttachmentTarget(target: string): Promise<boolean> {
  try { await lstat(target); return false; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

/** Recovery owns the same flock as reset/finalize; remote callbacks must be bounded
 * and must not call another seat-store transaction. */
export async function recoverAttachmentAttempt(input: {
  attempt: string; origin: string; trustIdentity: string; clientId: string; worktree: string;
  retire: boolean;
  expected?: { observation: SeatObservation; targetWorktree?: string };
  targetAbsent?: (target: string) => Promise<boolean>;
  reconcile: (entry: AttachmentAttempt, action: ReconcileAttachmentAction) => Promise<ReconcileAttachmentResponse>;
}): Promise<AttachmentRecoveryState> {
  return withStore<SeatsFile, AttachmentRecoveryState>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    let entry = txn.data.attachments[String(input.attempt)];
    if (!entry || entry.origin !== input.origin || entry.trustIdentity !== input.trustIdentity || entry.clientId !== input.clientId ||
        (entry.operation.projectRoot !== input.worktree && entry.targetWorktree !== input.worktree)) {
      throw new AttachmentAttemptUnavailableError();
    }
    const record = txn.data.seats[entry.credentialRef];
    if (input.expected) {
      const expected = input.expected.observation;
      if (input.expected.targetWorktree !== entry.targetWorktree ||
          (expected.state === 'absent' ? record !== undefined :
            !record || expected.state !== record.state || expected.digest !== digestOf(record.credential) ||
            (expected.state === 'active' && expected.droneId !== record.droneId))) {
        throw new Error('Attachment state changed during recovery consent; nothing was changed');
      }
    }
    const exact = record?.attachmentAttempt === entry.attempt && digestOf(record.credential) === entry.pendingDigest;
    if (exact && record.state === 'active') {
      if (input.retire || entry.disposition === 'cleanup-only' || entry.disposition === 'retired') {
        throw new Error('An active attachment cannot be retired by pending-attachment recovery');
      }
      if (entry.disposition !== 'finalized') {
        // Confirm local durability even after an earlier rename/sync ambiguity.
        await txn.commit();
      }
      // Repeated recovery still checks current parent/grant and terminal state;
      // a historical local ACTIVE bit is not proof of a live server session.
      const result = await input.reconcile(entry, 'finalize');
      if (result.disposition !== 'finalized' || result.drone_id !== record.droneId || result.session_id !== record.sessionId) {
        throw new Error('Attachment finalization identity did not match the local connection');
      }
      if (entry.disposition !== 'finalized') {
        entry.disposition = 'finalized';
        await txn.commit();
      }
      return { kind: 'active' };
    }
    if (exact && record.state === 'pending' && entry.disposition === 'unresolved') {
      const absentTarget = entry.targetWorktree !== undefined &&
        await (input.targetAbsent ?? absentAttachmentTarget)(entry.targetWorktree);
      if (!absentTarget) {
        if (input.retire) throw new Error('The original pending connection still exists; retry attachment recovery without --retire');
        // Observed bytes may have survived a failed post-rename sync. Confirm
        // this exact PREPARE durably before returning a network-capable retry.
        await txn.commit();
        return { kind: 'pending', entry, record };
      }
      // A reservation-before-add crash and an operator-removed target are
      // indistinguishable. Neither authorizes silent recreation or default scrub.
      if (!input.retire) return { kind: 'target-missing' };
      entry.disposition = 'cleanup-only';
      delete txn.data.seats[entry.credentialRef];
      try { await txn.commit(); }
      catch {
        const observed = await readStore();
        const persisted = observed.attachments[String(entry.attempt)];
        if (observed.seats[entry.credentialRef] || persisted?.disposition !== 'cleanup-only') {
          throw new Error('Attachment cleanup durability could not be confirmed');
        }
        Object.assign(txn.data, observed);
        entry = txn.data.attachments[String(input.attempt)];
        await txn.commit();
      }
    }
    if (entry.disposition !== 'retired') {
      entry.disposition = 'cleanup-only';
      await txn.commit();
    }
    if (!input.retire) {
      if (entry.disposition !== 'retired') return { kind: 'cleanup-only' };
      const confirmed = await input.reconcile(entry, 'inspect');
      if (confirmed.disposition !== 'retired') throw new Error('Attachment retirement could not be confirmed');
      return { kind: 'retired' };
    }
    const result = await input.reconcile(entry, 'retire');
    if (result.disposition !== 'retired') throw new Error('Attachment retirement could not be confirmed');
    entry.disposition = 'retired';
    await txn.commit();
    return { kind: 'retired' };
  });
}

/**
 * Remove superseded worktree bindings when persisted ordering proves which bind
 * is newest. The mutation is persisted by the next transaction that commits.
 * Legacy duplicates without a complete, unique order stay intact and fail
 * closed when that worktree is resolved.
 */
function repairOrderedDuplicateBindings(store: SeatsFile): void {
  const byWorktree = new Map<string, Array<[string, SeatRecord]>>();
  for (const entry of Object.entries(store.seats)) {
    const [, record] = entry;
    if (record.state !== 'active' || record.worktree === undefined) continue;
    const candidates = byWorktree.get(record.worktree) ?? [];
    candidates.push(entry);
    byWorktree.set(record.worktree, candidates);
  }
  for (const candidates of byWorktree.values()) {
    if (candidates.length < 2) continue;
    const ordered = candidates.filter(
      (entry): entry is [string, SeatRecord & { bindingOrder: number }] =>
        entry[1].bindingOrder !== undefined,
    );
    if (ordered.length === 0) continue;
    const orders = ordered.map(([, record]) => record.bindingOrder);
    if (new Set(orders).size !== orders.length) continue;
    const newest = ordered.reduce((left, right) =>
      left[1].bindingOrder > right[1].bindingOrder ? left : right);
    for (const [ref] of candidates) {
      if (ref !== newest[0]) {
        cleanupAttachment(store, store.seats[ref]);
        delete store.seats[ref];
      }
    }
  }
}

export class AmbiguousSeatBindingError extends Error {
  constructor(worktree: string) {
    super(
      `Borg found multiple active seats for worktree ${worktree}, but their bind order is unavailable. ` +
      'No identity or inbox path was selected. Run `borg reset-local-connection` to clear the ambiguous local connection.',
    );
    this.name = 'AmbiguousSeatBindingError';
  }
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
      'Borg private store is malformed or has an unsupported version; refusing to read it',
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
    rejectedSeatRefs.delete(ref);
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
  attachment?: { clientId: string; priorDroneId?: string; targetWorktree?: string };
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
  if (input.attachment && (!UUID_RE.test(input.attachment.clientId) ||
      (input.attachment.priorDroneId !== undefined && !UUID_RE.test(input.attachment.priorDroneId)))) {
    throw new Error('Invalid attachment ownership identity');
  }
  const ref = seatRef(seed);
  const binding = { origin: seed.origin, trustIdentity: seed.trustIdentity, cubeId: seed.cubeId };
  return withStore<SeatsFile, PrepareSeatOutcome>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    if (input.attachment) {
      for (const entry of Object.values(txn.data.attachments)) {
        if (entry.origin !== seed.origin || entry.trustIdentity !== seed.trustIdentity ||
            entry.clientId !== input.attachment.clientId || entry.cubeId !== seed.cubeId ||
            entry.disposition === 'finalized' || entry.disposition === 'retired') continue;
        const sameOperation = entry.operation.projectRoot === seed.operation.projectRoot &&
          operationClass(entry.operation, entry.targetWorktree) === operationClass(seed.operation, input.attachment.targetWorktree);
        const sameTarget = input.attachment.targetWorktree !== undefined && entry.targetWorktree === input.attachment.targetWorktree;
        const current = txn.data.seats[ref];
        const activeReuse = !scrubBeforeMint && recordMatches(current, ref, binding) && current.state === 'active' &&
          current.attachmentAttempt !== undefined &&
          txn.data.attachments[String(current.attachmentAttempt)].clientId === input.attachment.clientId;
        const exactRetry = !scrubBeforeMint && current?.attachmentAttempt === entry.attempt &&
          ref === entry.credentialRef && digestOf(current.credential) === entry.pendingDigest &&
          entry.roleId === seed.roleId && entry.priorDroneId === input.attachment.priorDroneId &&
          (entry.disposition === 'unresolved' || entry.disposition === 'ack-pending');
        if ((sameOperation || sameTarget) && !exactRetry && !activeReuse) throw new AttachmentRecoveryRequiredError(entry.attempt, entry.origin);
        if (exactRetry && entry.targetWorktree !== undefined && await absentAttachmentTarget(entry.targetWorktree)) {
          throw new AttachmentRecoveryRequiredError(entry.attempt, entry.origin);
        }
      }
    }
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
      if (input.attachment && existing.attachmentAttempt !== undefined &&
          txn.data.attachments[String(existing.attachmentAttempt)].clientId !== input.attachment.clientId) {
        throw new Error('The saved attachment belongs to a different enrolled client');
      }
      // Idempotent reuse: re-send the exact bearer the server already digest-bound
      // (a lost-response retry, a crash-in-gap pending, or an active reattach).
      if (input.attachment && existing.attachmentAttempt === undefined) {
        await journalPendingAttachment(txn.data, existing, input.attachment);
      }
      if (existing.attachmentAttempt !== undefined) {
        // A previous PREPARE may have renamed successfully and failed sync.
        // Reusing its bearer still requires confirmed durability before send.
        await txn.commit();
      }
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
    if (input.attachment) await journalPendingAttachment(txn.data, record, input.attachment);
    await txn.commit();
    rejectedSeatRefs.delete(ref);
    return { ok: true as const, record };
  });
}

async function journalPendingAttachment(store: SeatsFile, record: SeatRecord,
  attachment: { clientId: string; priorDroneId?: string; targetWorktree?: string }): Promise<void> {
  const attempt = randomUUID();
  if (Object.hasOwn(store.attachments, attempt)) throw new Error('Could not allocate a unique attachment recovery handle');
  const receipt = await deriveAttachmentReceipt(record.credential);
  record.attachmentAttempt = attempt;
  store.attachments[String(attempt)] = {
    attempt, receipt, origin: record.origin, trustIdentity: record.trustIdentity,
    clientId: attachment.clientId, cubeId: record.cubeId, roleId: record.roleId,
    ...(attachment.priorDroneId === undefined ? {} : { priorDroneId: attachment.priorDroneId }),
    credentialRef: seatRef(record), pendingDigest: digestOf(record.credential), operation: record.operation,
    ...((attachment.targetWorktree ?? record.worktree) === undefined ? {} : { targetWorktree: attachment.targetWorktree ?? record.worktree }),
    disposition: record.state === 'active' ? 'ack-pending' : 'unresolved',
    ...(record.droneId === undefined ? {} : { droneId: record.droneId }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
  };
}

// ─── FINALIZE (activate + bind in ONE commit) ────────────────────────────────

export type ActivateSeatOutcome = 'activated' | 'missing' | 'replaced' | 'ack-pending' | 'indeterminate';

/** The worktree binding + display supplied at FINALIZE (known only once the target
 *  worktree is decided). Merged atomically with activation by activateAndBindSeat. */
export interface SeatBinding {
  worktree: string;
  commonDir?: string;
  repositoryOrigin?: string;
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
  expectedPendingDigest: string;
  worktree: string;
  commonDir?: string;
  repositoryOrigin?: string;
  name: string;
  droneLabel: string;
  roleName?: string;
  roleClass?: 'queen' | 'worker';
  isHumanSeat?: boolean;
  acknowledge?: (attempt: AttachmentAttempt) => Promise<void>;
}): Promise<ActivateSeatOutcome> {
  if (!UUID_RE.test(input.droneId) || !UUID_RE.test(input.sessionId)) {
    throw new Error('invalid Borg server session identity');
  }
  const ref = seatRef(input);
  const binding = { origin: input.origin, trustIdentity: input.trustIdentity, cubeId: input.cubeId };
  return withStore<SeatsFile, ActivateSeatOutcome>(SEATS_FILE, emptyStore, parseStore, async (txn) => {
    const record = txn.data.seats[ref];
    if (!recordMatches(record, ref, binding)) return 'missing';
    if (digestOf(record.credential) !== input.expectedPendingDigest) return 'replaced';
    const attachment = record.attachmentAttempt === undefined ? undefined : txn.data.attachments[String(record.attachmentAttempt)];
    if (attachment && (attachment.disposition === 'cleanup-only' || attachment.disposition === 'retired')) return 'replaced';
    if (attachment?.targetWorktree !== undefined && attachment.targetWorktree !== input.worktree) return 'replaced';
    if (attachment && record.state === 'active' &&
        (record.worktree !== input.worktree || record.droneId !== input.droneId || record.sessionId !== input.sessionId)) return 'replaced';
    if (attachment && Object.entries(txn.data.seats).some(([candidateRef, candidate]) =>
      candidateRef !== ref && candidate.state === 'active' && candidate.worktree === input.worktree)) return 'replaced';
    const highestOrder = Object.values(txn.data.seats).reduce(
      (highest, candidate) => Math.max(highest, candidate.bindingOrder ?? 0),
      0,
    );
    const bindingOrder = record.state === 'active' && record.worktree === input.worktree &&
      record.bindingOrder !== undefined
      ? record.bindingOrder
      : highestOrder + 1;
    if (!Number.isSafeInteger(bindingOrder)) {
      throw new Error('Borg private seat store bind order is exhausted; refusing to activate a seat');
    }
    const retiredRefs: string[] = [];
    for (const [candidateRef, candidate] of Object.entries(txn.data.seats)) {
      if (candidateRef !== ref && candidate.state === 'active' && candidate.worktree === input.worktree) {
        cleanupAttachment(txn.data, candidate);
        delete txn.data.seats[candidateRef];
        retiredRefs.push(candidateRef);
      }
    }
    txn.data.seats[ref] = {
      ...record,
      state: 'active',
      bindingOrder,
      droneId: input.droneId,
      sessionId: input.sessionId,
      worktree: input.worktree,
      ...(input.commonDir !== undefined ? { commonDir: input.commonDir } : {}),
      ...(input.repositoryOrigin !== undefined ? { repositoryOrigin: input.repositoryOrigin } : {}),
      name: input.name,
      droneLabel: input.droneLabel,
      ...(input.roleName !== undefined ? { roleName: input.roleName } : {}),
      ...(input.roleClass !== undefined ? { roleClass: input.roleClass } : {}),
      ...(input.isHumanSeat !== undefined ? { isHumanSeat: input.isHumanSeat } : {}),
    };
    if (attachment) {
      attachment.targetWorktree = input.worktree;
      attachment.droneId = input.droneId;
      attachment.sessionId = input.sessionId;
      if (attachment.disposition !== 'finalized') attachment.disposition = 'ack-pending';
    }
    try {
      await txn.commit();
    } catch {
      // A rename can publish ACTIVE before directory sync throws. Observe disk
      // while retaining this flock; never roll back a potentially live binding.
      let observed: SeatsFile;
      try { observed = await readStore(); } catch { return 'indeterminate'; }
      const actual = observed.seats[ref];
      if (!actual) return 'missing';
      if (digestOf(actual.credential) !== input.expectedPendingDigest) return 'replaced';
      if (actual.state !== 'active' || actual.worktree !== input.worktree ||
          actual.droneId !== input.droneId || actual.sessionId !== input.sessionId) return 'indeterminate';
      Object.assign(txn.data, observed);
      try { await txn.commit(); } catch { return 'indeterminate'; }
    }
    for (const retiredRef of retiredRefs) rejectedSeatRefs.delete(retiredRef);
    rejectedSeatRefs.delete(ref);
    const persistedAttachment = record.attachmentAttempt === undefined ? undefined : txn.data.attachments[String(record.attachmentAttempt)];
    if (persistedAttachment && persistedAttachment.disposition !== 'finalized') {
      if (!input.acknowledge) return 'ack-pending';
      try {
        await input.acknowledge(persistedAttachment);
        persistedAttachment.disposition = 'finalized';
        await txn.commit();
      } catch (error) {
        if (error instanceof Error && 'code' in error && Object.values(ErrorCode).includes(error.code as ErrorCode)) throw error;
        return 'ack-pending';
      }
    }
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
    const attachment = record.attachmentAttempt === undefined ? undefined : txn.data.attachments[String(record.attachmentAttempt)];
    if (attachment && (attachment.disposition === 'cleanup-only' || attachment.disposition === 'retired')) return 'replaced';
    if (attachment?.targetWorktree !== undefined && attachment.targetWorktree !== input.worktree) return 'replaced';
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
    if (attachment) attachment.targetWorktree = input.worktree;
    await txn.commit();
    return 'bound';
  });
}

// ─── Hydration / enumeration (scan by worktree) ──────────────────────────────

/** The preferred ACTIVE seat bound to `worktree`, or null. A pending record (no
 *  worktree, or non-active) is NEVER surfaced as a live binding. Persisted bind
 *  order is authoritative across processes; an unorderable legacy duplicate
 *  fails closed rather than selecting an identity or inbox path. */
export async function getActiveSeatForWorktree(worktree: string): Promise<SeatRecord | null> {
  const store = await readStore();
  const candidates = Object.entries(store.seats)
    .filter(([ref, record]) =>
      record.state === 'active' && record.worktree === worktree && seatRef(record) === ref);
  if (candidates.length > 1) throw new AmbiguousSeatBindingError(worktree);
  return candidates[0]?.[1] ?? null;
}

/** Remember a definitive server auth or eviction verdict in this process only. */
export function markSeatRejected(ref: string): void {
  if (REF_RE.test(ref)) rejectedSeatRefs.add(ref);
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
      record.operation.operationKey.startsWith('implicit-sibling:') &&
      record.operation.operationKey.length > 'implicit-sibling:'.length &&
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

/** Whether this cube has an active seat on the SAME repository from a different
 *  clone family. Repositories without a remote have no identity shared across
 *  clones, so their separate clones are undetectable here — see client#264. */
export async function hasActiveSeatInDifferentCloneFamily(
  cubeId: string,
  repositoryOrigin: string,
  commonDir: string,
): Promise<boolean> {
  const seats = await readAllActiveSeats();
  return seats.some(({ record }) =>
    record.cubeId === cubeId &&
    record.repositoryOrigin === repositoryOrigin &&
    record.commonDir !== undefined &&
    record.commonDir !== commonDir
  );
}

/** All valid worktree-bound registry entries, including a PENDING seat whose
 * interrupted finalize preserved its worktree for a later resume. Read-only:
 * pending records remain non-hydratable and getActiveSeatForWorktree stays
 * active-only. */
export async function readAllBoundSeats(): Promise<Array<{ worktree: string; record: SeatRecord }>> {
  const store = await readStore();
  const out: Array<{ worktree: string; record: SeatRecord }> = [];
  for (const [ref, record] of Object.entries(store.seats)) {
    if (typeof record.worktree === 'string' && seatRef(record) === ref) {
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
    cleanupAttachment(txn.data, record);
    delete txn.data.seats[expected.ref];
    await txn.commit();
    rejectedSeatRefs.delete(expected.ref);
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
    cleanupAttachment(txn.data, record);
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
      cleanupAttachment(txn.data, txn.data.seats[ref]);
      delete txn.data.seats[ref];
      await txn.commit();
      rejectedSeatRefs.delete(ref);
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
