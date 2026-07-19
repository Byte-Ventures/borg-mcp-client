/**
 * Local-server credential backend.
 *
 * config.ts's local-server credential group sits on top of this. Storage is the
 * 0600 file store (Queen rescope) — the OS keychain (@napi-rs/keyring) is GONE.
 * The raw secret rests only in the 0600 file, parity with the server's own TLS
 * private keys; there is no keychain and no obfuscation-grade fallback.
 */
export type TokenBackendName = 'file';
/**
 * Account-agnostic key/value store over the 0600 credential file.
 */
export interface TokenBackend {
    readonly name: TokenBackendName;
    get(account: string): Promise<string | null>;
    set(account: string, value: string): Promise<void>;
    delete(account: string): Promise<void>;
}
/**
 * Build a TokenBackend over a single 0600 store file, all accounts held in one
 * `{version, accounts}` map. get/set/delete read-modify-write the file via the
 * seat-store's atomic 0600 writer — the RAW secret rests only in the 0600 file
 * (parity with the server's TLS keys), never a keychain.
 *
 * These ops are NON-flocking by design: the config layer holds the single store
 * lock (withStoreLock over CREDENTIALS_LOCK) continuously across each
 * read-compare-write, so nesting a second lock here would deadlock the O_EXCL
 * lockfile. Pure reads (get) are safe lock-free because atomicWrite0600's rename
 * guarantees a reader only ever sees a complete file.
 */
export declare function makeFileBackend(filePath: string): TokenBackend;
//# sourceMappingURL=token-store.d.ts.map