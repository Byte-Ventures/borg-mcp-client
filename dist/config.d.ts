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
export interface ServerSessionCredentialRecord {
    origin: string;
    trustIdentity: string;
    cubeId: string;
    droneId: string;
    generation: number;
    credential: string;
    expiresAt?: string | null;
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
/**
 * gh#860: is THIS process's selected persistent backend the OS keychain? The
 * runtime-fallback (auth.ts) gates on this so a keychain WRITE failure migrates
 * to file ONLY from the keychain — a write failure already on the file backend
 * is a real disk problem, not a locked keychain, and must NOT loop.
 */
export declare function isUsingKeychainBackend(): Promise<boolean>;
/**
 * gh#860: runtime fallback — re-point THIS process's persistent backend to the
 * encrypted-file backend after a keychain WRITE failure (the temporal #858 case:
 * keychain worked at setup, an aged background child later loses write access).
 * This is an in-memory, per-process switch — NOT a persisted setting: keychain
 * stays the default for every other install and the next fresh process re-probes.
 * The durable opt-in (BORG_TOKEN_STORE=file) is the persistent counterpart.
 *
 * ATOMIC (gh#860 SR HIGH 3bed8571): build the file backend, write ALL token
 * accounts to it, and commit the process backend switch (backendPromise) ONLY
 * after every write succeeds. On any write failure: best-effort roll back the
 * partial file write and DO NOT commit — the process stays on its current
 * (keychain) backend, so a failed migration can never SILENTLY leave the process
 * file-backed (obfuscation-grade) without the caller's at-rest warning, nor leave
 * a partial credential behind. Returns true iff the tokens are durably saved to
 * file (caller then warns about the at-rest tradeoff); false leaves the process
 * exactly as it was (caller falls back to #858's transient surface).
 *
 * The file backend is obfuscation-grade (token-crypto.ts) — weaker at-rest than
 * the keychain. On a true return the caller MUST surface that tradeoff.
 */
export declare function migrateToFileBackendWithTokens(tokens: {
    idToken: string;
    expiresAt: number;
    refreshToken?: string;
}, deps?: {
    fileBackend?: TokenBackend;
}): Promise<boolean>;
/** Test-only: force the memoized backend so migration atomicity is testable. */
export declare function __setBackendForTest(backend: TokenBackend | null): void;
/** Test-only server-keychain injection; separate from the OAuth backend. */
export declare function __setServerCredentialBackendForTest(backend: TokenBackend | null): void;
/**
 * Store Google OAuth ID token securely in the selected backend.
 */
export declare function storeIdToken(idToken: string, expiresAt: number): Promise<void>;
/**
 * Store Google OAuth refresh token securely in the selected backend.
 */
export declare function storeRefreshToken(refreshToken: string): Promise<void>;
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
 * Write one rotated local drone-session bearer to a generation-specific
 * keychain entry. The returned opaque reference is safe to persist in
 * cubes.json; the bearer itself never leaves the keychain record.
 */
export declare function storeServerSessionCredential(record: ServerSessionCredentialRecord): Promise<string>;
/** Resolve an opaque local-session reference only when every binding matches. */
export declare function getServerSessionCredential(credentialRef: string, binding: Omit<ServerSessionCredentialRecord, 'credential' | 'expiresAt'>): Promise<string | null>;
export declare function clearServerSessionCredential(credentialRef: string): Promise<void>;
/**
 * Retrieve the Google OAuth ID token.
 *
 * A caller-managed token (BORG_TOKEN / BORG_TOKEN_FILE) takes precedence and
 * is returned verbatim — the caller owns its freshness, so the expiry buffer
 * does not apply. Otherwise reads the persistent backend and returns null if
 * not stored or within the 5-minute expiry buffer.
 */
export declare function getIdToken(): Promise<string | null>;
/**
 * Retrieve the Google OAuth refresh token. There is no refresh_token in
 * caller-managed mode (the externally-supplied id_token has no refresh
 * counterpart), so this returns null whenever a caller-managed token is set.
 */
export declare function getRefreshToken(): Promise<string | null>;
/**
 * Clear all stored tokens from the selected backend. Idempotent — clearing
 * an already-empty store is a no-op. Does not touch caller-managed env vars
 * (those are the caller's to manage).
 */
export declare function clearTokens(): Promise<void>;
/**
 * Check if user has valid authentication.
 */
export declare function isAuthenticated(): Promise<boolean>;
export {};
//# sourceMappingURL=config.d.ts.map