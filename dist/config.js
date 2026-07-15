/**
 * Secure token storage.
 *
 * The public API (storeIdToken / getIdToken / getRefreshToken / clearTokens /
 * isAuthenticated) is unchanged; what changed in gh#557 is what sits beneath
 * it. Three storage paths, in precedence order:
 *
 *   1. Caller-managed (read-only): if BORG_TOKEN / BORG_TOKEN_FILE supplies an
 *      id_token, it's served verbatim — no keychain, no expiry check, no
 *      refresh_token. The caller owns the token's lifecycle (CI, containers,
 *      `borg --token-file`).
 *   2. OS keychain (default): @napi-rs/keyring — real platform at-rest
 *      encryption (macOS Keychain / Windows Credential Vault / libsecret).
 *   3. Encrypted file (fallback): ~/.borg/credentials, AES-256-GCM under a
 *      machine-derived key, 0600. Engages only when no keychain is available
 *      (headless Linux without Secret Service). Obfuscation-grade — see
 *      token-crypto.ts.
 *
 * The persistent backend (2 or 3) is selected once per process and memoized.
 * BORG_TOKEN_STORE=keychain|file forces the choice and skips the probe.
 */
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';
import { promises as fsp } from 'fs';
import { AsyncEntry } from '@napi-rs/keyring';
import { isKeyringAvailable } from './auth-env.js';
import { deriveMachineKey } from './token-crypto.js';
import { makeKeychainBackend, makeEncryptedFileBackend, selectTokenBackend, readCallerManagedIdToken, } from './token-store.js';
const ID_TOKEN_ACCOUNT = 'google-id-token';
const REFRESH_TOKEN_ACCOUNT = 'google-refresh-token';
const TOKEN_EXPIRY_ACCOUNT = 'token-expiry';
const SERVER_CREDENTIAL_RECORD_VERSION = 1;
const SERVER_SESSION_RECORD_VERSION = 1;
const SERVER_KEYCHAIN_SERVICE = 'borg-mcp-local-server';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validateServerCredentialBinding(origin, trustIdentity) {
    let parsed;
    try {
        parsed = new URL(origin);
    }
    catch {
        throw new Error('invalid Borg server credential origin');
    }
    if (parsed.origin !== origin || parsed.protocol !== 'https:') {
        throw new Error('Borg server credentials require a canonical HTTPS origin');
    }
    if (trustIdentity.length < 1 ||
        trustIdentity.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(trustIdentity)) {
        throw new Error('invalid Borg server trust identity');
    }
}
function serverCredentialAccount(origin, trustIdentity) {
    validateServerCredentialBinding(origin, trustIdentity);
    const binding = createHash('sha256')
        .update(origin)
        .update('\0')
        .update(trustIdentity)
        .digest('hex');
    return `borg-server-credential:${binding}`;
}
function validateServerSessionBinding(record) {
    validateServerCredentialBinding(record.origin, record.trustIdentity);
    if (!UUID_RE.test(record.cubeId) || !UUID_RE.test(record.droneId)) {
        throw new Error('invalid Borg server session identity');
    }
    if (!Number.isSafeInteger(record.generation) || record.generation < 1) {
        throw new Error('invalid Borg server session generation');
    }
    if (record.expiresAt !== undefined &&
        record.expiresAt !== null &&
        (!Number.isFinite(Date.parse(record.expiresAt)) || record.expiresAt.length > 64)) {
        throw new Error('invalid Borg server session expiry');
    }
}
function serverSessionCredentialAccount(record) {
    validateServerSessionBinding(record);
    const binding = createHash('sha256')
        .update(record.origin)
        .update('\0')
        .update(record.trustIdentity)
        .update('\0')
        .update(record.cubeId)
        .update('\0')
        .update(record.droneId)
        .update('\0')
        .update(record.generation.toString())
        .digest('hex');
    return `borg-server-session:${binding}`;
}
function validateServerSessionCredentialRef(credentialRef) {
    if (!/^borg-server-session:[a-f0-9]{64}$/.test(credentialRef)) {
        throw new Error('invalid Borg server session credential reference');
    }
}
/** Where the encrypted-file fallback lives when no keychain is available. */
function credentialsPath() {
    return path.join(os.homedir(), '.borg', 'credentials');
}
/** Production fs adapter for the encrypted-file backend. */
const nodeFs = {
    readFile: (filePath) => fsp.readFile(filePath, 'utf8'),
    writeFile: async (filePath, data, mode) => {
        // `mode` on writeFile only applies when the file is CREATED; chmod after
        // guarantees 0600 even when rewriting an existing credentials file.
        await fsp.writeFile(filePath, data, { mode });
        await fsp.chmod(filePath, mode);
    },
    mkdir: async (dir, mode) => {
        await fsp.mkdir(dir, { recursive: true, mode });
    },
    // gh#570: atomic write (temp→rename) + O_EXCL lock primitives.
    rename: (from, to) => fsp.rename(from, to),
    createExclusive: async (lockPath, content) => {
        try {
            // 'wx' = O_CREAT | O_EXCL | O_WRONLY → fails with EEXIST if the lock
            // already exists, giving us the atomic acquire primitive.
            await fsp.writeFile(lockPath, content, { flag: 'wx', mode: 0o600 });
            return true;
        }
        catch (err) {
            if (err?.code === 'EEXIST')
                return false;
            throw err;
        }
    },
    removeFile: async (filePath) => {
        try {
            await fsp.unlink(filePath);
        }
        catch (err) {
            if (err?.code !== 'ENOENT')
                throw err; // silent if already gone
        }
    },
    fileAgeMs: async (filePath) => {
        try {
            const stat = await fsp.stat(filePath);
            return Date.now() - stat.mtimeMs;
        }
        catch (err) {
            if (err?.code === 'ENOENT')
                return null;
            throw err;
        }
    },
};
/** Map the user-facing BORG_TOKEN_STORE value to a forced backend, if valid. */
function parseForcedStore(value) {
    const v = value?.trim().toLowerCase();
    if (v === 'keychain')
        return 'keychain';
    if (v === 'file' || v === 'encrypted-file')
        return 'file';
    return undefined;
}
/** Backend-selection deps, shared by the initial probe and the gh#860 runtime
 * migration so both build the keychain/file engines identically. `forced` skips
 * the keyring probe (BORG_TOKEN_STORE opt-in, or the runtime file fallback). */
function backendSelectionDeps(forced) {
    return {
        keyringAvailable: () => isKeyringAvailable(),
        makeKeychain: () => makeKeychainBackend(),
        makeFile: () => makeEncryptedFileBackend({
            filePath: credentialsPath(),
            key: deriveMachineKey({
                hostname: os.hostname(),
                username: os.userInfo().username,
                platform: process.platform,
            }),
            fs: nodeFs,
        }),
        forced,
    };
}
// Memoized persistent-backend selection (one keychain probe per process).
let backendPromise = null;
function getBackend() {
    if (!backendPromise) {
        backendPromise = selectTokenBackend(backendSelectionDeps(parseForcedStore(process.env.BORG_TOKEN_STORE)));
    }
    return backendPromise;
}
// Local-server bearers deliberately do not use the OAuth token backend's
// encrypted-file fallback. They live in a distinct OS-keychain namespace and
// fail closed when the platform keychain is unavailable.
let serverCredentialBackendPromise = null;
async function getServerCredentialBackend() {
    if (!serverCredentialBackendPromise) {
        serverCredentialBackendPromise = (async () => {
            if (!(await isKeyringAvailable())) {
                throw new Error('OS keychain unavailable for Borg server credentials');
            }
            return makeKeychainBackend((account) => new AsyncEntry(SERVER_KEYCHAIN_SERVICE, account));
        })();
    }
    return serverCredentialBackendPromise;
}
/**
 * gh#860: is THIS process's selected persistent backend the OS keychain? The
 * runtime-fallback (auth.ts) gates on this so a keychain WRITE failure migrates
 * to file ONLY from the keychain — a write failure already on the file backend
 * is a real disk problem, not a locked keychain, and must NOT loop.
 */
export async function isUsingKeychainBackend() {
    return (await getBackend()).name === 'keychain';
}
/**
 * gh#860: runtime fallback — re-point THIS process's persistent backend to the
 * encrypted-file backend after a keychain WRITE failure (the temporal #858 case:
 * keychain worked at setup, an aged background child later loses write access).
 * This is an in-memory, per-process switch — NOT a persisted setting: keychain
 * stays the default for every other install and the next fresh process re-probes.
 * The durable opt-in (BORG_TOKEN_STORE=file) is the persistent counterpart.
 *
 * ATOMIC (gh#860 SR HIGH 3bed8571): build the file backend, write ALL token
 * accounts to it, and commit the process backend switch (backendPromise) ONLY
 * after every write succeeds. On any write failure: best-effort roll back the
 * partial file write and DO NOT commit — the process stays on its current
 * (keychain) backend, so a failed migration can never SILENTLY leave the process
 * file-backed (obfuscation-grade) without the caller's at-rest warning, nor leave
 * a partial credential behind. Returns true iff the tokens are durably saved to
 * file (caller then warns about the at-rest tradeoff); false leaves the process
 * exactly as it was (caller falls back to #858's transient surface).
 *
 * The file backend is obfuscation-grade (token-crypto.ts) — weaker at-rest than
 * the keychain. On a true return the caller MUST surface that tradeoff.
 */
export async function migrateToFileBackendWithTokens(tokens, deps = {}) {
    const fileBackend = deps.fileBackend ?? (await selectTokenBackend(backendSelectionDeps('file')));
    // gh#860 (SA LOW 9f228d42 + CR 3e3fb4df): snapshot-and-restore rollback. For each
    // account, capture its PRIOR value before overwriting; on a failed migration,
    // restore each applied account to exactly that prior value (delete if it had
    // none). A bare delete-rollback would CLOBBER a pre-existing ~/.borg/credentials
    // value that this migration OVERWROTE (mixed/sequential keychain+file use) — the
    // restore preserves it. The account whose write threw is never in `applied` (we
    // record only after the set resolves), and an atomic set that throws leaves the
    // store unchanged, so it needs no restore.
    const accountWrites = [];
    if (tokens.refreshToken !== undefined) {
        accountWrites.push([REFRESH_TOKEN_ACCOUNT, tokens.refreshToken]);
    }
    accountWrites.push([ID_TOKEN_ACCOUNT, tokens.idToken]);
    accountWrites.push([TOKEN_EXPIRY_ACCOUNT, tokens.expiresAt.toString()]);
    const applied = [];
    try {
        for (const [account, value] of accountWrites) {
            const prior = await fileBackend.get(account); // snapshot BEFORE overwrite
            await fileBackend.set(account, value);
            applied.push({ account, prior }); // record only after the set resolves
        }
    }
    catch {
        // Best-effort restore (newest first): put each overwritten account back to its
        // prior value, or delete it if it didn't exist before. Then do NOT commit.
        for (const { account, prior } of applied.reverse()) {
            try {
                if (prior === null)
                    await fileBackend.delete(account);
                else
                    await fileBackend.set(account, prior);
            }
            catch {
                /* best-effort restore — the write failure still means "not migrated" */
            }
        }
        return false;
    }
    // Commit ONLY after every write succeeded — never before.
    backendPromise = Promise.resolve(fileBackend);
    return true;
}
/** Test-only: force the memoized backend so migration atomicity is testable. */
export function __setBackendForTest(backend) {
    backendPromise = backend ? Promise.resolve(backend) : null;
}
/** Test-only server-keychain injection; separate from the OAuth backend. */
export function __setServerCredentialBackendForTest(backend) {
    serverCredentialBackendPromise = backend ? Promise.resolve(backend) : null;
}
/** Caller-managed id_token (BORG_TOKEN / BORG_TOKEN_FILE), or null. */
function callerManagedIdToken() {
    return readCallerManagedIdToken({
        env: process.env,
        readFile: (filePath) => fsp.readFile(filePath, 'utf8'),
    });
}
/**
 * Store Google OAuth ID token securely in the selected backend.
 */
export async function storeIdToken(idToken, expiresAt) {
    const backend = await getBackend();
    await backend.set(ID_TOKEN_ACCOUNT, idToken);
    await backend.set(TOKEN_EXPIRY_ACCOUNT, expiresAt.toString());
}
/**
 * Store Google OAuth refresh token securely in the selected backend.
 */
export async function storeRefreshToken(refreshToken) {
    const backend = await getBackend();
    await backend.set(REFRESH_TOKEN_ACCOUNT, refreshToken);
}
/**
 * Persist one self-hosted server credential in the dedicated OS-keychain namespace.
 *
 * The account key binds both the canonical authority origin and the verified
 * server/CA identity. A credential enrolled for one authority is therefore
 * never considered for another endpoint or trust anchor. Enrollment owns the
 * write; command-line arguments and environment variables are intentionally
 * not credential sources.
 */
export async function storeServerCredential(record) {
    validateServerCredentialBinding(record.origin, record.trustIdentity);
    if (record.credential.length < 43 ||
        record.credential.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(record.credential)) {
        throw new Error('invalid Borg server credential');
    }
    const backend = await getServerCredentialBackend();
    await backend.set(serverCredentialAccount(record.origin, record.trustIdentity), JSON.stringify({ version: SERVER_CREDENTIAL_RECORD_VERSION, ...record }));
}
/** Read an authority-bound self-hosted credential, failing closed on corruption. */
export async function getServerCredential(origin, trustIdentity) {
    const backend = await getServerCredentialBackend();
    const stored = await backend.get(serverCredentialAccount(origin, trustIdentity));
    if (!stored)
        return null;
    try {
        const record = JSON.parse(stored);
        if (record.version !== SERVER_CREDENTIAL_RECORD_VERSION ||
            record.origin !== origin ||
            record.trustIdentity !== trustIdentity ||
            typeof record.credential !== 'string' ||
            record.credential.length < 43 ||
            record.credential.length > 1024 ||
            !/^[A-Za-z0-9_-]+$/.test(record.credential)) {
            return null;
        }
        return record.credential;
    }
    catch {
        return null;
    }
}
export async function clearServerCredential(origin, trustIdentity) {
    const backend = await getServerCredentialBackend();
    await backend.delete(serverCredentialAccount(origin, trustIdentity));
}
/**
 * Write one rotated local drone-session bearer to a generation-specific
 * keychain entry. The returned opaque reference is safe to persist in
 * cubes.json; the bearer itself never leaves the keychain record.
 */
export async function storeServerSessionCredential(record) {
    validateServerSessionBinding(record);
    if (record.credential.length < 43 ||
        record.credential.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(record.credential)) {
        throw new Error('invalid Borg server session credential');
    }
    const credentialRef = serverSessionCredentialAccount(record);
    const backend = await getServerCredentialBackend();
    await backend.set(credentialRef, JSON.stringify({ version: SERVER_SESSION_RECORD_VERSION, ...record }));
    return credentialRef;
}
/** Resolve an opaque local-session reference only when every binding matches. */
export async function getServerSessionCredential(credentialRef, binding) {
    validateServerSessionCredentialRef(credentialRef);
    validateServerSessionBinding(binding);
    if (serverSessionCredentialAccount(binding) !== credentialRef)
        return null;
    const backend = await getServerCredentialBackend();
    const stored = await backend.get(credentialRef);
    if (!stored)
        return null;
    try {
        const record = JSON.parse(stored);
        if (record.version !== SERVER_SESSION_RECORD_VERSION ||
            record.origin !== binding.origin ||
            record.trustIdentity !== binding.trustIdentity ||
            record.cubeId !== binding.cubeId ||
            record.droneId !== binding.droneId ||
            record.generation !== binding.generation ||
            typeof record.credential !== 'string' ||
            record.credential.length < 43 ||
            record.credential.length > 1024 ||
            !/^[A-Za-z0-9_-]+$/.test(record.credential)) {
            return null;
        }
        return record.credential;
    }
    catch {
        return null;
    }
}
export async function clearServerSessionCredential(credentialRef) {
    validateServerSessionCredentialRef(credentialRef);
    const backend = await getServerCredentialBackend();
    await backend.delete(credentialRef);
}
/**
 * Retrieve the Google OAuth ID token.
 *
 * A caller-managed token (BORG_TOKEN / BORG_TOKEN_FILE) takes precedence and
 * is returned verbatim — the caller owns its freshness, so the expiry buffer
 * does not apply. Otherwise reads the persistent backend and returns null if
 * not stored or within the 5-minute expiry buffer.
 */
export async function getIdToken() {
    const callerManaged = await callerManagedIdToken();
    if (callerManaged)
        return callerManaged;
    const backend = await getBackend();
    const token = await backend.get(ID_TOKEN_ACCOUNT);
    const expiryStr = await backend.get(TOKEN_EXPIRY_ACCOUNT);
    if (!token || !expiryStr) {
        return null;
    }
    const expiresAt = parseInt(expiryStr, 10);
    const now = Date.now();
    // Check if token is expired (with 5 minute buffer).
    if (expiresAt - now < 5 * 60 * 1000) {
        return null;
    }
    return token;
}
/**
 * Retrieve the Google OAuth refresh token. There is no refresh_token in
 * caller-managed mode (the externally-supplied id_token has no refresh
 * counterpart), so this returns null whenever a caller-managed token is set.
 */
export async function getRefreshToken() {
    if (await callerManagedIdToken())
        return null;
    const backend = await getBackend();
    return backend.get(REFRESH_TOKEN_ACCOUNT);
}
/**
 * Clear all stored tokens from the selected backend. Idempotent — clearing
 * an already-empty store is a no-op. Does not touch caller-managed env vars
 * (those are the caller's to manage).
 */
export async function clearTokens() {
    const backend = await getBackend();
    await backend.delete(ID_TOKEN_ACCOUNT);
    await backend.delete(REFRESH_TOKEN_ACCOUNT);
    await backend.delete(TOKEN_EXPIRY_ACCOUNT);
}
/**
 * Check if user has valid authentication.
 */
export async function isAuthenticated() {
    const token = await getIdToken();
    return token !== null;
}
//# sourceMappingURL=config.js.map