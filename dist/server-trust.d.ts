export type ServerFetch = typeof fetch;
export interface BorgServerTrust {
    identity: string;
    fetchImpl: ServerFetch;
}
export interface StagedBorgServerTrust extends BorgServerTrust {
    commitTrust: (activate: () => Promise<void>) => Promise<void>;
    discardTrust: () => Promise<void>;
}
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
export declare function __clearServerTrustCacheForTest(): void;
//# sourceMappingURL=server-trust.d.ts.map