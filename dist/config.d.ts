import type { ServerCapability } from 'borgmcp-shared/protocol';
import { type TokenBackend } from './token-store.js';
interface ServerKeychainLockTestHooks {
    afterStaleStat?: () => Promise<void>;
    afterStaleInspection?: () => Promise<void>;
    afterReaperClaim?: () => Promise<void>;
    afterActiveReaperElection?: () => Promise<void>;
    afterActiveClaimRead?: () => Promise<void>;
    beforeOwnerCleanup?: () => Promise<void>;
}
/** @internal Process-race harness only; never wired by production callers. */
export declare function __setServerKeychainLockHooksForTest(hooks: ServerKeychainLockTestHooks | null): void;
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
export declare function withServerKeychainLock<T>(account: string, operation: () => Promise<T>): Promise<T>;
/**
 * Resolve the client's bearer for one seat, generating + persisting a PENDING
 * record before the first attach. An existing record (pending or active) for
 * the same seat returns its exact bearer so a lost-response retry re-sends the
 * identical credential the server already digest-bound.
 */
export declare function getOrCreatePendingServerSession(input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
}): Promise<PendingServerSessionRecord>;
/**
 * Enrich the exact pending record IN PLACE with the server-assigned drone and
 * session identity after a verified `created`/`reused` response, marking it
 * active. No rename/copy window: the bearer never moves accounts.
 */
export declare function activatePendingServerSession(input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
    droneId: string;
    sessionId: string;
    expiresAt: string;
}): Promise<string>;
/**
 * The deterministic per-seat keychain reference for a pending/active session,
 * known at PREPARE time (from origin+trust+cube+role+operation, before any
 * activation). The composite attach FINALIZE uses it to persist the cubes
 * binding referencing the EXACT pending record BEFORE the single pending→ACTIVE
 * transition, so an ACTIVE credential is never observable without a binding.
 */
export declare function serverSessionCredentialRef(input: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
}): string;
/**
 * Resolve the active bearer stored at an opaque per-seat reference. The role is
 * not required from the caller — the reference itself binds the role, so the
 * stored record's own role must re-derive the exact same account. Returns null
 * for a missing/pending/foreign/mismatched record so callers fail closed.
 */
export declare function getActiveServerSessionCredential(credentialRef: string, binding: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
}): Promise<string | null>;
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
export declare function compareAndClearServerSessionCredential(credentialRef: string, binding: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
}, expectedSessionDigest: string): Promise<boolean>;
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
export declare function compareAndClearPendingServerSession(credentialRef: string, binding: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
}, expectedBearerDigest: string): Promise<boolean>;
/**
 * Discard any pending/active session record for one seat so the next attach
 * mints a fresh bearer. Used by the eviction/remint recovery path where the
 * saved seat is known invalid and a new seat must be created.
 */
export declare function clearPendingServerSession(binding: {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
}): Promise<void>;
/** Test-only server-keychain injection. */
export declare function __setServerCredentialBackendForTest(backend: TokenBackend | null): void;
/**
 * Persist one self-hosted server credential in the dedicated OS-keychain namespace.
 *
 * The account key binds both the canonical authority origin and the verified
 * server/CA identity. A credential enrolled for one authority is therefore
 * never considered for another endpoint or trust anchor. Enrollment owns the
 * write; command-line arguments and environment variables are intentionally
 * not credential sources.
 */
export declare function storeServerCredential(record: ServerCredentialRecord): Promise<void>;
/** Read an authority-bound active client record, failing closed on corruption. */
export declare function getServerCredentialRecord(origin: string, trustIdentity: string): Promise<ActiveServerCredentialRecord | null>;
/** Read only the bearer for existing call sites that do not need capability metadata. */
export declare function getServerCredential(origin: string, trustIdentity: string): Promise<string | null>;
/** Load an exact durable PENDING tuple so a new process can resume it. */
export declare function getPendingServerEnrollment(origin: string, trustIdentity: string): Promise<PendingServerEnrollmentRecord | null>;
/**
 * Generate and persist an exact enrollment tuple before network I/O. A
 * pre-existing PENDING tuple must match the invitation and presentation name;
 * this makes response-loss retries exact without minting a second bearer.
 */
export declare function getOrCreatePendingServerEnrollment(input: {
    origin: string;
    trustIdentity: string;
    invitation: string;
    clientName?: string;
}): Promise<PendingServerEnrollmentRecord>;
/** Activate the exact pending tuple only after a verified server response. */
export declare function activatePendingServerEnrollment(input: {
    origin: string;
    trustIdentity: string;
    retryKey: string;
    credential: string;
    clientId: string;
    serverCapabilities: ServerCapability[];
}): Promise<void>;
/** Delete only the exact definitively rejected pending attempt. */
export declare function clearPendingServerEnrollment(origin: string, trustIdentity: string, retryKey: string): Promise<void>;
/** Persist one repository-scoped cube-create idempotency key in the keychain. */
export declare function getOrCreatePendingServerCubeCreation(input: {
    origin: string;
    trustIdentity: string;
    clientId: string;
    projectRoot: string;
    name: string;
    template: 'default';
}): Promise<PendingServerCubeCreationRecord>;
export declare function clearPendingServerCubeCreation(record: PendingServerCubeCreationRecord): Promise<void>;
export declare function clearServerCredential(origin: string, trustIdentity: string): Promise<void>;
/**
 * Delete one drone-session record by its opaque reference. The backend.delete
 * runs UNDER the same per-account keychain lock every session writer takes
 * (getOrCreatePendingServerSession / activatePendingServerSession /
 * compareAndClearServerSessionCredential), so a concurrent same-ref remint can
 * never interleave between a reader's observation and this delete. This is the
 * ONLY unpinned session-credential delete; the pinned reset path uses the
 * atomic compareAndClearServerSessionCredential primitive instead.
 */
export declare function clearServerSessionCredential(credentialRef: string): Promise<void>;
export {};
//# sourceMappingURL=config.d.ts.map