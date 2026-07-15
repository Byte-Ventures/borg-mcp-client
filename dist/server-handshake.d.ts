import { type CreateCubeResponse, type ProtocolInfo, type ServerCapability } from 'borgmcp-shared/protocol';
import { activatePendingServerEnrollment, clearPendingServerCubeCreation, clearPendingServerEnrollment, getServerCredential, getServerCredentialRecord, getPendingServerEnrollment, getOrCreatePendingServerCubeCreation, getOrCreatePendingServerEnrollment, storeServerSessionCredential } from './config.js';
import { loadBorgServerTrust, type BorgServerTrust } from './server-trust.js';
export declare const DEFAULT_LOCAL_SERVER_ORIGIN: "https://127.0.0.1:7091";
type FetchLike = typeof fetch;
/** Bodyless, non-identifying liveness probe from the shared contract. */
export declare function probeBorgServer(origin: string, fetchImpl?: FetchLike, timeoutMs?: number): Promise<boolean>;
/**
 * Authenticate and negotiate the shared protocol without consulting Cloud.
 * The caller supplies an authority- and trust-bound credential from secure
 * storage; redirects are rejected so bearer credentials never cross origins.
 */
export declare function negotiateBorgServer(origin: string, credential: string, fetchImpl?: FetchLike): Promise<ProtocolInfo>;
export interface EnrolledServerConnection {
    token: string;
    trustIdentity: string;
    protocol: ProtocolInfo;
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
        generation: number;
        expiresAt: string | null;
    };
    reattached: boolean;
}
/**
 * Attach an enrolled client principal to one granted cube/role. The response
 * bearer is written to a generation-specific keychain entry before this
 * function returns; only its opaque reference crosses into caller state.
 */
export declare function attachBorgServer(origin: string, trustIdentity: string, parentCredential: string, request: {
    cubeId: string;
    roleId: string;
    retryKey: string;
}, deps?: {
    fetchImpl?: FetchLike;
    storeSessionCredential?: typeof storeServerSessionCredential;
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
/** Load and verify the local CA before sending a single-use invitation. */
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
}): Promise<NewServerEnrollment | null>;
/** Advisory discovery that still verifies the server-owned CA. */
export declare function probeLocalBorgServer(origin: string): Promise<boolean>;
export {};
//# sourceMappingURL=server-handshake.d.ts.map