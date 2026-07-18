/**
 * Secure local-server credential storage.
 *
 * The self-hosted-server credential group (enrollment credentials, pending
 * enrollment/cube-creation records, and the per-seat drone-session bearers)
 * rests ONLY in the 0600 credential file store (Queen rescope) — parity with the
 * server's own TLS private keys. The OS keychain is gone; the raw secret never
 * leaves the 0600 file, and a single store flock serializes every read-compare-write.
 */
import os from 'os';
import path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import type { ServerCapability } from 'borgmcp-shared/protocol';
import { withStoreLock } from './seat-store.js';
import {
  makeFileBackend,
  type TokenBackend,
} from './token-store.js';

const SERVER_CREDENTIAL_RECORD_VERSION = 2 as const;
const SERVER_PENDING_ENROLLMENT_RECORD_VERSION = 1 as const;
const SERVER_CUBE_RETRY_RECORD_VERSION = 1 as const;
const SERVER_PENDING_SESSION_RECORD_VERSION = 1 as const;
// The 0600 credential store (Queen rescope: replaces the OS keychain). A single
// file holds every server credential/session/enrollment record; a single flock
// serializes every mutator + observer that must (SR-seven #4).
const CREDENTIALS_FILE = path.join(os.homedir(), '.config', 'borgmcp', 'credentials.json');
const CREDENTIALS_LOCK = `${CREDENTIALS_FILE}.lock`;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ServerCredentialRecord {
  origin: string;
  trustIdentity: string;
  credential: string;
  clientId?: string | null;
  serverCapabilities?: ServerCapability[];
}

export interface ActiveServerCredentialRecord {
  origin: string;
  trustIdentity: string;
  credential: string;
  clientId: string | null;
  serverCapabilities: ServerCapability[];
}

export interface PendingServerEnrollmentRecord {
  origin: string;
  trustIdentity: string;
  invitation: string;
  retryKey: string;
  credential: string;
  clientName?: string;
}

export interface PendingServerCubeCreationRecord {
  origin: string;
  trustIdentity: string;
  clientId: string;
  repositoryBinding: string;
  retryKey: string;
  name: string;
  template: 'default';
}

/**
 * S1 clean-slate local drone-session record. The client CSPRNG-generates the
 * bearer and persists it PENDING (keyed by the stable per-seat attach identity
 * origin+trustIdentity+cube+role — no drone id yet on first attach) BEFORE the
 * attach request. The bearer digest is the sole server correlator, so a lost
 * response is recovered by re-sending the exact same bearer. After a verified
 * `created`/`reused` response the SAME record is enriched in place with the
 * server-assigned drone/session identity — no generation, no rotation.
 */
/**
 * The seat/sibling operation dimension for a pending session. Because the client
 * bearer digest is the SOLE server correlator, distinct seats require distinct
 * bearers; a deliberate sibling attach must therefore namespace its bearer apart
 * from the durable in-place seat for the same (origin,trust,cube,role). Ported
 * from the retired local-attach `operationBindingKey`. projectRoot is captured
 * before a successful sibling attach changes cwd, so it is stable across the
 * whole prepare→activate lifecycle.
 */
export interface ServerSessionOperation {
  projectRoot: string;
  kind: 'seat' | 'sibling';
  operationKey: string;
}

export interface PendingServerSessionRecord {
  origin: string;
  trustIdentity: string;
  cubeId: string;
  roleId: string;
  operation: ServerSessionOperation;
  credential: string;
  state: 'pending' | 'active';
  droneId?: string;
  sessionId?: string;
  expiresAt?: string;
}

function validateServerCredentialBinding(origin: string, trustIdentity: string): void {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error('invalid Borg server credential origin');
  }
  if (parsed.origin !== origin || parsed.protocol !== 'https:') {
    throw new Error('Borg server credentials require a canonical HTTPS origin');
  }
  if (
    trustIdentity.length < 1 ||
    trustIdentity.length > 512 ||
    /[\u0000-\u001f\u007f]/.test(trustIdentity)
  ) {
    throw new Error('invalid Borg server trust identity');
  }
}

function serverCredentialAccount(origin: string, trustIdentity: string): string {
  validateServerCredentialBinding(origin, trustIdentity);
  const binding = createHash('sha256')
    .update(origin)
    .update('\0')
    .update(trustIdentity)
    .digest('hex');
  return `borg-server-credential:${binding}`;
}

/**
 * The SINGLE advisory lock over the whole 0600 credential store (Queen rescope).
 * Every mutator AND every observer that must serialize runs `operation` inside
 * one continuous hold of this lock, released on EVERY path incl throw (SR-seven
 * #4). The `account` argument is retained for call-site compatibility but is no
 * longer a per-account lock — there is one store lock now (no lock ordering, no
 * inversion, no reaper machinery). Implemented as an O_EXCL lockfile + bounded
 * stale-mtime reclaim (Node has no native flock; consistent with the existing
 * cubes.json.lock idiom and avoids a native dep).
 */
export async function withServerKeychainLock<T>(
  _account: string,
  operation: () => Promise<T>,
): Promise<T> {
  return withStoreLock(CREDENTIALS_LOCK, operation);
}

function serverPendingEnrollmentAccount(origin: string, trustIdentity: string): string {
  validateServerCredentialBinding(origin, trustIdentity);
  const binding = createHash('sha256')
    .update(origin)
    .update('\0')
    .update(trustIdentity)
    .digest('hex');
  return `borg-server-enrollment-pending:${binding}`;
}

function validateUuid(value: string, label: string): void {
  if (!UUID_RE.test(value)) throw new Error(`invalid Borg server ${label}`);
}

function validateServerCapabilities(value: readonly string[]): ServerCapability[] {
  if (value.length > 1 || value.some((capability) => capability !== 'create_cube')) {
    throw new Error('invalid Borg server capabilities');
  }
  return [...value] as ServerCapability[];
}

function validateClientName(clientName: string | undefined): void {
  if (
    clientName !== undefined &&
    (Buffer.byteLength(clientName, 'utf8') < 1 ||
      Buffer.byteLength(clientName, 'utf8') > 120 ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(clientName))
  ) {
    throw new Error('invalid Borg server client name');
  }
}

function validateInvitation(invitation: string): void {
  if (
    invitation.length < 43 ||
    invitation.length > 1024 ||
    !/^[A-Za-z0-9_-]+$/.test(invitation)
  ) {
    throw new Error('invalid Borg server invitation');
  }
}

function validateEnrollmentCredential(credential: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) {
    throw new Error('invalid Borg server credential');
  }
}

/**
 * Stable per-seat keychain account for the S1 local drone-session bearer. Keyed
 * by origin + trust identity + cube + role only — NOT the drone id (first attach
 * has none) and NOT a generation counter. This is the identity a lost-response
 * retry re-resolves to re-send the exact same pending bearer.
 */
function validateServerSessionOperation(operation: ServerSessionOperation): void {
  if (
    operation.projectRoot.length < 1 ||
    operation.projectRoot.length > 4096 ||
    operation.operationKey.length < 1 ||
    operation.operationKey.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(operation.projectRoot) ||
    /[\u0000-\u001f\u007f]/.test(operation.operationKey) ||
    (operation.kind !== 'seat' && operation.kind !== 'sibling')
  ) {
    throw new Error('invalid Borg server session operation');
  }
}

function serverPendingSessionAccount(
  origin: string,
  trustIdentity: string,
  cubeId: string,
  roleId: string,
  operation: ServerSessionOperation,
): string {
  validateServerCredentialBinding(origin, trustIdentity);
  validateUuid(cubeId, 'cube identity');
  validateUuid(roleId, 'role identity');
  validateServerSessionOperation(operation);
  const binding = createHash('sha256')
    .update(origin)
    .update('\0')
    .update(trustIdentity)
    .update('\0')
    .update(cubeId)
    .update('\0')
    .update(roleId)
    .update('\0')
    .update(operation.projectRoot)
    .update('\0')
    .update(operation.kind)
    .update('\0')
    .update(operation.operationKey)
    .digest('hex');
  return `borg-server-session:${binding}`;
}

function validateSessionBearer(credential: string): void {
  if (!/^[A-Za-z0-9_-]{43,1024}$/.test(credential)) {
    throw new Error('invalid Borg server session bearer');
  }
}

function decodePendingServerSession(
  stored: string,
  binding: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
  },
): PendingServerSessionRecord {
  const record = JSON.parse(stored) as Partial<PendingServerSessionRecord> & {
    version?: unknown;
  };
  const op = record.operation;
  if (
    record.version !== SERVER_PENDING_SESSION_RECORD_VERSION ||
    record.origin !== binding.origin ||
    record.trustIdentity !== binding.trustIdentity ||
    record.cubeId !== binding.cubeId ||
    record.roleId !== binding.roleId ||
    typeof record.credential !== 'string' ||
    (record.state !== 'pending' && record.state !== 'active') ||
    op === undefined ||
    op === null ||
    typeof op !== 'object' ||
    op.projectRoot !== binding.operation.projectRoot ||
    op.kind !== binding.operation.kind ||
    op.operationKey !== binding.operation.operationKey
  ) {
    throw new Error('invalid Borg server session record');
  }
  validateServerSessionOperation(binding.operation);
  validateSessionBearer(record.credential);
  return {
    origin: record.origin,
    trustIdentity: record.trustIdentity,
    cubeId: record.cubeId,
    roleId: record.roleId,
    operation: {
      projectRoot: binding.operation.projectRoot,
      kind: binding.operation.kind,
      operationKey: binding.operation.operationKey,
    },
    credential: record.credential,
    state: record.state,
    ...(record.droneId === undefined ? {} : { droneId: record.droneId }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
  };
}

/**
 * Resolve the client's bearer for one seat, generating + persisting a PENDING
 * record before the first attach. An existing record (pending or active) for
 * the same seat returns its exact bearer so a lost-response retry re-sends the
 * identical credential the server already digest-bound.
 */
export async function getOrCreatePendingServerSession(
  input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
  },
): Promise<PendingServerSessionRecord> {
  const account = serverPendingSessionAccount(
    input.origin,
    input.trustIdentity,
    input.cubeId,
    input.roleId,
    input.operation,
  );
  const backend = await getServerCredentialBackend();
  return withServerKeychainLock(account, async () => {
    const stored = await backend.get(account);
    if (stored) {
      try {
        return decodePendingServerSession(stored, input);
      } catch {
        // A corrupt/foreign record for this seat is cleared and re-minted; the
        // old bearer was never usable without the server's matching digest.
        await backend.delete(account);
      }
    }
    const record: PendingServerSessionRecord = {
      origin: input.origin,
      trustIdentity: input.trustIdentity,
      cubeId: input.cubeId,
      roleId: input.roleId,
      operation: {
        projectRoot: input.operation.projectRoot,
        kind: input.operation.kind,
        operationKey: input.operation.operationKey,
      },
      credential: randomBytes(32).toString('base64url'),
      state: 'pending',
    };
    validateSessionBearer(record.credential);
    await backend.set(account, JSON.stringify({
      version: SERVER_PENDING_SESSION_RECORD_VERSION,
      ...record,
    }));
    return record;
  });
}

/**
 * Enrich the exact pending record IN PLACE with the server-assigned drone and
 * session identity after a verified `created`/`reused` response, marking it
 * active. No rename/copy window: the bearer never moves accounts.
 */
export async function activatePendingServerSession(
  input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
    droneId: string;
    sessionId: string;
    expiresAt: string;
  },
): Promise<string> {
  validateUuid(input.droneId, 'drone identity');
  validateUuid(input.sessionId, 'session identity');
  if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error('invalid Borg server session expiry');
  }
  const account = serverPendingSessionAccount(
    input.origin,
    input.trustIdentity,
    input.cubeId,
    input.roleId,
    input.operation,
  );
  const backend = await getServerCredentialBackend();
  await withServerKeychainLock(account, async () => {
    const stored = await backend.get(account);
    if (!stored) {
      throw new Error('no pending Borg server session to activate');
    }
    const record = decodePendingServerSession(stored, input);
    const next: PendingServerSessionRecord = {
      ...record,
      state: 'active',
      droneId: input.droneId,
      sessionId: input.sessionId,
      expiresAt: input.expiresAt,
    };
    await backend.set(account, JSON.stringify({
      version: SERVER_PENDING_SESSION_RECORD_VERSION,
      ...next,
    }));
  });
  return account;
}

/** The outcome of an atomic compare-and-activate (CR #2). */
export type ActivateSessionOutcome = 'activated' | 'missing' | 'replaced';

/**
 * Atomic compare-and-activate of the EXACT pending record that was sent (CR #2).
 * The whole read → validate → DIGEST-compare → stamp runs under the per-account
 * keychain lock, and it activates ONLY when the record still at the deterministic
 * ref carries the exact bearer whose digest the caller sent (`expectedPendingDigest`).
 *   - `missing`   — no record at the ref (a concurrent reset deleted it).
 *   - `replaced`  — a record exists but its bearer digest differs (a same-ref
 *                   replacement wrote a DIFFERENT bearer between send and FINALIZE);
 *                   server metadata for bearer A must NEVER be stamped onto bearer B.
 *   - `activated` — the exact sent bearer was stamped ACTIVE (idempotent for a
 *                   retried FINALIZE whose record is already active with the same
 *                   bearer). Returns the opaque ref via the account (deterministic).
 * This SUPERSEDES the unguarded activatePendingServerSession on every production
 * (composite) attach path; the raw activate remains only for lower-level tests.
 */
export async function compareAndActivatePendingServerSession(
  input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
    droneId: string;
    sessionId: string;
    expiresAt: string;
    expectedPendingDigest: string;
  },
): Promise<ActivateSessionOutcome> {
  validateUuid(input.droneId, 'drone identity');
  validateUuid(input.sessionId, 'session identity');
  if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) {
    throw new Error('invalid Borg server session expiry');
  }
  const account = serverPendingSessionAccount(
    input.origin,
    input.trustIdentity,
    input.cubeId,
    input.roleId,
    input.operation,
  );
  const backend = await getServerCredentialBackend();
  return withServerKeychainLock(account, async () => {
    const stored = await backend.get(account);
    if (!stored) return 'missing';
    let record: PendingServerSessionRecord;
    try {
      record = decodePendingServerSession(stored, input);
    } catch {
      // A corrupt/foreign record occupies the ref — treat as a replacement; never
      // stamp server metadata onto it.
      return 'replaced';
    }
    const digest = createHash('sha256').update(record.credential).digest('hex');
    if (digest !== input.expectedPendingDigest) return 'replaced';
    const next: PendingServerSessionRecord = {
      ...record,
      state: 'active',
      droneId: input.droneId,
      sessionId: input.sessionId,
      expiresAt: input.expiresAt,
    };
    await backend.set(account, JSON.stringify({
      version: SERVER_PENDING_SESSION_RECORD_VERSION,
      ...next,
    }));
    return 'activated';
  });
}

/**
 * The deterministic per-seat keychain reference for a pending/active session,
 * known at PREPARE time (from origin+trust+cube+role+operation, before any
 * activation). The composite attach FINALIZE uses it to persist the cubes
 * binding referencing the EXACT pending record BEFORE the single pending→ACTIVE
 * transition, so an ACTIVE credential is never observable without a binding.
 */
export function serverSessionCredentialRef(
  input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
  },
): string {
  return serverPendingSessionAccount(
    input.origin,
    input.trustIdentity,
    input.cubeId,
    input.roleId,
    input.operation,
  );
}

/**
 * Pure PEEK: does a well-formed session record — PENDING or ACTIVE — exist at
 * this per-seat ref for the given binding? No lock, no create, no mutate, no
 * bearer returned. Lets the crash-in-gap resume path distinguish a resumable
 * PENDING record (binding-present, credential non-hydratable because
 * getActiveServerSessionCredential requires state=='active') from genuine
 * keychain loss. Returns false for a missing/foreign/corrupt/mismatched record,
 * so a genuine loss stays a truthful error and never becomes a new seat.
 */
export async function peekServerSessionRecord(
  credentialRef: string,
  binding: { origin: string; trustIdentity: string; cubeId: string },
): Promise<boolean> {
  if (!/^borg-server-session:[a-f0-9]{64}$/.test(credentialRef)) return false;
  const backend = await getServerCredentialBackend();
  const stored = await backend.get(credentialRef);
  if (!stored) return false;
  try {
    const record = JSON.parse(stored) as Partial<PendingServerSessionRecord> & {
      version?: unknown;
    };
    const op = record.operation;
    if (
      record.version !== SERVER_PENDING_SESSION_RECORD_VERSION ||
      record.origin !== binding.origin ||
      record.trustIdentity !== binding.trustIdentity ||
      record.cubeId !== binding.cubeId ||
      (record.state !== 'pending' && record.state !== 'active') ||
      typeof record.credential !== 'string' ||
      typeof record.roleId !== 'string' ||
      op === undefined ||
      op === null ||
      typeof op !== 'object' ||
      typeof op.projectRoot !== 'string' ||
      typeof op.operationKey !== 'string' ||
      (op.kind !== 'seat' && op.kind !== 'sibling')
    ) {
      return false;
    }
    return serverPendingSessionAccount(
      record.origin,
      record.trustIdentity,
      record.cubeId,
      record.roleId,
      op,
    ) === credentialRef;
  } catch {
    return false;
  }
}

/**
 * Resolve the active bearer stored at an opaque per-seat reference. The role is
 * not required from the caller — the reference itself binds the role, so the
 * stored record's own role must re-derive the exact same account. Returns null
 * for a missing/pending/foreign/mismatched record so callers fail closed.
 */
export async function getActiveServerSessionCredential(
  credentialRef: string,
  binding: { origin: string; trustIdentity: string; cubeId: string },
): Promise<string | null> {
  if (!/^borg-server-session:[a-f0-9]{64}$/.test(credentialRef)) return null;
  const backend = await getServerCredentialBackend();
  const stored = await backend.get(credentialRef);
  if (!stored) return null;
  try {
    const record = JSON.parse(stored) as Partial<PendingServerSessionRecord> & {
      version?: unknown;
    };
    const op = record.operation;
    if (
      record.version !== SERVER_PENDING_SESSION_RECORD_VERSION ||
      record.origin !== binding.origin ||
      record.trustIdentity !== binding.trustIdentity ||
      record.cubeId !== binding.cubeId ||
      record.state !== 'active' ||
      typeof record.credential !== 'string' ||
      typeof record.roleId !== 'string' ||
      op === undefined ||
      op === null ||
      typeof op !== 'object' ||
      typeof op.projectRoot !== 'string' ||
      typeof op.operationKey !== 'string' ||
      (op.kind !== 'seat' && op.kind !== 'sibling')
    ) {
      return null;
    }
    validateSessionBearer(record.credential);
    // The reference must be the exact per-seat account for the stored role AND
    // operation (seat vs sibling), so a sibling bearer never resolves a seat ref.
    if (
      serverPendingSessionAccount(
        record.origin,
        record.trustIdentity,
        record.cubeId,
        record.roleId,
        op,
      ) !== credentialRef
    ) {
      return null;
    }
    return record.credential;
  } catch {
    return null;
  }
}

/**
 * Atomically compare an active session credential against an expected token
 * digest and delete it IFF they match. The ENTIRE read → validate → compare →
 * delete runs under the same per-account keychain lock as the credential
 * writers, so a same-ref remint cannot interleave between the comparison and the
 * delete (SR-six 689e2654 / #1082 transactional reset). Returns true iff an
 * active record matched the binding AND its bearer's sha256 digest matched the
 * pinned one AND it was deleted; any non-match is a no-op (false). A backend
 * get/delete error PROPAGATES so the caller leaves coherent pre-reset state
 * (no half-applied delete). The raw bearer is never returned or logged.
 */
export async function compareAndClearServerSessionCredential(
  credentialRef: string,
  binding: { origin: string; trustIdentity: string; cubeId: string },
  expectedSessionDigest: string,
): Promise<boolean> {
  if (!/^borg-server-session:[a-f0-9]{64}$/.test(credentialRef)) return false;
  const backend = await getServerCredentialBackend();
  return withServerKeychainLock(credentialRef, async () => {
    const stored = await backend.get(credentialRef);
    if (!stored) return false;
    let bearer: string;
    try {
      const record = JSON.parse(stored) as Partial<PendingServerSessionRecord> & {
        version?: unknown;
      };
      const op = record.operation;
      if (
        record.version !== SERVER_PENDING_SESSION_RECORD_VERSION ||
        record.origin !== binding.origin ||
        record.trustIdentity !== binding.trustIdentity ||
        record.cubeId !== binding.cubeId ||
        record.state !== 'active' ||
        typeof record.credential !== 'string' ||
        typeof record.roleId !== 'string' ||
        op === undefined ||
        op === null ||
        typeof op !== 'object' ||
        typeof op.projectRoot !== 'string' ||
        typeof op.operationKey !== 'string' ||
        (op.kind !== 'seat' && op.kind !== 'sibling')
      ) {
        return false;
      }
      if (
        serverPendingSessionAccount(
          record.origin,
          record.trustIdentity,
          record.cubeId,
          record.roleId,
          op,
        ) !== credentialRef
      ) {
        return false;
      }
      bearer = record.credential;
    } catch {
      return false;
    }
    const digest = createHash('sha256').update(bearer).digest('hex');
    if (digest !== expectedSessionDigest) return false;
    await backend.delete(credentialRef);
    return true;
  });
}

/**
 * Token-safe TYPED observation of the record at a per-seat ref (CR #3). Unlike
 * getActiveServerSessionCredential (which returns null for a pending record — so
 * a binding+PENDING state is mislabeled ABSENT), this distinguishes
 * active|pending|absent and returns an immutable sha256 DIGEST (never the raw
 * bearer) plus the drone identity for an active record. No lock, no mutate —
 * the authoritative delete re-reads under the keychain lock.
 */
export type ServerSessionRecordObservation =
  | { state: 'active'; digest: string; droneId: string }
  | { state: 'pending'; digest: string }
  | { state: 'absent' };

export async function observeServerSessionRecord(
  credentialRef: string,
  binding: { origin: string; trustIdentity: string; cubeId: string },
): Promise<ServerSessionRecordObservation> {
  if (!/^borg-server-session:[a-f0-9]{64}$/.test(credentialRef)) return { state: 'absent' };
  const backend = await getServerCredentialBackend();
  const stored = await backend.get(credentialRef);
  if (!stored) return { state: 'absent' };
  try {
    const record = JSON.parse(stored) as Partial<PendingServerSessionRecord> & {
      version?: unknown;
    };
    const op = record.operation;
    if (
      record.version !== SERVER_PENDING_SESSION_RECORD_VERSION ||
      record.origin !== binding.origin ||
      record.trustIdentity !== binding.trustIdentity ||
      record.cubeId !== binding.cubeId ||
      (record.state !== 'active' && record.state !== 'pending') ||
      typeof record.credential !== 'string' ||
      typeof record.roleId !== 'string' ||
      op === undefined ||
      op === null ||
      typeof op !== 'object' ||
      typeof op.projectRoot !== 'string' ||
      typeof op.operationKey !== 'string' ||
      (op.kind !== 'seat' && op.kind !== 'sibling')
    ) {
      return { state: 'absent' };
    }
    if (
      serverPendingSessionAccount(
        record.origin,
        record.trustIdentity,
        record.cubeId,
        record.roleId,
        op,
      ) !== credentialRef
    ) {
      return { state: 'absent' };
    }
    const digest = createHash('sha256').update(record.credential).digest('hex');
    if (record.state === 'active') {
      return { state: 'active', digest, droneId: typeof record.droneId === 'string' ? record.droneId : '' };
    }
    return { state: 'pending', digest };
  } catch {
    return { state: 'absent' };
  }
}

/**
 * The outcome of the readback-aware credential-first delete (CR #4). `cleared` —
 * the exact matching record (ACTIVE or PENDING) was deleted and confirmed gone.
 * `no-match` — nothing matched the pinned digest (already gone / replaced) so
 * nothing was deleted. `unknown` — the delete threw AND a readback could not
 * confirm the record is gone (repair-required; NEVER reported as success).
 */
export type ClearSessionRecordOutcome = 'cleared' | 'no-match' | 'unknown';

/**
 * Credential-FIRST atomic clear of the EXACT record — ACTIVE **or** PENDING —
 * whose bearer digest matches the pinned one (CR #3: reset must clear a
 * binding+PENDING seat too; CR #4: a delete-throw must be classified by
 * readback, not reported as a plain error/success). Runs entirely under the
 * per-account keychain lock, so no writer interleaves the compare and the delete.
 */
export async function compareAndClearSessionRecord(
  credentialRef: string,
  binding: { origin: string; trustIdentity: string; cubeId: string },
  expectedDigest: string,
): Promise<ClearSessionRecordOutcome> {
  if (!/^borg-server-session:[a-f0-9]{64}$/.test(credentialRef)) return 'no-match';
  const backend = await getServerCredentialBackend();
  return withServerKeychainLock(credentialRef, async () => {
    const stored = await backend.get(credentialRef);
    if (!stored) return 'no-match';
    let bearer: string;
    try {
      const record = JSON.parse(stored) as Partial<PendingServerSessionRecord> & {
        version?: unknown;
      };
      const op = record.operation;
      if (
        record.version !== SERVER_PENDING_SESSION_RECORD_VERSION ||
        record.origin !== binding.origin ||
        record.trustIdentity !== binding.trustIdentity ||
        record.cubeId !== binding.cubeId ||
        (record.state !== 'active' && record.state !== 'pending') ||
        typeof record.credential !== 'string' ||
        typeof record.roleId !== 'string' ||
        op === undefined ||
        op === null ||
        typeof op !== 'object' ||
        typeof op.projectRoot !== 'string' ||
        typeof op.operationKey !== 'string' ||
        (op.kind !== 'seat' && op.kind !== 'sibling')
      ) {
        return 'no-match';
      }
      if (
        serverPendingSessionAccount(
          record.origin,
          record.trustIdentity,
          record.cubeId,
          record.roleId,
          op,
        ) !== credentialRef
      ) {
        return 'no-match';
      }
      bearer = record.credential;
    } catch {
      return 'no-match';
    }
    const digest = createHash('sha256').update(bearer).digest('hex');
    if (digest !== expectedDigest) return 'no-match';
    try {
      await backend.delete(credentialRef);
    } catch {
      // Delete threw. READ BACK under the same lock to classify the real state:
      // a delete that succeeded then reported an error still leaves the record
      // GONE (cleared); a record still present is UNKNOWN (repair-required).
      try {
        const after = await backend.get(credentialRef);
        return after === null ? 'cleared' : 'unknown';
      } catch {
        return 'unknown';
      }
    }
    return 'cleared';
  });
}

/**
 * Abort-scrub for the composite attach FINALIZE. Atomically deletes the caller's
 * OWN pending record IFF it is STILL state=='pending' AND its bearer digest
 * matches the one the caller prepared — never an ACTIVE record (a concurrent
 * winner activated it and a binding now references it) and never a same-ref
 * replacement (a competing fresh enroll wrote a different bearer under the same
 * deterministic ref). The read → validate → compare → delete runs under the same
 * per-account keychain lock as every session writer, so no interleave can slip
 * between the comparison and the delete. Returns true iff the exact own pending
 * record was deleted; every non-match is a no-op (false). A backend error
 * PROPAGATES. The raw bearer is never returned or logged.
 */
export async function compareAndClearPendingServerSession(
  credentialRef: string,
  binding: { origin: string; trustIdentity: string; cubeId: string },
  expectedBearerDigest: string,
): Promise<boolean> {
  if (!/^borg-server-session:[a-f0-9]{64}$/.test(credentialRef)) return false;
  const backend = await getServerCredentialBackend();
  return withServerKeychainLock(credentialRef, async () => {
    const stored = await backend.get(credentialRef);
    if (!stored) return false;
    let bearer: string;
    try {
      const record = JSON.parse(stored) as Partial<PendingServerSessionRecord> & {
        version?: unknown;
      };
      const op = record.operation;
      if (
        record.version !== SERVER_PENDING_SESSION_RECORD_VERSION ||
        record.origin !== binding.origin ||
        record.trustIdentity !== binding.trustIdentity ||
        record.cubeId !== binding.cubeId ||
        record.state !== 'pending' ||
        typeof record.credential !== 'string' ||
        typeof record.roleId !== 'string' ||
        op === undefined ||
        op === null ||
        typeof op !== 'object' ||
        typeof op.projectRoot !== 'string' ||
        typeof op.operationKey !== 'string' ||
        (op.kind !== 'seat' && op.kind !== 'sibling')
      ) {
        return false;
      }
      if (
        serverPendingSessionAccount(
          record.origin,
          record.trustIdentity,
          record.cubeId,
          record.roleId,
          op,
        ) !== credentialRef
      ) {
        return false;
      }
      bearer = record.credential;
    } catch {
      return false;
    }
    const digest = createHash('sha256').update(bearer).digest('hex');
    if (digest !== expectedBearerDigest) return false;
    await backend.delete(credentialRef);
    return true;
  });
}

/**
 * Discard any pending/active session record for one seat so the next attach
 * mints a fresh bearer. Used by the eviction/remint recovery path where the
 * saved seat is known invalid and a new seat must be created.
 */
export async function clearPendingServerSession(
  binding: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
  },
): Promise<void> {
  const account = serverPendingSessionAccount(
    binding.origin,
    binding.trustIdentity,
    binding.cubeId,
    binding.roleId,
    binding.operation,
  );
  const backend = await getServerCredentialBackend();
  await withServerKeychainLock(account, async () => {
    await backend.delete(account);
  });
}

function serverCubeRetryAccount(
  origin: string,
  trustIdentity: string,
  clientId: string,
  repositoryBinding: string,
): string {
  validateServerCredentialBinding(origin, trustIdentity);
  validateUuid(clientId, 'client identity');
  if (!/^[a-f0-9]{64}$/.test(repositoryBinding)) {
    throw new Error('invalid Borg server repository binding');
  }
  const binding = createHash('sha256')
    .update(origin)
    .update('\0')
    .update(trustIdentity)
    .update('\0')
    .update(clientId)
    .update('\0')
    .update(repositoryBinding)
    .digest('hex');
  return `borg-server-cube-pending:${binding}`;
}

function validateServerSessionCredentialRef(credentialRef: string): void {
  if (!/^borg-server-session:[a-f0-9]{64}$/.test(credentialRef)) {
    throw new Error('invalid Borg server session credential reference');
  }
}

// Local-server bearers rest ONLY in the 0600 credential store (Queen rescope —
// parity with the server's TLS keys; no OS keychain, no obfuscation-grade
// fallback). The single store lock (withServerKeychainLock) serializes the RCW.
let serverCredentialBackendPromise: Promise<TokenBackend> | null = null;
async function getServerCredentialBackend(): Promise<TokenBackend> {
  if (!serverCredentialBackendPromise) {
    serverCredentialBackendPromise = Promise.resolve(makeFileBackend(CREDENTIALS_FILE));
  }
  return serverCredentialBackendPromise;
}

/** Test-only credential-store backend injection. */
export function __setServerCredentialBackendForTest(backend: TokenBackend | null): void {
  serverCredentialBackendPromise = backend ? Promise.resolve(backend) : null;
}

/**
 * Persist one self-hosted server credential in the dedicated OS-keychain namespace.
 *
 * The account key binds both the canonical authority origin and the verified
 * server/CA identity. A credential enrolled for one authority is therefore
 * never considered for another endpoint or trust anchor. Enrollment owns the
 * write; command-line arguments and environment variables are intentionally
 * not credential sources.
 */
export async function storeServerCredential(record: ServerCredentialRecord): Promise<void> {
  validateServerCredentialBinding(record.origin, record.trustIdentity);
  validateEnrollmentCredential(record.credential);
  if (record.clientId !== undefined && record.clientId !== null) {
    validateUuid(record.clientId, 'client identity');
  }
  const serverCapabilities = validateServerCapabilities(record.serverCapabilities ?? []);
  const backend = await getServerCredentialBackend();
  await backend.set(
    serverCredentialAccount(record.origin, record.trustIdentity),
    JSON.stringify({
      version: SERVER_CREDENTIAL_RECORD_VERSION,
      origin: record.origin,
      trustIdentity: record.trustIdentity,
      credential: record.credential,
      clientId: record.clientId ?? null,
      serverCapabilities,
    }),
  );
}

/** Read an authority-bound active client record, failing closed on corruption. */
export async function getServerCredentialRecord(
  origin: string,
  trustIdentity: string,
): Promise<ActiveServerCredentialRecord | null> {
  const backend = await getServerCredentialBackend();
  const stored = await backend.get(serverCredentialAccount(origin, trustIdentity));
  if (!stored) return null;
  try {
    const record = JSON.parse(stored) as Partial<ActiveServerCredentialRecord> & {
      version?: unknown;
    };
    if (
      record.version !== SERVER_CREDENTIAL_RECORD_VERSION ||
      record.origin !== origin ||
      record.trustIdentity !== trustIdentity ||
      typeof record.credential !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.credential) ||
      (record.clientId !== null &&
        (typeof record.clientId !== 'string' || !UUID_RE.test(record.clientId))) ||
      !Array.isArray(record.serverCapabilities)
    ) {
      return null;
    }
    let serverCapabilities: ServerCapability[];
    try {
      serverCapabilities = validateServerCapabilities(record.serverCapabilities);
    } catch {
      return null;
    }
    return {
      origin,
      trustIdentity,
      credential: record.credential,
      clientId: record.clientId,
      serverCapabilities,
    };
  } catch {
    return null;
  }
}

/** Read only the bearer for existing call sites that do not need capability metadata. */
export async function getServerCredential(
  origin: string,
  trustIdentity: string,
): Promise<string | null> {
  return (await getServerCredentialRecord(origin, trustIdentity))?.credential ?? null;
}

function decodePendingServerEnrollment(
  stored: string,
  origin: string,
  trustIdentity: string,
): PendingServerEnrollmentRecord {
  const record = JSON.parse(stored) as Partial<PendingServerEnrollmentRecord> & {
    version?: unknown;
    state?: unknown;
  };
  if (
    record.version !== SERVER_PENDING_ENROLLMENT_RECORD_VERSION ||
    record.state !== 'pending' ||
    record.origin !== origin ||
    record.trustIdentity !== trustIdentity ||
    typeof record.invitation !== 'string' ||
    typeof record.retryKey !== 'string' || !UUID_RE.test(record.retryKey) ||
    typeof record.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.credential) ||
    (record.clientName !== undefined && typeof record.clientName !== 'string')
  ) {
    throw new Error('invalid');
  }
  validateInvitation(record.invitation);
  validateClientName(record.clientName);
  return {
    origin,
    trustIdentity,
    invitation: record.invitation,
    retryKey: record.retryKey,
    credential: record.credential,
    ...(record.clientName === undefined ? {} : { clientName: record.clientName }),
  };
}

/** Load an exact durable PENDING tuple so a new process can resume it. */
export async function getPendingServerEnrollment(
  origin: string,
  trustIdentity: string,
): Promise<PendingServerEnrollmentRecord | null> {
  validateServerCredentialBinding(origin, trustIdentity);
  const backend = await getServerCredentialBackend();
  const account = serverPendingEnrollmentAccount(origin, trustIdentity);
  return withServerKeychainLock(account, async () => {
    const stored = await backend.get(account);
    if (!stored) return null;
    try {
      return decodePendingServerEnrollment(stored, origin, trustIdentity);
    } catch {
      throw new Error('pending Borg server enrollment is corrupt');
    }
  });
}

/**
 * Generate and persist an exact enrollment tuple before network I/O. A
 * pre-existing PENDING tuple must match the invitation and presentation name;
 * this makes response-loss retries exact without minting a second bearer.
 */
export async function getOrCreatePendingServerEnrollment(
  input: {
    origin: string;
    trustIdentity: string;
    invitation: string;
    clientName?: string;
  },
): Promise<PendingServerEnrollmentRecord> {
  validateServerCredentialBinding(input.origin, input.trustIdentity);
  validateInvitation(input.invitation);
  validateClientName(input.clientName);
  const backend = await getServerCredentialBackend();
  const account = serverPendingEnrollmentAccount(input.origin, input.trustIdentity);
  return withServerKeychainLock(account, async () => {
    const stored = await backend.get(account);
    if (stored) {
      try {
        const record = decodePendingServerEnrollment(
          stored,
          input.origin,
          input.trustIdentity,
        );
        if (
          record.invitation !== input.invitation ||
          record.clientName !== input.clientName
        ) {
          throw new Error('mismatch');
        }
        return record;
      } catch {
        throw new Error('pending Borg server enrollment does not match this request');
      }
    }

    const record: PendingServerEnrollmentRecord = {
      origin: input.origin,
      trustIdentity: input.trustIdentity,
      invitation: input.invitation,
      retryKey: randomUUID(),
      credential: randomBytes(32).toString('base64url'),
      ...(input.clientName === undefined ? {} : { clientName: input.clientName }),
    };
    validateEnrollmentCredential(record.credential);
    await backend.set(account, JSON.stringify({
      version: SERVER_PENDING_ENROLLMENT_RECORD_VERSION,
      state: 'pending',
      ...record,
    }));
    return record;
  });
}

/** Activate the exact pending tuple only after a verified server response. */
export async function activatePendingServerEnrollment(
  input: {
    origin: string;
    trustIdentity: string;
    retryKey: string;
    credential: string;
    clientId: string;
    serverCapabilities: ServerCapability[];
  },
): Promise<void> {
  validateServerCredentialBinding(input.origin, input.trustIdentity);
  validateUuid(input.retryKey, 'enrollment retry key');
  validateEnrollmentCredential(input.credential);
  validateUuid(input.clientId, 'client identity');
  const serverCapabilities = validateServerCapabilities(input.serverCapabilities);
  const backend = await getServerCredentialBackend();
  const pendingAccount = serverPendingEnrollmentAccount(input.origin, input.trustIdentity);
  await withServerKeychainLock(pendingAccount, async () => {
    const stored = await backend.get(pendingAccount);
    if (!stored) throw new Error('pending Borg server enrollment is missing');
    try {
      const pending = decodePendingServerEnrollment(
        stored,
        input.origin,
        input.trustIdentity,
      );
      if (pending.retryKey !== input.retryKey || pending.credential !== input.credential) {
        throw new Error('mismatch');
      }
    } catch {
      throw new Error('pending Borg server enrollment does not match the verified response');
    }
    await storeServerCredential({
      origin: input.origin,
      trustIdentity: input.trustIdentity,
      credential: input.credential,
      clientId: input.clientId,
      serverCapabilities,
    });
    await backend.delete(pendingAccount);
  });
}

/** Delete only the exact definitively rejected pending attempt. */
export async function clearPendingServerEnrollment(
  origin: string,
  trustIdentity: string,
  retryKey: string,
): Promise<void> {
  validateUuid(retryKey, 'enrollment retry key');
  const backend = await getServerCredentialBackend();
  const account = serverPendingEnrollmentAccount(origin, trustIdentity);
  await withServerKeychainLock(account, async () => {
    const stored = await backend.get(account);
    if (!stored) return;
    try {
      const pending = decodePendingServerEnrollment(stored, origin, trustIdentity);
      if (pending.retryKey !== retryKey) return;
    } catch {
      return;
    }
    await backend.delete(account);
  });
}

/** Persist one repository-scoped cube-create idempotency key in the keychain. */
export async function getOrCreatePendingServerCubeCreation(
  input: {
    origin: string;
    trustIdentity: string;
    clientId: string;
    projectRoot: string;
    name: string;
    template: 'default';
  },
): Promise<PendingServerCubeCreationRecord> {
  validateServerCredentialBinding(input.origin, input.trustIdentity);
  validateUuid(input.clientId, 'client identity');
  if (input.projectRoot.length < 1 || input.projectRoot.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.projectRoot)) {
    throw new Error('invalid Borg server repository binding');
  }
  if (Buffer.byteLength(input.name, 'utf8') < 1 || Buffer.byteLength(input.name, 'utf8') > 120 ||
      !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(input.name)) {
    throw new Error('invalid Borg server cube name');
  }
  const repositoryBinding = createHash('sha256').update(input.projectRoot).digest('hex');
  const backend = await getServerCredentialBackend();
  const account = serverCubeRetryAccount(
    input.origin,
    input.trustIdentity,
    input.clientId,
    repositoryBinding,
  );
  return withServerKeychainLock(account, async () => {
    const stored = await backend.get(account);
    if (stored) {
      try {
        const record = JSON.parse(stored) as Partial<PendingServerCubeCreationRecord> & {
          version?: unknown;
          state?: unknown;
        };
        if (
          record.version !== SERVER_CUBE_RETRY_RECORD_VERSION ||
          record.state !== 'pending' ||
          record.origin !== input.origin ||
          record.trustIdentity !== input.trustIdentity ||
          record.clientId !== input.clientId ||
          record.repositoryBinding !== repositoryBinding ||
          record.name !== input.name ||
          record.template !== input.template ||
          typeof record.retryKey !== 'string' || !UUID_RE.test(record.retryKey)
        ) {
          throw new Error('mismatch');
        }
        return {
          origin: input.origin,
          trustIdentity: input.trustIdentity,
          clientId: input.clientId,
          repositoryBinding,
          retryKey: record.retryKey,
          name: input.name,
          template: input.template,
        };
      } catch {
        throw new Error('pending Borg server cube creation does not match this repository');
      }
    }
    const record: PendingServerCubeCreationRecord = {
      origin: input.origin,
      trustIdentity: input.trustIdentity,
      clientId: input.clientId,
      repositoryBinding,
      retryKey: randomUUID(),
      name: input.name,
      template: input.template,
    };
    await backend.set(account, JSON.stringify({
      version: SERVER_CUBE_RETRY_RECORD_VERSION,
      state: 'pending',
      ...record,
    }));
    return record;
  });
}

export async function clearPendingServerCubeCreation(
  record: PendingServerCubeCreationRecord,
): Promise<void> {
  const backend = await getServerCredentialBackend();
  const account = serverCubeRetryAccount(
    record.origin,
    record.trustIdentity,
    record.clientId,
    record.repositoryBinding,
  );
  await withServerKeychainLock(account, async () => {
    const stored = await backend.get(account);
    if (!stored) return;
    try {
      const pending = JSON.parse(stored) as { retryKey?: unknown };
      if (pending.retryKey !== record.retryKey) return;
    } catch {
      return;
    }
    await backend.delete(account);
  });
}

export async function clearServerCredential(origin: string, trustIdentity: string): Promise<void> {
  const backend = await getServerCredentialBackend();
  const pendingAccount = serverPendingEnrollmentAccount(origin, trustIdentity);
  await withServerKeychainLock(pendingAccount, async () => {
    await backend.delete(serverCredentialAccount(origin, trustIdentity));
    await backend.delete(pendingAccount);
  });
}

/**
 * Delete one drone-session record by its opaque reference. The backend.delete
 * runs UNDER the same per-account keychain lock every session writer takes
 * (getOrCreatePendingServerSession / activatePendingServerSession /
 * compareAndClearServerSessionCredential), so a concurrent same-ref remint can
 * never interleave between a reader's observation and this delete. This is the
 * ONLY unpinned session-credential delete; the pinned reset path uses the
 * atomic compareAndClearServerSessionCredential primitive instead.
 */
export async function clearServerSessionCredential(credentialRef: string): Promise<void> {
  validateServerSessionCredentialRef(credentialRef);
  const backend = await getServerCredentialBackend();
  await withServerKeychainLock(credentialRef, async () => {
    await backend.delete(credentialRef);
  });
}
