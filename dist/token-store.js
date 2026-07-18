/**
 * Local-server credential backend.
 *
 * config.ts's local-server credential group sits on top of this. Storage is the
 * 0600 file store (Queen rescope) — the OS keychain (@napi-rs/keyring) is GONE.
 * The raw secret rests only in the 0600 file, parity with the server's own TLS
 * private keys; there is no keychain and no obfuscation-grade fallback.
 */
import { atomicWrite0600, readStoreFile } from './seat-store.js';
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