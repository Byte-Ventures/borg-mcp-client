import { type CreateCubeResponse, type ProtocolTagPreflight, type ServerCapability } from 'borgmcp-shared/protocol';
import { activatePendingServerEnrollment, compareAndActivatePendingServerSession, clearPendingServerCubeCreation, clearPendingServerEnrollment, compareAndClearPendingServerSession, getServerCredential, getServerCredentialRecord, getPendingServerEnrollment, getOrCreatePendingServerCubeCreation, getOrCreatePendingServerEnrollment, getOrCreatePendingServerSession, serverSessionCredentialRef, type ServerSessionOperation } from './config.js';
import { loadBorgServerTrust, type BorgServerTrust } from './server-trust.js';
export declare const DEFAULT_LOCAL_SERVER_ORIGIN: "https://127.0.0.1:7091";
type FetchLike = typeof fetch;
/** Bodyless, non-identifying liveness probe from the shared contract. */
export declare function probeBorgServer(origin: string, fetchImpl?: FetchLike, timeoutMs?: number): Promise<boolean>;
/**
 * Credential-free protocol-tag preflight. After the caller has verified pinned
 * TLS, confirm the server speaks the exact protocol tag BEFORE any bearer is
 * created, sent, or a seat attached. Sends NO Authorization header, cookie,
 * query, or body; rejects redirects; and bounds the response. A tag mismatch,
 * an extra field, or any transport anomaly fails closed here — no keychain
 * write, no attach, no Cloud fallback. The bearer is proven only at attach.
 */
export declare function preflightBorgServerTag(origin: string, fetchImpl?: FetchLike): Promise<ProtocolTagPreflight>;
export interface EnrolledServerConnection {
    token: string;
    trustIdentity: string;
    protocol: ProtocolTagPreflight;
    clientId?: string | null;
    serverCapabilities?: ServerCapability[];
}
export interface ResolvedServerAuthority extends BorgServerTrust {
    token: string;
}
export interface NewServerEnrollment extends EnrolledServerConnection {
    clientId: string;
    serverCapabilities: ServerCapability[];
}
export interface ServerAttachResult {
    cube: {
        id: string;
        name: string;
    };
    role: {
        id: string;
        name: string;
        role_class?: 'queen' | 'worker';
        is_human_seat?: boolean;
    };
    drone: {
        id: string;
        label: string;
    };
    session: {
        credentialRef: string;
        sessionId: string;
        expiresAt: string;
    };
    result: 'created' | 'reused';
}
/**
 * Attach an enrolled client principal to one granted cube/role over protocol v2.
 * The client CSPRNG-generates the session bearer and persists it PENDING in the
 * OS keychain (keyed by the stable per-seat identity) BEFORE this request, so an
 * interrupted/lost response is recovered by re-sending the exact same bearer —
 * the server binds only its digest. A verified `created`/`reused` response
 * activates that pending record in place; the server never returns a bearer.
 */
/**
 * The PREPARE + network half of an attach, WITHOUT the keychain pending→ACTIVE
 * transition. The deferred `activate` / `scrubPending` thunks let the cube-lock-
 * owning orchestration (assimilate) FINALIZE binding-FIRST: write the cubes
 * binding referencing this exact pending record under the cube lock, THEN call
 * `activate()` as the single last step. `credentialRef` is the deterministic
 * per-seat account, known here (before activation) so the binding can reference
 * it. `scrubPending` compare-and-scrubs ONLY this own pending record on a
 * FINALIZE abort.
 */
export interface PreparedServerAttach {
    cube: ServerAttachResult['cube'];
    role: ServerAttachResult['role'];
    drone: ServerAttachResult['drone'];
    session: {
        sessionId: string;
        expiresAt: string;
    };
    result: 'created' | 'reused';
    credentialRef: string;
    pendingBearerDigest: string;
    activate: () => Promise<string>;
    scrubPending: () => Promise<boolean>;
}
export declare function prepareBorgServerAttach(origin: string, trustIdentity: string, parentCredential: string, request: {
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
    priorDroneId?: string;
}, deps?: {
    fetchImpl?: FetchLike;
    getPendingSession?: typeof getOrCreatePendingServerSession;
    activateSession?: typeof compareAndActivatePendingServerSession;
    scrubPending?: typeof compareAndClearPendingServerSession;
    sessionCredentialRef?: typeof serverSessionCredentialRef;
}): Promise<PreparedServerAttach>;
/**
 * PREPARE + network + activate, as a single call (the pre-composite contract).
 * Retained for callers/tests that do not drive the cube-lock-held FINALIZE
 * themselves; the assimilate orchestration now uses prepareBorgServerAttach +
 * finalizeServerSeatAttachment so the binding lands BEFORE the pending→ACTIVE flip.
 */
export declare function attachBorgServer(origin: string, trustIdentity: string, parentCredential: string, request: {
    cubeId: string;
    roleId: string;
    operation: ServerSessionOperation;
    priorDroneId?: string;
}, deps?: {
    fetchImpl?: FetchLike;
    getPendingSession?: typeof getOrCreatePendingServerSession;
    activateSession?: typeof compareAndActivatePendingServerSession;
}): Promise<ServerAttachResult>;
/**
 * Redeem one invitation after the caller has verified TLS and derived the
 * stable server/CA identity. The client-generated bearer + retry key are
 * persisted PENDING in the OS keychain before the first request. A transport-
 * ambiguous exchange is retried with that exact tuple; only a decoded response
 * followed by an authenticated protocol proof activates the bearer.
 */
export declare function enrollBorgServer(origin: string, trustIdentity: string, invitation: string, deps?: {
    fetchImpl?: FetchLike;
    prepareEnrollment?: typeof getOrCreatePendingServerEnrollment;
    activateEnrollment?: typeof activatePendingServerEnrollment;
    clearPendingEnrollment?: typeof clearPendingServerEnrollment;
    clientName?: string;
}): Promise<NewServerEnrollment>;
/** Resume an exact durable enrollment tuple without asking for the invitation again. */
export declare function resumeBorgServerEnrollment(origin: string, trustIdentity: string, deps?: {
    fetchImpl?: FetchLike;
    loadPendingEnrollment?: typeof getPendingServerEnrollment;
    activateEnrollment?: typeof activatePendingServerEnrollment;
    clearPendingEnrollment?: typeof clearPendingServerEnrollment;
    onPending?: () => void;
}): Promise<NewServerEnrollment | null>;
/**
 * Create one repository cube through the narrow owner capability. The retry
 * key is persisted in the OS keychain before network I/O and reused exactly
 * after an ambiguous transport result. Ordinary clients are denied locally
 * before any create request is sent.
 */
export declare function createBorgServerCube(origin: string, trustIdentity: string, parentCredential: string, input: {
    projectRoot: string;
    name: string;
}, deps?: {
    fetchImpl?: FetchLike;
    loadCredentialRecord?: typeof getServerCredentialRecord;
    prepareCubeCreation?: typeof getOrCreatePendingServerCubeCreation;
    clearCubeCreation?: typeof clearPendingServerCubeCreation;
}): Promise<CreateCubeResponse>;
export declare function createLocalBorgServerCube(origin: string, trustIdentity: string, parentCredential: string, input: {
    projectRoot: string;
    name: string;
}, deps?: {
    loadTrust?: typeof loadBorgServerTrust;
}): Promise<CreateCubeResponse>;
/**
 * Swappable Part-4 integration seam. Trust verification supplies the server/CA
 * identity; this function then reads only the credential bound to that exact
 * origin+identity pair and negotiates the authenticated shared contract.
 */
export declare function connectEnrolledBorgServer(origin: string, trustIdentity: string, deps?: {
    loadCredential?: typeof getServerCredential;
    loadCredentialRecord?: typeof getServerCredentialRecord;
    fetchImpl?: FetchLike;
}): Promise<EnrolledServerConnection>;
/** Resolve the same-user server CA and its authority-bound keychain credential. */
export declare function resolveBorgServerAuthority(origin: string, deps?: {
    loadTrust?: typeof loadBorgServerTrust;
    loadCredential?: typeof getServerCredential;
    loadCredentialRecord?: typeof getServerCredentialRecord;
}): Promise<ResolvedServerAuthority>;
/** Load pinned trust, then prove the stored credential against /api/protocol. */
export declare function connectLocalBorgServer(origin: string, deps?: {
    loadTrust?: typeof loadBorgServerTrust;
    loadCredential?: typeof getServerCredential;
    loadCredentialRecord?: typeof getServerCredentialRecord;
}): Promise<EnrolledServerConnection>;
/** Load and verify the local CA before sending an enrollment invitation. */
export declare function enrollLocalBorgServer(origin: string, invitation: string, deps?: {
    loadTrust?: typeof loadBorgServerTrust;
    prepareEnrollment?: typeof getOrCreatePendingServerEnrollment;
    activateEnrollment?: typeof activatePendingServerEnrollment;
    clearPendingEnrollment?: typeof clearPendingServerEnrollment;
    clientName?: string;
}): Promise<NewServerEnrollment>;
/** Load verified trust and resume a prior ambiguous enrollment before prompting. */
export declare function resumeLocalBorgServerEnrollment(origin: string, deps?: {
    loadTrust?: typeof loadBorgServerTrust;
    loadPendingEnrollment?: typeof getPendingServerEnrollment;
    onPending?: () => void;
}): Promise<NewServerEnrollment | null>;
/** Advisory discovery that still verifies the server-owned CA. */
export declare function probeLocalBorgServer(origin: string): Promise<boolean>;
export {};
//# sourceMappingURL=server-handshake.d.ts.map