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

// Age-based reclaim is a LAST-RESORT fallback used ONLY for a legacy/unparseable
// lockfile that carries no live-pid identity; a well-formed lock is reclaimed only
// when its holder PID is provably DEAD (CR3a), never on age alone.
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 500;

interface LockPayload {
  pid: number;
  token: string;
}

/**
 * CR3a liveness check. `process.kill(pid, 0)` sends no signal but validates the
 * target: ESRCH ⇒ no such process (DEAD → reclaimable); EPERM ⇒ the process exists
 * but is owned by another user (ALIVE → never reclaim). Any success ⇒ alive.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseLockPayload(raw: string): LockPayload | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; token?: unknown };
    if (typeof parsed.pid === 'number' && typeof parsed.token === 'string' && parsed.token.length > 0) {
      return { pid: parsed.pid, token: parsed.token };
    }
  } catch {
    /* unparseable — treated as a legacy/garbage lock by the caller */
  }
  return null;
}

/**
 * Ensure the store's parent directory exists at 0700 (checklist #3) AND repair-or-
 * refuse a loose pre-existing one (CR3c). `mkdir(mode)` does NOT tighten an already-
 * existing directory, so a pre-existing world/group-traversable parent would leave
 * the 0600 credential-at-rest reachable. Fail CLOSED rather than write a secret
 * beneath it.
 */
async function ensureParentDir(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  let existing: Awaited<ReturnType<typeof stat>> | null = null;
  try {
    existing = await stat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing) {
    if ((existing.mode & 0o777) !== 0o700) {
      throw new Error(
        `Borg store directory ${dir} has insecure permissions ` +
          `(0${(existing.mode & 0o777).toString(8)}, expected 0700); refusing to write a credential under it`,
      );
    }
    return;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Successor-safe steal: unlink the stale lock ONLY if its bytes are still EXACTLY
 * the ones we judged stale. If the holder released and a successor acquired between
 * our inspection and this unlink, the content differs → we must not remove the
 * successor's lock.
 */
async function reclaimIfUnchanged(lockPath: string, expected: string): Promise<void> {
  let current: string;
  try {
    current = await readFile(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  if (current !== expected) return;
  await unlink(lockPath).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}

/**
 * Identity-checked release (CR3a successor-safety): unlink ONLY if the lockfile
 * still carries OUR token. If a reclaimer judged us dead/stale and a successor now
 * holds the lock, its token differs and we must leave it intact — a blind unlink
 * would remove the successor's lock and let a third writer in concurrently.
 */
async function releaseIfOurs(lockPath: string, token: string): Promise<void> {
  let current: string;
  try {
    current = await readFile(lockPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const held = parseLockPayload(current);
  if (held && held.token !== token) return;
  await unlink(lockPath).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== 'ENOENT') throw e;
  });
}

/**
 * Atomic 0600 write (checklist #1 + #2): write to a same-dir temp opened
 * O_CREAT|O_EXCL at mode 0600 (never write-then-chmod), fsync the data, then
 * rename over the target (atomic; the mode carries across). A failed write
 * cleans up the temp so no leftover file ever holds the secret.
 */
export async function atomicWrite0600(filePath: string, data: string): Promise<void> {
  await ensureParentDir(filePath);
  const tmp = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await handle.close();
  try {
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Read the store file, or null when it does not exist. */
export async function readStoreFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Acquire the single advisory lock (checklist #4), run `op`, and release the lock
 * on EVERY path (finally) including a throw. The lockfile is O_EXCL-created; a
 * crashed holder is reclaimed after a bounded stale interval.
 */
export async function withStoreLock<T>(
  lockPath: string,
  op: () => Promise<T>,
  opts: { attempts?: number; waitMs?: number; staleMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? LOCK_ATTEMPTS;
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  const staleMs = opts.staleMs ?? LOCK_STALE_MS;
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const myToken = randomBytes(16).toString('hex');
  const myPayload = JSON.stringify({ pid: process.pid, token: myToken });
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // The lock is held. Read the holder's identity and reclaim ONLY when its PID
      // is provably DEAD — a live-but-slow holder (even one past the age threshold)
      // keeps its lock (CR3a). A legacy/unparseable payload with no live-pid info
      // falls back to a bounded age gate so a crashed pre-upgrade holder can't wedge.
      let raw: string;
      try {
        raw = await readFile(lockPath, 'utf8');
      } catch (readErr) {
        if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue; // released — retry
        throw readErr;
      }
      const held = parseLockPayload(raw);
      let reclaim: boolean;
      if (held) {
        reclaim = !isProcessAlive(held.pid);
      } else {
        try {
          const metadata = await stat(lockPath);
          reclaim = Date.now() - metadata.mtimeMs > staleMs;
        } catch (inspectionError) {
          if ((inspectionError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw inspectionError;
        }
      }
      if (reclaim) {
        await reclaimIfUnchanged(lockPath, raw);
        continue;
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
      continue;
    }
    // We own the lock. Stamp our identity so a reclaimer can liveness-check us and
    // our release can identity-check before unlinking.
    try {
      await handle.writeFile(myPayload);
    } finally {
      await handle.close();
    }
    try {
      return await op();
    } finally {
      await releaseIfOurs(lockPath, myToken);
    }
  }
  throw new Error('Borg seat store is busy');
}

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
export async function withStore<S, T>(
  storePath: string,
  emptyState: () => S,
  parse: (raw: string) => S | null,
  op: (txn: StoreTxn<S>) => Promise<T>,
): Promise<T> {
  return withStoreLock(`${storePath}.lock`, async () => {
    const raw = await readStoreFile(storePath);
    // CR4 fail-closed: ONLY a missing file (ENOENT → readStoreFile returns null)
    // may initialize an empty state. A present-but-malformed / wrong-version /
    // schema-invalid store must NEVER be silently mapped to empty and then
    // OVERWRITTEN by a subsequent commit — that erases every seat/credential and
    // silently recreates authority. Throw WITHOUT writing so the corrupt bytes are
    // preserved for recovery (parity with getServerCredentialRecord).
    let data: S;
    if (raw === null) {
      data = emptyState();
    } else {
      let loaded: S | null;
      try {
        loaded = parse(raw);
      } catch {
        loaded = null;
      }
      if (loaded === null) {
        throw new Error(
          'Borg seat store is malformed or has an unsupported version; refusing to overwrite it',
        );
      }
      data = loaded;
    }
    const txn: StoreTxn<S> = {
      data,
      commit: () => atomicWrite0600(storePath, JSON.stringify(data, null, 2) + '\n'),
    };
    return op(txn);
  });
}
