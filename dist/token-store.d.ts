/**
 * OS-keychain credential backend.
 *
 * config.ts's local-server credential group sits on top of this. The ONLY
 * supported storage engine is the OS keychain (@napi-rs/keyring) — real
 * platform at-rest encryption. There is deliberately NO obfuscation-grade
 * file fallback: local server credentials fail closed when the platform
 * keychain is unavailable rather than degrade to a weaker at-rest posture.
 *
 * The keyring entry factory is injected so the logic is unit-tested without a
 * real keychain.
 */
export type TokenBackendName = 'keychain';
/**
 * Account-agnostic key/value store over the OS keychain.
 */
export interface TokenBackend {
    readonly name: TokenBackendName;
    get(account: string): Promise<string | null>;
    set(account: string, value: string): Promise<void>;
    delete(account: string): Promise<void>;
}
/**
 * The slice of @napi-rs/keyring's AsyncEntry this backend depends on. The
 * return types mirror AsyncEntry exactly (deletePassword resolves to an
 * implementation-defined value we ignore) so the real class is assignable.
 */
export interface KeyringEntry {
    setPassword(value: string): Promise<void>;
    getPassword(): Promise<string | null | undefined>;
    deletePassword(): Promise<unknown>;
}
export type KeyringEntryFactory = (account: string) => KeyringEntry;
/**
 * Build the OS-keychain backend. A missing entry reads as null, and delete is
 * silent on a NoEntry error (idempotent clear) while other errors propagate
 * (fail-loud).
 */
export declare function makeKeychainBackend(entryFactory?: KeyringEntryFactory): TokenBackend;
//# sourceMappingURL=token-store.d.ts.map