import type { AcceptedEnrollmentMarker, EnrollmentArtifactBinding, EnrollmentTrustPointer } from './enrollment-types.js';
export type ServerFetch = typeof fetch;
export interface BorgServerTrust {
    identity: string;
    fetchImpl: ServerFetch;
}
export interface StagedBorgServerTrust extends BorgServerTrust {
    generationId: string;
    commitTrust: (activate: (context: {
        generationId: string;
        previousPointer: EnrollmentTrustPointer | null;
    }) => Promise<void>) => Promise<void>;
    discardTrust: () => Promise<void>;
}
type EnrollmentTrustFaultPoint = 'after-account-activation' | 'after-pointer-publish' | 'before-marker-finalize' | 'during-pointer-rollback';
/**
 * Minimal fetch-compatible HTTPS transport bound to one origin and one
 * explicit local CA. Node's global fetch cannot consume the server-owned CA,
 * and disabling certificate validation would collapse the authority boundary.
 */
export declare function createPinnedServerFetch(origin: string, caCertificate: string): ServerFetch;
export declare function loadBorgServerTrust(origin: string, dataDirectory?: string): Promise<BorgServerTrust>;
/** Bootstrap a remote pinned transport from the CA chain presented by the server. */
export declare function loadBorgServerTrustFromPresentedChain(origin: string, caSpkiSha256: string): Promise<StagedBorgServerTrust>;
export declare function stageBorgServerTrust(origin: string, certificate: string, identity: string): Promise<StagedBorgServerTrust>;
/** Verify the exact persisted artifact binding before any resumed network I/O. */
export declare function loadStagedBorgServerTrust(origin: string, binding: EnrollmentArtifactBinding): Promise<StagedBorgServerTrust>;
/** Explicit operator recovery restores the exact accepted journal that was reviewed. */
export declare function restoreBorgServerEnrollment(expected: AcceptedEnrollmentMarker): Promise<boolean>;
export declare function clearStagedBorgServerTrust(origin: string, generationId: string | undefined): Promise<void>;
export declare function __clearServerTrustCacheForTest(): void;
export declare function __setEnrollmentTrustFaultForTest(points: EnrollmentTrustFaultPoint | EnrollmentTrustFaultPoint[] | null): void;
export declare function clearBorgServerTrust(origin: string): Promise<void>;
export {};
//# sourceMappingURL=server-trust.d.ts.map