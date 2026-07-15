/**
 * Normalize the endpoint accepted by `borg assimilate --host <host>`.
 *
 * Bare hosts default to HTTPS, including loopback: the ratified v1 server
 * architecture requires TLS for every authority. Plaintext endpoints are
 * rejected even on loopback so enrollment credentials never cross HTTP.
 */
export declare function normalizeServerEndpoint(input: string): string;
//# sourceMappingURL=server-endpoint.d.ts.map