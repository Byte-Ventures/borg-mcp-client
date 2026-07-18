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
import { open, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 500;
/** Ensure the store's parent directory exists with 0700 permissions (checklist #3). */
async function ensureParentDir(filePath) {
    await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
}
/**
 * Atomic 0600 write (checklist #1 + #2): write to a same-dir temp opened
 * O_CREAT|O_EXCL at mode 0600 (never write-then-chmod), fsync the data, then
 * rename over the target (atomic; the mode carries across). A failed write
 * cleans up the temp so no leftover file ever holds the secret.
 */
export async function atomicWrite0600(filePath, data) {
    await ensureParentDir(filePath);
    const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    const handle = await open(tmp, 'wx', 0o600);
    try {
        await handle.writeFile(data);
        await handle.sync();
    }
    catch (err) {
        await handle.close().catch(() => { });
        await unlink(tmp).catch(() => { });
        throw err;
    }
    await handle.close();
    try {
        await rename(tmp, filePath);
    }
    catch (err) {
        await unlink(tmp).catch(() => { });
        throw err;
    }
}
/** Read the store file, or null when it does not exist. */
export async function readStoreFile(filePath) {
    try {
        return await readFile(filePath, 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        throw err;
    }
}
/**
 * Acquire the single advisory lock (checklist #4), run `op`, and release the lock
 * on EVERY path (finally) including a throw. The lockfile is O_EXCL-created; a
 * crashed holder is reclaimed after a bounded stale interval.
 */
export async function withStoreLock(lockPath, op) {
    await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
        let handle;
        try {
            handle = await open(lockPath, 'wx', 0o600);
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            try {
                const metadata = await stat(lockPath);
                if (Date.now() - metadata.mtimeMs > LOCK_STALE_MS) {
                    await unlink(lockPath).catch((e) => {
                        if (e.code !== 'ENOENT')
                            throw e;
                    });
                    continue;
                }
            }
            catch (inspectionError) {
                if (inspectionError.code === 'ENOENT')
                    continue;
                throw inspectionError;
            }
            await new Promise((resolvePromise) => setTimeout(resolvePromise, LOCK_WAIT_MS));
            continue;
        }
        try {
            return await op();
        }
        finally {
            await handle.close();
            await unlink(lockPath).catch((e) => {
                if (e.code !== 'ENOENT')
                    throw e;
            });
        }
    }
    throw new Error('Borg seat store is busy');
}
/**
 * Run a read-compare-write transaction over `storePath` under the single store
 * lock: load the current state (or an empty one), hand the caller a mutable view
 * + an atomic commit, and release the lock on every path. The entire read →
 * compare → (mutate) → commit happens inside ONE lock hold — no TOCTOU.
 */
export async function withStore(storePath, emptyState, parse, op) {
    return withStoreLock(`${storePath}.lock`, async () => {
        const raw = await readStoreFile(storePath);
        // CR4 fail-closed: ONLY a missing file (ENOENT → readStoreFile returns null)
        // may initialize an empty state. A present-but-malformed / wrong-version /
        // schema-invalid store must NEVER be silently mapped to empty and then
        // OVERWRITTEN by a subsequent commit — that erases every seat/credential and
        // silently recreates authority. Throw WITHOUT writing so the corrupt bytes are
        // preserved for recovery (parity with getServerCredentialRecord).
        let data;
        if (raw === null) {
            data = emptyState();
        }
        else {
            let loaded;
            try {
                loaded = parse(raw);
            }
            catch {
                loaded = null;
            }
            if (loaded === null) {
                throw new Error('Borg seat store is malformed or has an unsupported version; refusing to overwrite it');
            }
            data = loaded;
        }
        const txn = {
            data,
            commit: () => atomicWrite0600(storePath, JSON.stringify(data, null, 2) + '\n'),
        };
        return op(txn);
    });
}
//# sourceMappingURL=seat-store.js.map