/**
 * 0600 flocked atomic file store (Queen rescope: replaces the OS keychain).
 *
 * This is the SINGLE storage primitive the collapsed seat/credential model sits
 * on. It provides one advisory lock plus an atomic 0600 read-compare-write so
 * that a record and everything that must stay consistent with it are written as
 * ONE atomic unit (a temp-write + rename either lands wholly or not at all).
 *
 * SR-seven file-store checklist (fb0e446d) implemented here:
 *   1. 0600 AT CREATE — the temp file is opened O_CREAT|O_EXCL mode 0600, and
 *      rename preserves the mode, so the secret is never world/group-readable for
 *      any window (no write-then-chmod).
 *   2. ATOMIC RENAME — temp in the SAME dir/fs, created 0600, fsync THEN rename;
 *      a crash never leaves a torn/readable partial, and the temp is cleaned up
 *      on any write failure.
 *   3. PARENT DIR 0700 — created with mode 0700.
 *   4. flock DISCIPLINE — a single advisory lock (O_EXCL lockfile + bounded
 *      stale-mtime reclaim, the established repo idiom since Node has no flock);
 *      the whole read-compare-write runs inside ONE continuous hold, released on
 *      EVERY path (finally) including throw. No per-account locks, no TOCTOU
 *      between acquire and commit.
 *
 * The raw secret rests only in the 0600 file (parity with the server's TLS keys);
 * this module never logs it, and the digest-only observation discipline of the
 * callers keeps the raw bearer from leaving the store owner.
 */
/**
 * Atomic 0600 write (checklist #1 + #2): write to a same-dir temp opened
 * O_CREAT|O_EXCL at mode 0600 (never write-then-chmod), fsync the data, then
 * rename over the target (atomic; the mode carries across). A failed write
 * cleans up the temp so no leftover file ever holds the secret.
 */
export declare function atomicWrite0600(filePath: string, data: string): Promise<void>;
/** Read the store file, or null when it does not exist. */
export declare function readStoreFile(filePath: string): Promise<string | null>;
/**
 * Acquire the single advisory lock (checklist #4), run `op`, and release the lock
 * on EVERY path (finally) including a throw. The lockfile is O_EXCL-created; a
 * crashed holder is reclaimed after a bounded stale interval.
 */
export declare function withStoreLock<T>(lockPath: string, op: () => Promise<T>): Promise<T>;
/** A locked, in-memory transaction over one store file. */
export interface StoreTxn<S> {
    /** The mutable in-memory state, loaded under the lock. Mutate then commit(). */
    data: S;
    /** Atomically persist `data` (0600) — the single-write commit of the RCW. */
    commit(): Promise<void>;
}
/**
 * Run a read-compare-write transaction over `storePath` under the single store
 * lock: load the current state (or an empty one), hand the caller a mutable view
 * + an atomic commit, and release the lock on every path. The entire read →
 * compare → (mutate) → commit happens inside ONE lock hold — no TOCTOU.
 */
export declare function withStore<S, T>(storePath: string, emptyState: () => S, parse: (raw: string) => S | null, op: (txn: StoreTxn<S>) => Promise<T>): Promise<T>;
//# sourceMappingURL=seat-store.d.ts.map