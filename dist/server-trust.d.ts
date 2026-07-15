export type ServerFetch = typeof fetch;
export interface BorgServerTrust {
    identity: string;
    fetchImpl: ServerFetch;
}
/**
 * Minimal fetch-compatible HTTPS transport bound to one origin and one
 * explicit local CA. Node's global fetch cannot consume the server-owned CA,
 * and disabling certificate validation would collapse the authority boundary.
 */
export declare function createPinnedServerFetch(origin: string, caCertificate: string): ServerFetch;
export declare function loadBorgServerTrust(origin: string, dataDirectory?: string): Promise<BorgServerTrust>;
export declare function __clearServerTrustCacheForTest(): void;
//# sourceMappingURL=server-trust.d.ts.map