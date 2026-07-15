/**
 * gh#557 — token storage backends + selection.
 *
 * config.ts exposes the public token API (storeIdToken/getIdToken/...). This
 * module supplies the interchangeable storage engines it sits on top of:
 *
 *   - KeychainBackend      — OS keychain via @napi-rs/keyring (the default;
 *                            real platform at-rest encryption).
 *   - EncryptedFileBackend — ~/.borg/credentials, all accounts in one
 *                            AES-256-GCM blob, file 0600 / dir 0700. Engages
 *                            only when no keychain is available. Obfuscation-
 *                            grade (see token-crypto.ts).
 *   - caller-managed       — BORG_TOKEN / BORG_TOKEN_FILE: an externally
 *                            supplied id_token, used read-only with no store
 *                            (the caller owns its lifecycle/freshness).
 *
 * Every engine takes its side-effecting dependencies (keyring entry factory,
 * fs, machine key) by injection so the logic is unit-tested without a real
 * keychain or disk.
 */
export type TokenBackendName = 'keychain' | 'encrypted-file';
/**
 * Account-agnostic key/value store over a backing engine. `account` is one
 * of config.ts's three slots (id-token, refresh-token, expiry).
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
 * Build the OS-keychain backend. Preserves config.ts's prior semantics:
 * a missing entry reads as null, and delete is silent on a NoEntry error
 * (idempotent clear) while other errors propagate (fail-loud).
 */
export declare function makeKeychainBackend(entryFactory?: KeyringEntryFactory): TokenBackend;
/** The minimal fs surface the file backend needs (injected for tests). */
export interface FileStoreFs {
    readFile(filePath: string): Promise<string>;
    writeFile(filePath: string, data: string, mode: number): Promise<void>;
    mkdir(dir: string, mode: number): Promise<void>;
    /** Atomically move `from`→`to` (overwrites). Used for crash-safe writes. */
    rename(from: string, to: string): Promise<void>;
    /**
     * Atomically create `lockPath` ONLY if it does not exist (O_EXCL). Resolves
     * `true` if it was created (lock acquired) or `false` if it already existed
     * (lock held by another process). This is the inter-process serialization
     * primitive — no native dependency.
     */
    createExclusive(lockPath: string, content: string): Promise<boolean>;
    /** Remove a file; silent if already gone (lock release + stale-lock steal). */
    removeFile(filePath: string): Promise<void>;
    /** Age in ms (now − mtime) of a file, or null if it does not exist. */
    fileAgeMs(filePath: string): Promise<number | null>;
}
export interface EncryptedFileBackendDeps {
    filePath: string;
    key: Buffer;
    fs: FileStoreFs;
    /** Backoff between lock-acquire retries; defaults to a real setTimeout sleep. */
    sleep?: (ms: number) => Promise<void>;
    /** Monotonic clock for the acquire deadline; defaults to Date.now. */
    now?: () => number;
    /** Unique suffix for the write temp file; defaults to a random hex token. */
    uniqueSuffix?: () => string;
}
/**
 * Build the encrypted-file backend. All accounts live in one JSON object
 * encrypted as a single AES-256-GCM envelope at `filePath`.
 *
 * A missing file reads as an empty map. A file that won't decrypt (wrong
 * machine key after a hostname change, truncation, tampering) is ALSO
 * treated as empty: the only consequence is the user re-runs `borg setup`,
 * which is the right fail-safe for credential material — a hard crash on a
 * corrupt dotfile would be worse UX than transparent re-auth.
 *
 * gh#570 — concurrency + atomicity. Multiple `borg` processes (e.g. sibling
 * drone sessions on one host) can share `~/.borg/credentials`. Two fixes:
 *  - Anti-lost-update (load-bearing): `set`/`delete` serialize their whole
 *    read-modify-write cycle behind an O_EXCL lock file, so concurrent
 *    writers no longer each read a stale map and clobber each other.
 *  - Anti-corruption: every write goes to a unique temp file then `rename`s
 *    into place, so a reader (which is intentionally lock-FREE) always sees a
 *    complete old-or-new file, never a torn one.
 */
export declare function makeEncryptedFileBackend(deps: EncryptedFileBackendDeps): TokenBackend;
/** User-facing BORG_TOKEN_STORE values (friendlier than the backend names). */
export type ForcedStore = 'keychain' | 'file';
export interface SelectTokenBackendDeps {
    keyringAvailable: () => Promise<boolean>;
    makeKeychain: () => TokenBackend;
    makeFile: () => TokenBackend;
    /** BORG_TOKEN_STORE override: skip probing and force a backend. */
    forced?: ForcedStore;
}
/**
 * Select the persistent backend: a forced choice (BORG_TOKEN_STORE=keychain|file)
 * wins and skips the probe; otherwise probe the keychain and fall back to the
 * encrypted file when it's unavailable.
 */
export declare function selectTokenBackend(deps: SelectTokenBackendDeps): Promise<TokenBackend>;
export interface CallerManagedDeps {
    env: NodeJS.ProcessEnv;
    readFile: (filePath: string) => Promise<string>;
}
/**
 * Resolve an externally-supplied id_token (no storage). BORG_TOKEN takes
 * precedence; otherwise BORG_TOKEN_FILE is read from disk. Returns null when
 * neither is configured. The value is trimmed (env vars and files commonly
 * carry trailing newlines). The caller owns this token's freshness, so it
 * bypasses the keychain AND the expiry check in config.ts.
 */
export declare function readCallerManagedIdToken(deps: CallerManagedDeps): Promise<string | null>;
//# sourceMappingURL=token-store.d.ts.map