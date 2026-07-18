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

import { AsyncEntry } from '@napi-rs/keyring';
import { atomicWrite0600, readStoreFile } from './seat-store.js';

const SERVICE_NAME = 'borg-mcp';

export type TokenBackendName = 'keychain' | 'file';

/**
 * Account-agnostic key/value store over the OS keychain.
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
 * Build the OS-keychain backend. A missing entry reads as null, and delete is
 * silent on a NoEntry error (idempotent clear) while other errors propagate
 * (fail-loud).
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

// ─── 0600 file backend (Queen rescope: replaces the OS keychain) ─────────────

/**
 * Build a TokenBackend over a single 0600 store file, all accounts held in one
 * `{version, accounts}` map. get/set/delete read-modify-write the file via the
 * seat-store's atomic 0600 writer — the RAW secret rests only in the 0600 file
 * (parity with the server's TLS keys), never a keychain.
 *
 * These ops are NON-flocking by design: the config layer holds the single store
 * lock (withServerKeychainLock → withStoreLock) continuously across each
 * read-compare-write, so nesting a second lock here would deadlock the O_EXCL
 * lockfile. Pure reads (get) are safe lock-free because atomicWrite0600's rename
 * guarantees a reader only ever sees a complete file.
 */
export function makeFileBackend(filePath: string): TokenBackend {
  const load = async (): Promise<Record<string, string>> => {
    const raw = await readStoreFile(filePath);
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw) as { accounts?: unknown };
      if (parsed && typeof parsed === 'object' && parsed.accounts && typeof parsed.accounts === 'object') {
        return { ...(parsed.accounts as Record<string, string>) };
      }
    } catch {
      // A corrupt store reads as empty; a subsequent set rewrites it cleanly.
    }
    return {};
  };
  const save = (accounts: Record<string, string>): Promise<void> =>
    atomicWrite0600(filePath, JSON.stringify({ version: 1, accounts }, null, 2) + '\n');
  return {
    name: 'file',
    async get(account) {
      const accounts = await load();
      return Object.prototype.hasOwnProperty.call(accounts, account) ? accounts[account] : null;
    },
    async set(account, value) {
      const accounts = await load();
      accounts[account] = value;
      await save(accounts);
    },
    async delete(account) {
      const accounts = await load();
      if (Object.prototype.hasOwnProperty.call(accounts, account)) {
        delete accounts[account];
        await save(accounts);
      }
    },
  };
}
