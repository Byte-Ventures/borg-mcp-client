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
const defaultEntryFactory = (account) => new AsyncEntry(SERVICE_NAME, account);
/**
 * Build the OS-keychain backend. A missing entry reads as null, and delete is
 * silent on a NoEntry error (idempotent clear) while other errors propagate
 * (fail-loud).
 */
export function makeKeychainBackend(entryFactory = defaultEntryFactory) {
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
            }
            catch (err) {
                const msg = String(err?.message ?? '');
                if (/no entry|not found|no matching/i.test(msg))
                    return;
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
export function makeFileBackend(filePath) {
    const load = async () => {
        const raw = await readStoreFile(filePath);
        if (raw === null)
            return {};
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && parsed.accounts && typeof parsed.accounts === 'object') {
                return { ...parsed.accounts };
            }
        }
        catch {
            // A corrupt store reads as empty; a subsequent set rewrites it cleanly.
        }
        return {};
    };
    const save = (accounts) => atomicWrite0600(filePath, JSON.stringify({ version: 1, accounts }, null, 2) + '\n');
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
//# sourceMappingURL=token-store.js.map