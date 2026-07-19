import type { ServerCapability } from 'borgmcp-shared/protocol';
import { type TokenBackend } from './token-store.js';
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
/** Test-only credential-store backend injection. */
export declare function __setServerCredentialBackendForTest(backend: TokenBackend | null): void;
/**
 * Persist one self-hosted server credential in the dedicated 0600 credential store.
 *
 * The account key binds both the canonical authority origin and the verified
 * server/CA identity. A credential enrolled for one authority is therefore
 * never considered for another endpoint or trust anchor. Enrollment owns the
 * write; command-line arguments and environment variables are intentionally
 * not credential sources. CR3b: the load→set→rename runs inside ONE hold of the
 * single store lock so a concurrent writer cannot lose an unrelated account.
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
/** Persist one repository-scoped cube-create idempotency key in the 0600 credential store. */
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
//# sourceMappingURL=config.d.ts.map