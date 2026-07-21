/**
 * Local-server credential backend.
 *
 * config.ts's local-server credential group sits on top of this. Storage is the
 * 0600 file store (Queen rescope) — the OS keychain (@napi-rs/keyring) is GONE.
 * The raw secret rests only in the 0600 file, parity with the server's own TLS
 * private keys; there is no keychain and no obfuscation-grade fallback.
 */
import { atomicWrite0600, readStoreFile } from './seat-store.js';
import { dirname } from 'node:path';
// ─── 0600 file backend (Queen rescope: replaces the OS keychain) ─────────────
/**
 * Build a TokenBackend over a single 0600 store file, all accounts held in one
 * `{version, accounts}` map. get/set/delete read-modify-write the file via the
 * seat-store's atomic 0600 writer — the RAW secret rests only in the 0600 file
 * (parity with the server's TLS keys), never a keychain.
 *
 * These ops are NON-flocking by design: the config layer holds the single store
 * lock (withStoreLock over CREDENTIALS_LOCK) continuously across each
 * read-compare-write, so nesting a second lock here would deadlock the O_EXCL
 * lockfile. Pure reads (get) are safe lock-free because atomicWrite0600's rename
 * guarantees a reader only ever sees a complete file.
 */
export function makeFileBackend(filePath, storeOptions = {}) {
    const options = { secureRoot: dirname(filePath), ...storeOptions };
    const load = async () => {
        const raw = await readStoreFile(filePath, options);
        // CR4 fail-closed: ONLY a missing file initializes empty. A present-but-
        // malformed / wrong-version / schema-invalid credential store MUST NOT read as
        // empty — a subsequent set/delete would OVERWRITE it and erase every stored
        // account (parent enrollment credentials + pending records). Throw WITHOUT
        // writing so the corrupt bytes are preserved for recovery.
        if (raw === null)
            return {};
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('Borg credential store is malformed; refusing to overwrite it');
        }
        if (!parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed) ||
            parsed.version !== 1 ||
            !parsed.accounts ||
            typeof parsed.accounts !== 'object' ||
            Array.isArray(parsed.accounts)) {
            throw new Error('Borg credential store is malformed or has an unsupported version; refusing to overwrite it');
        }
        // CR#2: FULL value validation — every account value MUST be a string. A
        // non-string value (a corrupted/tampered entry) fails CLOSED without writing,
        // so a following set/delete never overwrites the store off a bad read.
        const accounts = parsed.accounts;
        for (const value of Object.values(accounts)) {
            if (typeof value !== 'string') {
                throw new Error('Borg credential store is malformed (a non-string account value); refusing to overwrite it');
            }
        }
        return { ...accounts };
    };
    const save = (accounts) => atomicWrite0600(filePath, JSON.stringify({ version: 1, accounts }, null, 2) + '\n', options);
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