import { type ProtocolInfo } from 'borgmcp-shared/protocol';
import { getServerCredential, storeServerCredential, storeServerSessionCredential } from './config.js';
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
}
export interface ResolvedServerAuthority extends BorgServerTrust {
    token: string;
}
export interface NewServerEnrollment extends EnrolledServerConnection {
    clientId: string;
    credentialExpiresAt?: string | null;
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
 * stable server/CA identity. The secret stays in the versioned request body,
 * never the URL, argv, environment, output, or diagnostics. The returned
 * bearer is negotiated before it is written once to the dedicated keychain.
 */
export declare function enrollBorgServer(origin: string, trustIdentity: string, invitation: string, deps?: {
    fetchImpl?: FetchLike;
    storeCredential?: typeof storeServerCredential;
    clientName?: string;
}): Promise<NewServerEnrollment>;
/**
 * Swappable Part-4 integration seam. Trust verification supplies the server/CA
 * identity; this function then reads only the credential bound to that exact
 * origin+identity pair and negotiates the authenticated shared contract.
 */
export declare function connectEnrolledBorgServer(origin: string, trustIdentity: string, deps?: {
    loadCredential?: typeof getServerCredential;
    fetchImpl?: FetchLike;
}): Promise<EnrolledServerConnection>;
/** Resolve the same-user server CA and its authority-bound keychain credential. */
export declare function resolveBorgServerAuthority(origin: string, deps?: {
    loadTrust?: typeof loadBorgServerTrust;
    loadCredential?: typeof getServerCredential;
}): Promise<ResolvedServerAuthority>;
/** Load pinned trust, then prove the stored credential against /api/protocol. */
export declare function connectLocalBorgServer(origin: string, deps?: {
    loadTrust?: typeof loadBorgServerTrust;
    loadCredential?: typeof getServerCredential;
}): Promise<EnrolledServerConnection>;
/** Load and verify the local CA before sending a single-use invitation. */
export declare function enrollLocalBorgServer(origin: string, invitation: string, deps?: {
    loadTrust?: typeof loadBorgServerTrust;
    storeCredential?: typeof storeServerCredential;
    clientName?: string;
}): Promise<NewServerEnrollment>;
/** Advisory discovery that still verifies the server-owned CA. */
export declare function probeLocalBorgServer(origin: string): Promise<boolean>;
export {};
//# sourceMappingURL=server-handshake.d.ts.map