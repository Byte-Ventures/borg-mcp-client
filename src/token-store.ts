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

import path from 'path';
import crypto from 'crypto';
import { AsyncEntry } from '@napi-rs/keyring';
import { decryptString, encryptString } from './token-crypto.js';

const SERVICE_NAME = 'borg-mcp';

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

// ─── Keychain backend ───────────────────────────────────────────────────

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

const defaultEntryFactory: KeyringEntryFactory = (account) =>
  new AsyncEntry(SERVICE_NAME, account);

/**
 * Build the OS-keychain backend. Preserves config.ts's prior semantics:
 * a missing entry reads as null, and delete is silent on a NoEntry error
 * (idempotent clear) while other errors propagate (fail-loud).
 */
export function makeKeychainBackend(
  entryFactory: KeyringEntryFactory = defaultEntryFactory
): TokenBackend {
  return {
    name: 'keychain',
    async get(account) {
      return (await entryFactory(account).getPassword()) ?? null;
    },
    async set(account, value) {
      await entryFactory(account).setPassword(value);
    },
    async delete(account) {
      try {
        await entryFactory(account).deletePassword();
      } catch (err: any) {
        const msg = String(err?.message ?? '');
        if (/no entry|not found|no matching/i.test(msg)) return;
        throw err;
      }
    },
  };
}

// ─── Encrypted-file backend ─────────────────────────────────────────────

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

type AccountMap = Record<string, string>;

// gh#570 lock tuning. Token writes are tiny + infrequent, so a short retry
// cadence + a generous staleness window are right: the staleness window only
// has to exceed a real write (milliseconds), and a crashed lock-holder is
// reclaimed after it.
const LOCK_RETRY_DELAY_MS = 25;
const LOCK_MAX_WAIT_MS = 2000;
const LOCK_STALE_MS = 10_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultUniqueSuffix(): string {
  // PID + random keeps two concurrent writers' temp files distinct so the
  // temp write itself never races. crypto is already a client dependency.
  return `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
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
export function makeEncryptedFileBackend(deps: EncryptedFileBackendDeps): TokenBackend {
  const { filePath, key, fs } = deps;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const uniqueSuffix = deps.uniqueSuffix ?? defaultUniqueSuffix;
  const lockPath = `${filePath}.lock`;

  async function readMap(): Promise<AccountMap> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath);
    } catch {
      return {}; // missing file → no stored tokens yet
    }
    try {
      const json = decryptString(raw.trim(), key);
      const parsed = JSON.parse(json);
      return parsed && typeof parsed === 'object' ? (parsed as AccountMap) : {};
    } catch {
      return {}; // undecryptable / corrupt → fail safe to re-auth
    }
  }

  async function writeMap(map: AccountMap): Promise<void> {
    await fs.mkdir(path.dirname(filePath), 0o700);
    // Atomic write: encrypt → temp → rename. rename preserves the temp's 0600.
    const tmpPath = `${filePath}.${uniqueSuffix()}.tmp`;
    await fs.writeFile(tmpPath, encryptString(JSON.stringify(map), key), 0o600);
    try {
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // rename failed (disk full / permission). Remove the orphaned temp so
      // repeated failures don't accumulate .tmp files, then rethrow so the
      // caller still fails loud. Cleanup is best-effort — a failed unlink must
      // not mask the original error.
      try {
        await fs.removeFile(tmpPath);
      } catch {
        /* ignore cleanup failure — the original rename error takes precedence */
      }
      throw err;
    }
  }

  /**
   * Run `fn` while holding the O_EXCL lock, serializing read-modify-write
   * across processes. A lock left by a crashed holder is reclaimed once it is
   * older than LOCK_STALE_MS. If the lock can't be acquired within
   * LOCK_MAX_WAIT_MS, proceed best-effort (steal it): the worst case is the
   * original benign lost-update, never a stuck auth.
   */
  async function withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    // Ensure the credential directory exists BEFORE the first createExclusive.
    // The lock file lives in dirname(filePath); on a fresh ~/.borg (the headless
    // `borg setup --no-browser` first run) the O_EXCL open would otherwise fail
    // with ENOENT — writeMap's own mkdir runs only AFTER the lock is held, too
    // late to help. Recursive + idempotent (a present dir is a no-op); 0o700
    // matches the existing credential-dir posture (writeMap below).
    await fs.mkdir(path.dirname(lockPath), 0o700);
    const deadline = now() + LOCK_MAX_WAIT_MS;
    let held = false;
    while (!held) {
      held = await fs.createExclusive(lockPath, `${process.pid}@${now()}`);
      if (held) break;
      const age = await fs.fileAgeMs(lockPath);
      if (age !== null && age > LOCK_STALE_MS) {
        await fs.removeFile(lockPath); // reclaim a stale (crashed-holder) lock
        continue;
      }
      if (now() >= deadline) {
        await fs.removeFile(lockPath); // last resort: steal + proceed best-effort
        held = await fs.createExclusive(lockPath, `${process.pid}@${now()}`);
        break;
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
    try {
      return await fn();
    } finally {
      if (held) await fs.removeFile(lockPath);
    }
  }

  return {
    name: 'encrypted-file',
    async get(account) {
      // Lock-free: temp+rename guarantees readMap sees a complete file.
      const map = await readMap();
      return Object.prototype.hasOwnProperty.call(map, account) ? map[account] : null;
    },
    set(account, value) {
      return withFileLock(async () => {
        const map = await readMap();
        map[account] = value;
        await writeMap(map);
      });
    },
    delete(account) {
      return withFileLock(async () => {
        const map = await readMap();
        if (Object.prototype.hasOwnProperty.call(map, account)) {
          delete map[account];
          await writeMap(map);
        }
      });
    },
  };
}

// ─── Backend selection ──────────────────────────────────────────────────

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
export async function selectTokenBackend(
  deps: SelectTokenBackendDeps
): Promise<TokenBackend> {
  if (deps.forced === 'keychain') return deps.makeKeychain();
  if (deps.forced === 'file') return deps.makeFile();
  return (await deps.keyringAvailable()) ? deps.makeKeychain() : deps.makeFile();
}

// ─── Caller-managed (read-only) id_token ────────────────────────────────

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
export async function readCallerManagedIdToken(
  deps: CallerManagedDeps
): Promise<string | null> {
  const inline = deps.env.BORG_TOKEN?.trim();
  if (inline) return inline;

  const file = deps.env.BORG_TOKEN_FILE?.trim();
  if (file) {
    const contents = await deps.readFile(file);
    return contents.trim();
  }

  return null;
}
