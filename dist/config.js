/**
 * Secure local-server credential storage.
 *
 * The self-hosted-server credential group (enrollment credentials, pending
 * enrollment/cube-creation records, and the per-seat drone-session bearers)
 * rests ONLY in the 0600 credential file store (Queen rescope) — parity with the
 * server's own TLS private keys. The OS keychain is gone; the raw secret never
 * leaves the 0600 file, and a single store flock serializes every read-compare-write.
 */
import os from 'os';
import path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { withStoreLock } from './seat-store.js';
import { makeFileBackend, } from './token-store.js';
const SERVER_CREDENTIAL_RECORD_VERSION = 2;
const SERVER_PENDING_ENROLLMENT_RECORD_VERSION = 1;
const SERVER_CUBE_RETRY_RECORD_VERSION = 1;
// The 0600 credential store (Queen rescope: replaces the OS keychain). A single
// file holds every server credential/session/enrollment record; a single flock
// serializes every mutator + observer that must (SR-seven #4).
const CREDENTIALS_FILE = path.join(os.homedir(), '.config', 'borgmcp', 'credentials.json');
const CREDENTIALS_LOCK = `${CREDENTIALS_FILE}.lock`;
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
// The whole 0600 credential store is serialized by the SINGLE store lock
// (seat-store.withStoreLock over CREDENTIALS_LOCK). Every mutator AND every
// observer that must serialize runs its entire read-compare-write inside one
// continuous hold, released on EVERY path incl throw (SR-seven #4). There is no
// per-account lock and no compat shim — call sites acquire the store lock directly.
function serverPendingEnrollmentAccount(origin, trustIdentity) {
    validateServerCredentialBinding(origin, trustIdentity);
    const binding = createHash('sha256')
        .update(origin)
        .update('\0')
        .update(trustIdentity)
        .digest('hex');
    return `borg-server-enrollment-pending:${binding}`;
}
function validateUuid(value, label) {
    if (!UUID_RE.test(value))
        throw new Error(`invalid Borg server ${label}`);
}
function validateServerCapabilities(value) {
    if (value.length > 1 || value.some((capability) => capability !== 'create_cube')) {
        throw new Error('invalid Borg server capabilities');
    }
    return [...value];
}
function validateClientName(clientName) {
    if (clientName !== undefined &&
        (Buffer.byteLength(clientName, 'utf8') < 1 ||
            Buffer.byteLength(clientName, 'utf8') > 120 ||
            !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(clientName))) {
        throw new Error('invalid Borg server client name');
    }
}
function validateInvitation(invitation) {
    if (invitation.length < 43 ||
        invitation.length > 1024 ||
        !/^[A-Za-z0-9_-]+$/.test(invitation)) {
        throw new Error('invalid Borg server invitation');
    }
}
function validateEnrollmentCredential(credential) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) {
        throw new Error('invalid Borg server credential');
    }
}
function serverCubeRetryAccount(origin, trustIdentity, clientId, repositoryBinding) {
    validateServerCredentialBinding(origin, trustIdentity);
    validateUuid(clientId, 'client identity');
    if (!/^[a-f0-9]{64}$/.test(repositoryBinding)) {
        throw new Error('invalid Borg server repository binding');
    }
    const binding = createHash('sha256')
        .update(origin)
        .update('\0')
        .update(trustIdentity)
        .update('\0')
        .update(clientId)
        .update('\0')
        .update(repositoryBinding)
        .digest('hex');
    return `borg-server-cube-pending:${binding}`;
}
// Local-server bearers rest ONLY in the 0600 credential store (Queen rescope —
// parity with the server's TLS keys; no OS keychain, no obfuscation-grade
// fallback). The single store lock (CREDENTIALS_LOCK) serializes the RCW.
let serverCredentialBackendPromise = null;
async function getServerCredentialBackend() {
    if (!serverCredentialBackendPromise) {
        serverCredentialBackendPromise = Promise.resolve(makeFileBackend(CREDENTIALS_FILE));
    }
    return serverCredentialBackendPromise;
}
/** Test-only credential-store backend injection. */
export function __setServerCredentialBackendForTest(backend) {
    serverCredentialBackendPromise = backend ? Promise.resolve(backend) : null;
}
/**
 * CR3b: the UNLOCKED credential write body. Validates then set()s the account.
 * Callers that ALREADY hold the credential-store lock (activatePendingServerEnrollment)
 * invoke this directly so they do not re-acquire (and self-deadlock on) the single
 * store lock; the public storeServerCredential wraps it in one lock hold.
 */
async function writeServerCredentialRecord(backend, record) {
    validateServerCredentialBinding(record.origin, record.trustIdentity);
    validateEnrollmentCredential(record.credential);
    if (record.clientId !== undefined && record.clientId !== null) {
        validateUuid(record.clientId, 'client identity');
    }
    const serverCapabilities = validateServerCapabilities(record.serverCapabilities ?? []);
    await backend.set(serverCredentialAccount(record.origin, record.trustIdentity), JSON.stringify({
        version: SERVER_CREDENTIAL_RECORD_VERSION,
        origin: record.origin,
        trustIdentity: record.trustIdentity,
        credential: record.credential,
        clientId: record.clientId ?? null,
        serverCapabilities,
    }));
}
/**
 * Persist one self-hosted server credential in the dedicated 0600 credential store.
 *
 * The account key binds both the canonical authority origin and the verified
 * server/CA identity. A credential enrolled for one authority is therefore
 * never considered for another endpoint or trust anchor. Enrollment owns the
 * write; command-line arguments and environment variables are intentionally
 * not credential sources. CR3b: the load→set→rename runs inside ONE hold of the
 * single store lock so a concurrent writer cannot lose an unrelated account.
 */
export async function storeServerCredential(record) {
    const backend = await getServerCredentialBackend();
    await withStoreLock(CREDENTIALS_LOCK, () => writeServerCredentialRecord(backend, record));
}
/** Read an authority-bound active client record, failing closed on corruption. */
export async function getServerCredentialRecord(origin, trustIdentity) {
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
            !/^[A-Za-z0-9_-]{43}$/.test(record.credential) ||
            (record.clientId !== null &&
                (typeof record.clientId !== 'string' || !UUID_RE.test(record.clientId))) ||
            !Array.isArray(record.serverCapabilities)) {
            return null;
        }
        let serverCapabilities;
        try {
            serverCapabilities = validateServerCapabilities(record.serverCapabilities);
        }
        catch {
            return null;
        }
        return {
            origin,
            trustIdentity,
            credential: record.credential,
            clientId: record.clientId,
            serverCapabilities,
        };
    }
    catch {
        return null;
    }
}
/** Read only the bearer for existing call sites that do not need capability metadata. */
export async function getServerCredential(origin, trustIdentity) {
    return (await getServerCredentialRecord(origin, trustIdentity))?.credential ?? null;
}
function decodePendingServerEnrollment(stored, origin, trustIdentity) {
    const record = JSON.parse(stored);
    if (record.version !== SERVER_PENDING_ENROLLMENT_RECORD_VERSION ||
        record.state !== 'pending' ||
        record.origin !== origin ||
        record.trustIdentity !== trustIdentity ||
        typeof record.invitation !== 'string' ||
        typeof record.retryKey !== 'string' || !UUID_RE.test(record.retryKey) ||
        typeof record.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.credential) ||
        (record.clientName !== undefined && typeof record.clientName !== 'string')) {
        throw new Error('invalid');
    }
    validateInvitation(record.invitation);
    validateClientName(record.clientName);
    return {
        origin,
        trustIdentity,
        invitation: record.invitation,
        retryKey: record.retryKey,
        credential: record.credential,
        ...(record.clientName === undefined ? {} : { clientName: record.clientName }),
    };
}
/** Load an exact durable PENDING tuple so a new process can resume it. */
export async function getPendingServerEnrollment(origin, trustIdentity) {
    validateServerCredentialBinding(origin, trustIdentity);
    const backend = await getServerCredentialBackend();
    const account = serverPendingEnrollmentAccount(origin, trustIdentity);
    return withStoreLock(CREDENTIALS_LOCK, async () => {
        const stored = await backend.get(account);
        if (!stored)
            return null;
        try {
            return decodePendingServerEnrollment(stored, origin, trustIdentity);
        }
        catch {
            throw new Error('pending Borg server enrollment is corrupt');
        }
    });
}
/**
 * Generate and persist an exact enrollment tuple before network I/O. A
 * pre-existing PENDING tuple must match the invitation and presentation name;
 * this makes response-loss retries exact without minting a second bearer.
 */
export async function getOrCreatePendingServerEnrollment(input) {
    validateServerCredentialBinding(input.origin, input.trustIdentity);
    validateInvitation(input.invitation);
    validateClientName(input.clientName);
    const backend = await getServerCredentialBackend();
    const account = serverPendingEnrollmentAccount(input.origin, input.trustIdentity);
    return withStoreLock(CREDENTIALS_LOCK, async () => {
        const stored = await backend.get(account);
        if (stored) {
            try {
                const record = decodePendingServerEnrollment(stored, input.origin, input.trustIdentity);
                if (record.invitation !== input.invitation ||
                    record.clientName !== input.clientName) {
                    throw new Error('mismatch');
                }
                return record;
            }
            catch {
                throw new Error('pending Borg server enrollment does not match this request');
            }
        }
        const record = {
            origin: input.origin,
            trustIdentity: input.trustIdentity,
            invitation: input.invitation,
            retryKey: randomUUID(),
            credential: randomBytes(32).toString('base64url'),
            ...(input.clientName === undefined ? {} : { clientName: input.clientName }),
        };
        validateEnrollmentCredential(record.credential);
        await backend.set(account, JSON.stringify({
            version: SERVER_PENDING_ENROLLMENT_RECORD_VERSION,
            state: 'pending',
            ...record,
        }));
        return record;
    });
}
/** Activate the exact pending tuple only after a verified server response. */
export async function activatePendingServerEnrollment(input) {
    validateServerCredentialBinding(input.origin, input.trustIdentity);
    validateUuid(input.retryKey, 'enrollment retry key');
    validateEnrollmentCredential(input.credential);
    validateUuid(input.clientId, 'client identity');
    const serverCapabilities = validateServerCapabilities(input.serverCapabilities);
    const backend = await getServerCredentialBackend();
    const pendingAccount = serverPendingEnrollmentAccount(input.origin, input.trustIdentity);
    await withStoreLock(CREDENTIALS_LOCK, async () => {
        const stored = await backend.get(pendingAccount);
        if (!stored)
            throw new Error('pending Borg server enrollment is missing');
        try {
            const pending = decodePendingServerEnrollment(stored, input.origin, input.trustIdentity);
            if (pending.retryKey !== input.retryKey || pending.credential !== input.credential) {
                throw new Error('mismatch');
            }
        }
        catch {
            throw new Error('pending Borg server enrollment does not match the verified response');
        }
        // Already inside the single store lock — use the UNLOCKED write body so we do
        // not re-acquire (and self-deadlock on) CREDENTIALS_LOCK (CR3b).
        await writeServerCredentialRecord(backend, {
            origin: input.origin,
            trustIdentity: input.trustIdentity,
            credential: input.credential,
            clientId: input.clientId,
            serverCapabilities,
        });
        await backend.delete(pendingAccount);
    });
}
/** Delete only the exact definitively rejected pending attempt. */
export async function clearPendingServerEnrollment(origin, trustIdentity, retryKey) {
    validateUuid(retryKey, 'enrollment retry key');
    const backend = await getServerCredentialBackend();
    const account = serverPendingEnrollmentAccount(origin, trustIdentity);
    await withStoreLock(CREDENTIALS_LOCK, async () => {
        const stored = await backend.get(account);
        if (!stored)
            return;
        try {
            const pending = decodePendingServerEnrollment(stored, origin, trustIdentity);
            if (pending.retryKey !== retryKey)
                return;
        }
        catch {
            return;
        }
        await backend.delete(account);
    });
}
/** Persist one repository-scoped cube-create idempotency key in the 0600 credential store. */
export async function getOrCreatePendingServerCubeCreation(input) {
    validateServerCredentialBinding(input.origin, input.trustIdentity);
    validateUuid(input.clientId, 'client identity');
    if (input.projectRoot.length < 1 || input.projectRoot.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.projectRoot)) {
        throw new Error('invalid Borg server repository binding');
    }
    if (Buffer.byteLength(input.name, 'utf8') < 1 || Buffer.byteLength(input.name, 'utf8') > 120 ||
        !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(input.name)) {
        throw new Error('invalid Borg server cube name');
    }
    const repositoryBinding = createHash('sha256').update(input.projectRoot).digest('hex');
    const backend = await getServerCredentialBackend();
    const account = serverCubeRetryAccount(input.origin, input.trustIdentity, input.clientId, repositoryBinding);
    return withStoreLock(CREDENTIALS_LOCK, async () => {
        const stored = await backend.get(account);
        if (stored) {
            try {
                const record = JSON.parse(stored);
                if (record.version !== SERVER_CUBE_RETRY_RECORD_VERSION ||
                    record.state !== 'pending' ||
                    record.origin !== input.origin ||
                    record.trustIdentity !== input.trustIdentity ||
                    record.clientId !== input.clientId ||
                    record.repositoryBinding !== repositoryBinding ||
                    record.name !== input.name ||
                    record.template !== input.template ||
                    typeof record.retryKey !== 'string' || !UUID_RE.test(record.retryKey)) {
                    throw new Error('mismatch');
                }
                return {
                    origin: input.origin,
                    trustIdentity: input.trustIdentity,
                    clientId: input.clientId,
                    repositoryBinding,
                    retryKey: record.retryKey,
                    name: input.name,
                    template: input.template,
                };
            }
            catch {
                throw new Error('pending Borg server cube creation does not match this repository');
            }
        }
        const record = {
            origin: input.origin,
            trustIdentity: input.trustIdentity,
            clientId: input.clientId,
            repositoryBinding,
            retryKey: randomUUID(),
            name: input.name,
            template: input.template,
        };
        await backend.set(account, JSON.stringify({
            version: SERVER_CUBE_RETRY_RECORD_VERSION,
            state: 'pending',
            ...record,
        }));
        return record;
    });
}
export async function clearPendingServerCubeCreation(record) {
    const backend = await getServerCredentialBackend();
    const account = serverCubeRetryAccount(record.origin, record.trustIdentity, record.clientId, record.repositoryBinding);
    await withStoreLock(CREDENTIALS_LOCK, async () => {
        const stored = await backend.get(account);
        if (!stored)
            return;
        try {
            const pending = JSON.parse(stored);
            if (pending.retryKey !== record.retryKey)
                return;
        }
        catch {
            return;
        }
        await backend.delete(account);
    });
}
export async function clearServerCredential(origin, trustIdentity) {
    const backend = await getServerCredentialBackend();
    const pendingAccount = serverPendingEnrollmentAccount(origin, trustIdentity);
    await withStoreLock(CREDENTIALS_LOCK, async () => {
        await backend.delete(serverCredentialAccount(origin, trustIdentity));
        await backend.delete(pendingAccount);
    });
}
//# sourceMappingURL=config.js.map