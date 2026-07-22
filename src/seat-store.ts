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
 *   3. PARENT DIR — private stores require 0700. The canonical ~/.borg parent
 *      may explicitly use the owner-controlled policy (0755 accepted, 0022
 *      forbidden) without rewriting its established mode.
 *   4. flock DISCIPLINE — a single advisory lock (O_EXCL lockfile), RULED option
 *      (b) (Coordinator cca6957a): NO automatic reclaim, EVER. Acquire is an atomic
 *      `open(lockPath,'wx',0o600)`; the whole read-compare-write runs inside ONE
 *      continuous hold, released on EVERY path (finally) by unlinking our OWN lock.
 *      A pre-existing lock held by a LIVE pid is waited on (bounded) then reported
 *      transient-busy; a lock whose recorded pid is DEAD (or whose payload is
 *      missing/unparseable) FAILS CLOSED naming the exact lockfile path — Borg NEVER
 *      steals or auto-deletes it (rename-claim reclaim is rejected: pathname
 *      substitution). No per-account locks, no TOCTOU between acquire and commit.
 *
 * The raw secret rests only in the 0600 file (parity with the server's TLS keys);
 * this module never logs it, and the digest-only observation discipline of the
 * callers keeps the raw bearer from leaving the store owner.
 */

import { constants } from 'node:fs';
import { open, link, lstat, mkdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { borgConfigRoot, ensurePrivateBorgConfigRoot } from './private-root.js';

const LOCK_WAIT_MS = 10;
const LOCK_ATTEMPTS = 500;

interface LockPayload {
  pid: number;
  /** ISO process start time — an operator-facing hint and a PID-reuse tell. */
  startTime: string;
}

export interface SecureStoreOptions {
  secureRoot?: string;
  rootMode?: 'private' | 'owner-controlled';
}

function expectedUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

async function assertSecureRoot(
  root: string,
  rootMode: SecureStoreOptions['rootMode'] = 'private',
): Promise<void> {
  if (!isAbsolute(root) || resolve(root) !== root) {
    throw new Error(`Borg credential store path ${root} is not canonical`);
  }
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(root, { recursive: true, mode: 0o700 });
    metadata = await lstat(root);
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Borg credential store root ${root} must be a real directory, not a symlink`);
  }
  const mode = metadata.mode & 0o777;
  if (rootMode === 'private' ? mode !== 0o700 : (mode & 0o022) !== 0) {
    throw new Error(
      `Borg credential store root ${root} has insecure permissions; ` +
      (rootMode === 'private' ? 'expected 0700' : 'group/world write access is forbidden'),
    );
  }
  const uid = expectedUid();
  if (uid !== null && metadata.uid !== uid) {
    throw new Error(`Borg credential store root ${root} is not owned by the current user`);
  }
  if (await realpath(root) !== root) {
    throw new Error(`Borg credential store root ${root} is not canonical or contains a symlink`);
  }
}

async function assertSecureFile(filePath: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`Borg credential store file ${filePath} must be a regular file, not a symlink`);
  }
  if ((metadata.mode & 0o777) !== 0o600) {
    throw new Error(`Borg credential store file ${filePath} has insecure permissions; expected 0600`);
  }
  const uid = expectedUid();
  if (uid !== null && metadata.uid !== uid) {
    throw new Error(`Borg credential store file ${filePath} is not owned by the current user`);
  }
  return metadata;
}

async function assertSecurePath(filePath: string, options: SecureStoreOptions): Promise<void> {
  const secureRoot = options.secureRoot!;
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath || dirname(filePath) !== secureRoot) {
    throw new Error(`Borg credential store file path ${filePath} is not canonical`);
  }
  await assertSecureRoot(secureRoot, options.rootMode);
}

/**
 * Liveness check for the alive/dead branch (RULED option b). `process.kill(pid, 0)`
 * sends no signal but validates the target: ESRCH ⇒ no such process (DEAD → fail
 * closed); EPERM ⇒ the process exists but is owned by another user (ALIVE → wait).
 * Any success ⇒ alive. This decides ONLY whether to wait vs. fail closed — it never
 * authorizes a reclaim.
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

/** Approximate wall-clock process start time (Date.now() − uptime). */
function processStartTime(): string {
  return new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();
}

function parseLockPayload(raw: string): LockPayload | null {
  try {
    const parsed = JSON.parse(raw) as { pid?: unknown; startTime?: unknown };
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return {
        pid: parsed.pid,
        startTime: typeof parsed.startTime === 'string' ? parsed.startTime : 'unknown',
      };
    }
  } catch {
    /* unparseable — treated as a corrupt/foreign lock by the caller (fail closed) */
  }
  return null;
}

/**
 * The fail-closed stale-lock error (RULED option b). Names the EXACT lockfile path
 * plus the recorded dead pid / start time, and tells the operator to delete that
 * file ONLY if no borg process is running. Borg never removes it automatically.
 */
function staleLockError(lockPath: string, held: LockPayload | null): Error {
  const who = held
    ? `its recorded owner process (pid ${held.pid}, started ${held.startTime}) is no longer running`
    : 'its lock file is missing a valid owner identity or is corrupt';
  return new Error(
    `Borg seat store lock file ${lockPath} is stale: ${who}. ` +
      'Borg will NOT remove it automatically. If no borg process is running on this ' +
      `machine, delete ${lockPath} and retry; otherwise wait for the other borg process to finish.`,
  );
}

/**
 * Ensure the store's parent directory exists at 0700 (checklist #3) AND repair-or-
 * refuse a loose pre-existing one (CR3c). `mkdir(mode)` does NOT tighten an already-
 * existing directory, so a pre-existing world/group-traversable parent would leave
 * the 0600 credential-at-rest reachable. Fail CLOSED rather than write a secret
 * beneath it.
 */
async function ensureParentDir(filePath: string): Promise<void> {
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath) {
    throw new Error(`Borg store file path ${filePath} is not canonical`);
  }
  const dir = dirname(filePath);
  if (dir === borgConfigRoot()) {
    const root = await ensurePrivateBorgConfigRoot();
    try {
      await root.verify();
    } finally {
      await root.close();
    }
    return;
  }
  let existing: Awaited<ReturnType<typeof lstat>> | null = null;
  try {
    existing = await lstat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error(`Borg store directory ${dir} must be a real directory, not a symlink`);
    }
    if ((existing.mode & 0o777) !== 0o700) {
      throw new Error(
        `Borg store directory ${dir} has insecure permissions ` +
          `(0${(existing.mode & 0o777).toString(8)}, expected 0700); refusing to write a credential under it`,
      );
    }
    const uid = expectedUid();
    if (uid !== null && existing.uid !== uid) {
      throw new Error(`Borg store directory ${dir} is not owned by the current user`);
    }
    return;
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
}

/**
 * Atomic 0600 write (checklist #1 + #2): write to a same-dir temp opened
 * O_CREAT|O_EXCL at mode 0600 (never write-then-chmod), fsync the data, then
 * rename over the target (atomic; the mode carries across). A failed write
 * cleans up the temp so no leftover file ever holds the secret.
 */
export async function atomicWrite0600(
  filePath: string,
  data: string,
  options: SecureStoreOptions = {},
): Promise<void> {
  if (options.secureRoot) await assertSecurePath(filePath, options);
  else await ensureParentDir(filePath);
  if (options.secureRoot) await assertSecureFile(filePath);
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
    if (options.secureRoot) {
      await assertSecurePath(filePath, options);
      await assertSecureFile(filePath);
    }
    await rename(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/**
 * CR#2: enforce the at-rest perms on the READ / no-op paths too (not just
 * atomicWrite). A secret must NEVER be read from a group/other-accessible store
 * file, nor from under a group/other-traversable parent. Fail CLOSED without
 * reading the bytes. Mirrors the server-trust.ts `(mode & 0o077) !== 0` idiom.
 */
async function assertSecureStorePerms(
  filePath: string,
  fileMode: number,
): Promise<void> {
  if ((fileMode & 0o077) !== 0) {
    throw new Error(
      `Borg seat store file ${filePath} has insecure permissions ` +
        `(0${(fileMode & 0o777).toString(8)}, expected 0600); refusing to read a credential from it`,
    );
  }
  const dir = dirname(filePath);
  let dirStat: Awaited<ReturnType<typeof stat>>;
  try {
    dirStat = await stat(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // vanished — readFile handles
    throw err;
  }
  if ((dirStat.mode & 0o077) !== 0) {
    throw new Error(
      `Borg seat store directory ${dir} has insecure permissions ` +
        `(0${(dirStat.mode & 0o777).toString(8)}, expected 0700); refusing to read a credential under it`,
    );
  }
}

/**
 * Read the store file, or null when it does not exist (ONLY the missing-file
 * no-op path initializes empty). When the file exists, the 0600-store + 0700-parent
 * perms are enforced BEFORE the bytes are read (CR#2) — a loosely-permissioned
 * secret fails closed and is never read.
 */
export async function readStoreFile(
  filePath: string,
  options: SecureStoreOptions = {},
): Promise<string | null> {
  if (!isAbsolute(filePath) || resolve(filePath) !== filePath) {
    throw new Error(`Borg store file path ${filePath} is not canonical`);
  }
  if (options.secureRoot) await assertSecurePath(filePath, options);
  if (options.secureRoot) {
    const before = await assertSecureFile(filePath);
    if (!before) return null;
    let handle;
    try {
      handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const opened = await handle.stat();
      if (opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error('Borg credential store file changed while it was being opened');
      }
      const raw = await handle.readFile('utf8');
      const after = await handle.stat();
      if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
        throw new Error('Borg credential store file changed while it was being read');
      }
      return raw;
    } finally {
      await handle.close();
    }
  }
  let fileStat: Awaited<ReturnType<typeof lstat>>;
  try {
    fileStat = await lstat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
    throw new Error(`Borg store file ${filePath} must be a regular file, not a symlink`);
  }
  const uid = expectedUid();
  if (uid !== null && fileStat.uid !== uid) {
    throw new Error(`Borg store file ${filePath} is not owned by the current user`);
  }
  await assertSecureStorePerms(filePath, fileStat.mode);
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Acquire the single advisory lock (checklist #4, RULED option b), run `op`, and
 * release it on EVERY path (finally) by unlinking OUR OWN lock. Acquire is an atomic
 * `open(lockPath,'wx',0o600)`. On EEXIST the lock is held:
 *   - holder PID ALIVE → bounded wait/retry (attempts×waitMs), then throw the truthful
 *     transient 'Borg seat store is busy' error;
 *   - holder PID DEAD, or the payload is missing/unparseable → FAIL CLOSED naming the
 *     exact lockfile path + the recorded dead pid/start-time. Borg NEVER auto-deletes
 *     or steals it (no reclaim, no rename-claim). The operator clears it by hand only
 *     after confirming no borg process is running.
 * Because nothing ever steals a held lock, a plain unlink of our own lock on release
 * is safe (no successor can be holding it).
 */
export async function withStoreLock<T>(
  lockPath: string,
  op: () => Promise<T>,
  opts: { attempts?: number; waitMs?: number } & SecureStoreOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? LOCK_ATTEMPTS;
  const waitMs = opts.waitMs ?? LOCK_WAIT_MS;
  if (opts.secureRoot) await assertSecurePath(lockPath, opts);
  else await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const myPayload = JSON.stringify({ pid: process.pid, startTime: processStartTime() });
  // Stage the FULLY-WRITTEN payload in a same-dir temp, then acquire by atomically
  // hard-linking it into place. `link` is atomic (EEXIST when the lock is held), and
  // because the target appears already carrying the complete payload there is NO
  // empty creation window — a concurrent contender never misreads a just-created
  // lock as a corrupt/missing payload (which under option (b) would wrongly fail
  // closed). A plain `open('wx')` create-then-write leaves exactly that window.
  const tmp = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.acq`;
  const staged = await open(tmp, 'wx', 0o600);
  try {
    await staged.writeFile(myPayload);
  } finally {
    await staged.close();
  }
  try {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await link(tmp, lockPath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // The lock is held. Inspect the holder — but NEVER reclaim/steal it.
        let raw: string;
        try {
          const stored = await readStoreFile(
            lockPath,
            opts.secureRoot
              ? { secureRoot: opts.secureRoot, rootMode: opts.rootMode }
              : {},
          );
          if (stored === null) continue;
          raw = stored;
        } catch (readErr) {
          if ((readErr as NodeJS.ErrnoException).code === 'ENOENT') continue; // released — retry
          throw readErr;
        }
        const held = parseLockPayload(raw);
        if (held && isProcessAlive(held.pid)) {
          // A live-but-slow holder keeps its lock: wait a bounded interval and retry.
          await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
          continue;
        }
        // Dead recorded holder, or a missing/unparseable payload → fail closed. The
        // operator must confirm no borg process is running and delete the file by hand.
        throw staleLockError(lockPath, held);
      }
      // We own the lock (it already carries our payload from the staged temp).
      try {
        return await op();
      } finally {
        // No reclaim exists, so nobody can be holding our lock — a plain unlink is safe.
        await unlink(lockPath).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== 'ENOENT') throw e;
        });
      }
    }
    throw new Error('Borg seat store is busy');
  } finally {
    await unlink(tmp).catch(() => {});
  }
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
  options: SecureStoreOptions = {},
): Promise<T> {
  return withStoreLock(`${storePath}.lock`, async () => {
    const raw = await readStoreFile(storePath, options);
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
      commit: () => atomicWrite0600(storePath, JSON.stringify(data, null, 2) + '\n', options),
    };
    return op(txn);
  }, options);
}
