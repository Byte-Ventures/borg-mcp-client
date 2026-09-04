/**
 * Secure local-server credential storage.
 *
 * Parent enrollment credentials and pending enrollment/cube-creation records
 * rest ONLY in the canonical 0600 credential file. Per-seat session credentials
 * remain in the separate seat store. A single flock serializes every parent-store
 * read-compare-write shared by client enrollment and same-machine server setup.
 */
import { createHash, randomBytes, randomUUID } from 'crypto';
import { withStoreLock } from './seat-store.js';
import { makeFileBackend, } from './token-store.js';
import { BORG_USER_ROOT, SERVER_CREDENTIALS_FILE } from './credential-paths.js';
import { withEnrollmentOriginLock } from './enrollment-lock.js';
import { InvitationArtifactRecoveryError, MISKEYED_RECOVERY_ERROR, } from './invitation-artifact.js';
const SERVER_CREDENTIAL_RECORD_VERSION = 2;
const SERVER_PENDING_ENROLLMENT_RECORD_VERSION = 3;
const LEGACY_SERVER_PENDING_ENROLLMENT_RECORD_VERSION = 1;
const SERVER_ACCEPTED_ENROLLMENT_MARKER_VERSION = 1;
const SERVER_CUBE_RETRY_RECORD_VERSION = 3;
const LEGACY_SERVER_CUBE_RETRY_RECORD_VERSION = 2;
// The 0600 credential store (Queen rescope: replaces the OS keychain). A single
// file holds every parent credential/enrollment record; a single flock
// serializes every mutator + observer that must (SR-seven #4).
const CREDENTIALS_FILE = SERVER_CREDENTIALS_FILE;
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
function serverAcceptedEnrollmentAccount(origin) {
    const binding = createHash('sha256').update(origin).digest('hex');
    return `borg-server-enrollment-accepted:${binding}`;
}
function serverEnrollmentRollbackAccount(origin, retryKey) {
    const binding = createHash('sha256').update(origin).update('\0').update(retryKey).digest('hex');
    return `borg-server-enrollment-rollback:${binding}`;
}
function digestAccountSnapshot(accounts, origin) {
    const selected = Object.entries(accounts)
        .filter(([, value]) => {
        try {
            const parsed = JSON.parse(value);
            return parsed.version === SERVER_CREDENTIAL_RECORD_VERSION && parsed.origin === origin;
        }
        catch {
            return false;
        }
    })
        .sort(([left], [right]) => left.localeCompare(right));
    return createHash('sha256').update(JSON.stringify(selected)).digest('hex');
}
function validateArtifactBinding(binding) {
    if (binding === undefined)
        return;
    validateServerCredentialBinding(binding.endpoint, binding.trustIdentity);
    if (!Number.isSafeInteger(binding.artifactFormatVersion) || binding.artifactFormatVersion < 1 ||
        !/^[a-f0-9]{64}$/.test(binding.artifactDigest) ||
        !/^[a-f0-9]{64}$/.test(binding.caSpkiSha256) ||
        !/^[a-f0-9]{64}$/.test(binding.stagedGenerationId) ||
        binding.endpoint.length < 1 ||
        binding.expectedAuthority !== 'owner' && binding.expectedAuthority !== 'client')
        throw new Error('invalid Borg enrollment artifact binding');
}
function validateReplacementCapability(capability) {
    if (capability === undefined)
        return;
    validateUuid(capability.token, 'replacement capability');
    validateServerCredentialBinding(capability.endpoint, capability.trustIdentity);
    if (!/^[a-f0-9]{64}$/.test(capability.priorAccountsDigest) ||
        !/^[a-f0-9]{64}$/.test(capability.caSpkiSha256) ||
        !/^[a-f0-9]{64}$/.test(capability.artifactDigest))
        throw new Error('invalid Borg enrollment replacement capability');
    validateUuid(capability.retryKey, 'enrollment retry key');
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
let testBackendInjected = false;
let testLockTail = Promise.resolve();
async function withCredentialStoreLock(operation) {
    if (!testBackendInjected) {
        return withStoreLock(CREDENTIALS_LOCK, operation, {
            secureRoot: BORG_USER_ROOT,
            rootMode: 'owner-controlled',
        });
    }
    const prior = testLockTail;
    let release;
    testLockTail = new Promise((resolveLock) => { release = resolveLock; });
    await prior;
    try {
        return await operation();
    }
    finally {
        release();
    }
}
async function getServerCredentialBackend() {
    if (!serverCredentialBackendPromise) {
        serverCredentialBackendPromise = Promise.resolve(makeFileBackend(CREDENTIALS_FILE, {
            secureRoot: BORG_USER_ROOT,
            rootMode: 'owner-controlled',
        }));
    }
    return serverCredentialBackendPromise;
}
/** Test-only credential-store backend injection. */
export function __setServerCredentialBackendForTest(backend) {
    testBackendInjected = backend !== null;
    testLockTail = Promise.resolve();
    serverCredentialBackendPromise = backend ? Promise.resolve(backend) : null;
}
/**
 * CR3b: the UNLOCKED credential write body. Validates then set()s the account.
 * Callers that ALREADY hold the credential-store lock (activatePendingServerEnrollment)
 * invoke this directly so they do not re-acquire (and self-deadlock on) the single
 * store lock; the public storeServerCredential wraps it in one lock hold.
 */
async function writeServerCredentialRecord(backend, record, allowReplacement = false) {
    validateServerCredentialBinding(record.origin, record.trustIdentity);
    validateEnrollmentCredential(record.credential);
    if (record.clientId !== undefined && record.clientId !== null) {
        validateUuid(record.clientId, 'client identity');
    }
    const serverCapabilities = validateServerCapabilities(record.serverCapabilities ?? []);
    const targetAccount = serverCredentialAccount(record.origin, record.trustIdentity);
    const exactExisting = await backend.get(targetAccount);
    if (exactExisting !== null && !allowReplacement) {
        throw new Error('local Borg server enrollment already exists for this origin and replacement was not confirmed');
    }
    if (backend.entries) {
        const accounts = await backend.entries();
        const conflicts = Object.entries(accounts).filter(([, value]) => {
            try {
                const parsed = JSON.parse(value);
                return parsed.version === SERVER_CREDENTIAL_RECORD_VERSION && parsed.origin === record.origin;
            }
            catch {
                return false;
            }
        });
        if (conflicts.length > 0 && !allowReplacement) {
            throw new Error('local Borg server enrollment already exists for this origin and replacement was not confirmed');
        }
        if (allowReplacement && conflicts.length > 0) {
            const target = targetAccount;
            const value = JSON.stringify({
                version: SERVER_CREDENTIAL_RECORD_VERSION,
                origin: record.origin,
                trustIdentity: record.trustIdentity,
                credential: record.credential,
                clientId: record.clientId ?? null,
                serverCapabilities,
            });
            if (backend.replaceAccounts) {
                const next = { ...accounts };
                for (const [account] of conflicts)
                    delete next[account];
                next[target] = value;
                await backend.replaceAccounts(next);
                return;
            }
            // Set first so an injected write failure cannot remove the prior record.
            await backend.set(target, value);
            for (const [account] of conflicts) {
                if (account !== target)
                    await backend.delete(account);
            }
            return;
        }
    }
    await backend.set(serverCredentialAccount(record.origin, record.trustIdentity), JSON.stringify({
        version: SERVER_CREDENTIAL_RECORD_VERSION,
        origin: record.origin,
        trustIdentity: record.trustIdentity,
        credential: record.credential,
        clientId: record.clientId ?? null,
        serverCapabilities,
    }));
}
function encodeServerCredentialRecord(record, serverCapabilities) {
    return JSON.stringify({
        version: SERVER_CREDENTIAL_RECORD_VERSION,
        origin: record.origin,
        trustIdentity: record.trustIdentity,
        credential: record.credential,
        clientId: record.clientId ?? null,
        serverCapabilities,
    });
}
function decodeActiveServerCredentialRecord(stored, origin, trustIdentity) {
    const record = JSON.parse(stored);
    if (record.version !== SERVER_CREDENTIAL_RECORD_VERSION ||
        record.origin !== origin ||
        record.trustIdentity !== trustIdentity ||
        typeof record.credential !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(record.credential) ||
        (record.clientId !== null &&
            (typeof record.clientId !== 'string' || !UUID_RE.test(record.clientId))) ||
        !Array.isArray(record.serverCapabilities))
        throw new Error('invalid Borg server credential record');
    const serverCapabilities = validateServerCapabilities(record.serverCapabilities);
    return {
        origin,
        trustIdentity,
        credential: record.credential,
        clientId: record.clientId,
        serverCapabilities,
    };
}
function decodeAcceptedEnrollmentMarker(value) {
    const marker = JSON.parse(value);
    if (marker.version !== SERVER_ACCEPTED_ENROLLMENT_MARKER_VERSION ||
        marker.state !== 'accepted' ||
        typeof marker.origin !== 'string' ||
        typeof marker.trustIdentity !== 'string' ||
        typeof marker.generationId !== 'string' || !/^[a-f0-9]{64}$/.test(marker.generationId) ||
        (marker.previousPointer !== null && typeof marker.previousPointer !== 'object') ||
        typeof marker.activeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(marker.activeDigest) ||
        typeof marker.rollbackAccount !== 'string' ||
        typeof marker.rollbackDigest !== 'string' || !/^[a-f0-9]{64}$/.test(marker.rollbackDigest))
        throw new Error('invalid Borg enrollment recovery marker');
    validateServerCredentialBinding(marker.origin, marker.trustIdentity);
    if (marker.previousPointer !== null) {
        const pointer = marker.previousPointer;
        if (pointer.version !== 1 || pointer.origin !== marker.origin ||
            typeof pointer.generationId !== 'string' || !/^[a-f0-9]{64}$/.test(pointer.generationId) ||
            typeof pointer.trustIdentity !== 'string')
            throw new Error('invalid Borg enrollment recovery marker');
        validateServerCredentialBinding(pointer.origin, pointer.trustIdentity);
    }
    return marker;
}
function decodeRollbackRecord(value, marker) {
    if (createHash('sha256').update(value).digest('hex') !== marker.rollbackDigest) {
        throw new Error('Borg enrollment rollback snapshot digest is invalid');
    }
    const record = JSON.parse(value);
    if (record.version !== 1 || record.state !== 'rollback-snapshot' || record.origin !== marker.origin ||
        typeof record.snapshot !== 'object' || record.snapshot === null ||
        typeof record.snapshot.pendingAccount !== 'string' ||
        typeof record.snapshot.pendingValue !== 'string' ||
        typeof record.snapshot.activeAccounts !== 'object' || record.snapshot.activeAccounts === null)
        throw new Error('invalid Borg enrollment rollback snapshot');
    for (const [account, stored] of Object.entries(record.snapshot.activeAccounts)) {
        if (typeof account !== 'string' || typeof stored !== 'string') {
            throw new Error('invalid Borg enrollment rollback snapshot');
        }
        let active;
        try {
            active = JSON.parse(stored);
        }
        catch {
            throw new Error('invalid Borg enrollment rollback snapshot');
        }
        if (active.version !== SERVER_CREDENTIAL_RECORD_VERSION || active.origin !== marker.origin ||
            typeof active.trustIdentity !== 'string' ||
            account !== serverCredentialAccount(marker.origin, active.trustIdentity))
            throw new Error('invalid Borg enrollment rollback snapshot');
    }
    let pendingRaw;
    try {
        pendingRaw = JSON.parse(record.snapshot.pendingValue);
    }
    catch {
        throw new Error('invalid Borg enrollment rollback snapshot');
    }
    if (typeof pendingRaw.origin !== 'string' || typeof pendingRaw.trustIdentity !== 'string') {
        throw new Error('invalid Borg enrollment rollback snapshot');
    }
    const pending = decodePendingServerEnrollment(record.snapshot.pendingValue, pendingRaw.origin, pendingRaw.trustIdentity);
    if (pending.origin !== marker.origin || pending.trustIdentity !== marker.trustIdentity ||
        record.snapshot.pendingAccount !== serverPendingEnrollmentAccount(marker.origin, marker.trustIdentity) ||
        marker.rollbackAccount !== serverEnrollmentRollbackAccount(marker.origin, pending.retryKey))
        throw new Error('invalid Borg enrollment rollback snapshot');
    return record;
}
async function markerForOriginUnlocked(backend, origin) {
    const stored = await backend.get(serverAcceptedEnrollmentAccount(origin));
    if (!stored)
        return null;
    return decodeAcceptedEnrollmentMarker(stored);
}
function processSharedEnrollmentLock() {
    return !testBackendInjected;
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
    await withEnrollmentOriginLock(record.origin, () => withCredentialStoreLock(() => writeServerCredentialRecord(backend, record, false)), {
        processShared: processSharedEnrollmentLock(),
    });
}
/** Read an authority-bound active client record, failing closed on corruption. */
export async function getServerCredentialRecord(origin, trustIdentity) {
    const backend = await getServerCredentialBackend();
    return withEnrollmentOriginLock(origin, () => withCredentialStoreLock(async () => {
        if (await markerForOriginUnlocked(backend, origin))
            throw new InvitationArtifactRecoveryError();
        const stored = await backend.get(serverCredentialAccount(origin, trustIdentity));
        if (!stored)
            return null;
        try {
            return decodeActiveServerCredentialRecord(stored, origin, trustIdentity);
        }
        catch {
            return null;
        }
    }), { processShared: processSharedEnrollmentLock() });
}
/** Read only the bearer for existing call sites that do not need capability metadata. */
export async function getServerCredential(origin, trustIdentity) {
    return (await getServerCredentialRecord(origin, trustIdentity))?.credential ?? null;
}
export async function hasServerCredentialForOrigin(origin) {
    const backend = await getServerCredentialBackend();
    if (!backend.entries)
        return false;
    return withEnrollmentOriginLock(origin, () => withCredentialStoreLock(async () => {
        if (await markerForOriginUnlocked(backend, origin))
            throw new InvitationArtifactRecoveryError();
        const accounts = await backend.entries();
        return Object.values(accounts).some((value) => {
            try {
                const record = JSON.parse(value);
                return record.version === SERVER_CREDENTIAL_RECORD_VERSION && record.origin === origin;
            }
            catch {
                return false;
            }
        });
    }), { processShared: processSharedEnrollmentLock() });
}
export async function listServerCredentialOrigins(origin) {
    const backend = await getServerCredentialBackend();
    if (!backend.entries)
        return [];
    return withEnrollmentOriginLock(origin, () => withCredentialStoreLock(async () => {
        const accounts = await backend.entries();
        const origins = new Set();
        for (const value of Object.values(accounts)) {
            try {
                const candidate = JSON.parse(value);
                if (typeof candidate.origin !== 'string' || typeof candidate.trustIdentity !== 'string')
                    continue;
                origins.add(decodeActiveServerCredentialRecord(value, candidate.origin, candidate.trustIdentity).origin);
            }
            catch {
                // Ignore unrelated or malformed backend entries.
            }
        }
        return [...origins].sort();
    }), { processShared: processSharedEnrollmentLock() });
}
function decodePendingServerEnrollment(stored, origin, trustIdentity) {
    const record = JSON.parse(stored);
    if (record.version !== SERVER_PENDING_ENROLLMENT_RECORD_VERSION &&
        record.version !== LEGACY_SERVER_PENDING_ENROLLMENT_RECORD_VERSION ||
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
    validateArtifactBinding(record.artifactBinding);
    validateReplacementCapability(record.replacementCapability);
    if (record.artifactBinding && (record.artifactBinding.endpoint !== origin ||
        record.artifactBinding.trustIdentity !== trustIdentity ||
        record.replacementCapability && (record.replacementCapability.endpoint !== origin ||
            record.replacementCapability.trustIdentity !== trustIdentity ||
            record.replacementCapability.retryKey !== record.retryKey ||
            record.replacementCapability.artifactDigest !== record.artifactBinding.artifactDigest ||
            record.replacementCapability.caSpkiSha256 !== record.artifactBinding.caSpkiSha256)))
        throw new Error('invalid');
    return {
        origin,
        trustIdentity,
        invitation: record.invitation,
        retryKey: record.retryKey,
        credential: record.credential,
        ...(record.clientName === undefined ? {} : { clientName: record.clientName }),
        ...(record.artifactBinding === undefined ? {} : { artifactBinding: record.artifactBinding }),
        ...(record.replacementCapability === undefined ? {} : { replacementCapability: record.replacementCapability }),
    };
}
/** Load an exact durable PENDING tuple so a new process can resume it. */
export async function getPendingServerEnrollment(origin, trustIdentity) {
    validateServerCredentialBinding(origin, trustIdentity);
    const backend = await getServerCredentialBackend();
    const account = serverPendingEnrollmentAccount(origin, trustIdentity);
    return withEnrollmentOriginLock(origin, () => withCredentialStoreLock(async () => {
        if (await markerForOriginUnlocked(backend, origin))
            throw new InvitationArtifactRecoveryError();
        const stored = await backend.get(account);
        if (!stored)
            return null;
        try {
            return decodePendingServerEnrollment(stored, origin, trustIdentity);
        }
        catch {
            throw new Error('pending Borg server enrollment is corrupt');
        }
    }), { processShared: processSharedEnrollmentLock() });
}
/** Find the sole pending enrollment so artifact-only retries need no invitation. */
export async function findPendingServerEnrollment() {
    const backend = await getServerCredentialBackend();
    if (!backend.entries)
        return null;
    return withCredentialStoreLock(async () => {
        const matches = [];
        for (const [account, value] of Object.entries(await backend.entries())) {
            try {
                const raw = JSON.parse(value);
                if (raw.version === SERVER_ACCEPTED_ENROLLMENT_MARKER_VERSION && raw.state === 'accepted') {
                    const marker = decodeAcceptedEnrollmentMarker(value);
                    if (account !== serverAcceptedEnrollmentAccount(marker.origin)) {
                        throw new InvitationArtifactRecoveryError(MISKEYED_RECOVERY_ERROR);
                    }
                    throw new InvitationArtifactRecoveryError();
                }
                if (raw.version !== SERVER_PENDING_ENROLLMENT_RECORD_VERSION &&
                    raw.version !== LEGACY_SERVER_PENDING_ENROLLMENT_RECORD_VERSION ||
                    raw.state !== 'pending')
                    continue;
                if (typeof raw.origin !== 'string' || typeof raw.trustIdentity !== 'string')
                    continue;
                if (account !== serverPendingEnrollmentAccount(raw.origin, raw.trustIdentity)) {
                    throw new InvitationArtifactRecoveryError(MISKEYED_RECOVERY_ERROR);
                }
                matches.push(decodePendingServerEnrollment(value, raw.origin, raw.trustIdentity));
            }
            catch (error) {
                if (error instanceof InvitationArtifactRecoveryError)
                    throw error;
                if (account.startsWith('borg-server-enrollment-pending:') ||
                    account.startsWith('borg-server-enrollment-accepted:'))
                    throw new InvitationArtifactRecoveryError();
                // Ignore unrelated or corrupt records; the keyed resume path remains fail-closed.
            }
        }
        if (matches.length > 1)
            throw new Error('multiple pending Borg server enrollments require an explicit server endpoint');
        return matches[0] ?? null;
    });
}
/**
 * Generate and persist an exact enrollment tuple before network I/O. A
 * pre-existing PENDING tuple must match the invitation and presentation name;
 * this makes response-loss retries exact without minting a second bearer.
 */
export async function getOrCreatePendingServerEnrollment(input) {
    return getOrCreatePendingServerEnrollmentInternal(input, false);
}
/**
 * Mint replacement consent only for the fresh interactive confirmation path.
 * Resume can load and consume the resulting capability, but has no mint API.
 */
export async function createPendingServerEnrollmentWithReplacementConsent(input) {
    return getOrCreatePendingServerEnrollmentInternal(input, true);
}
async function getOrCreatePendingServerEnrollmentInternal(input, mintReplacementConsent) {
    validateServerCredentialBinding(input.origin, input.trustIdentity);
    validateInvitation(input.invitation);
    validateClientName(input.clientName);
    validateArtifactBinding(input.artifactBinding);
    if (input.artifactBinding !== undefined &&
        createHash('sha256').update(input.invitation).digest('hex') !== input.artifactBinding.artifactDigest)
        throw new Error('enrollment invitation does not match its verified artifact binding');
    if (mintReplacementConsent && input.artifactBinding === undefined) {
        throw new Error('replacement consent requires a verified invitation artifact binding');
    }
    const backend = await getServerCredentialBackend();
    const account = serverPendingEnrollmentAccount(input.origin, input.trustIdentity);
    return withEnrollmentOriginLock(input.origin, () => withCredentialStoreLock(async () => {
        const stored = await backend.get(account);
        if (stored) {
            try {
                const record = decodePendingServerEnrollment(stored, input.origin, input.trustIdentity);
                if (record.invitation !== input.invitation ||
                    record.clientName !== input.clientName
                    || JSON.stringify(record.artifactBinding) !== JSON.stringify(input.artifactBinding)
                    || mintReplacementConsent && record.replacementCapability === undefined) {
                    throw new Error('mismatch');
                }
                return record;
            }
            catch {
                throw new Error('pending Borg server enrollment does not match this request');
            }
        }
        const retryKey = randomUUID();
        const accounts = backend.entries ? await backend.entries() : {};
        const replacementCapability = mintReplacementConsent ? {
            token: randomUUID(),
            priorAccountsDigest: digestAccountSnapshot(accounts, input.origin),
            endpoint: input.origin,
            caSpkiSha256: input.artifactBinding.caSpkiSha256,
            trustIdentity: input.trustIdentity,
            retryKey,
            artifactDigest: input.artifactBinding.artifactDigest,
        } : undefined;
        const record = {
            origin: input.origin,
            trustIdentity: input.trustIdentity,
            invitation: input.invitation,
            retryKey,
            credential: randomBytes(32).toString('base64url'),
            ...(input.clientName === undefined ? {} : { clientName: input.clientName }),
            ...(input.artifactBinding === undefined ? {} : { artifactBinding: input.artifactBinding }),
            ...(replacementCapability === undefined ? {} : { replacementCapability }),
        };
        validateEnrollmentCredential(record.credential);
        await backend.set(account, JSON.stringify({
            version: SERVER_PENDING_ENROLLMENT_RECORD_VERSION,
            state: 'pending',
            ...record,
        }));
        return record;
    }), { processShared: processSharedEnrollmentLock() });
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
    await withEnrollmentOriginLock(input.origin, () => withCredentialStoreLock(async () => {
        if (!backend.entries || !backend.replaceAccounts) {
            throw new Error('Borg credential store does not support atomic enrollment activation');
        }
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
        const pending = decodePendingServerEnrollment(stored, input.origin, input.trustIdentity);
        const accounts = await backend.entries();
        const activeAccounts = Object.fromEntries(Object.entries(accounts).filter(([, value]) => {
            try {
                const record = JSON.parse(value);
                return record.version === SERVER_CREDENTIAL_RECORD_VERSION && record.origin === input.origin;
            }
            catch {
                return false;
            }
        }));
        if (Object.keys(activeAccounts).length > 0) {
            const capability = pending.replacementCapability;
            if (!capability || capability.token !== input.replacementCapabilityToken) {
                throw new Error('local Borg server enrollment already exists and replacement consent is missing');
            }
            validateReplacementCapability(capability);
            if (capability.priorAccountsDigest !== digestAccountSnapshot(accounts, input.origin) ||
                capability.endpoint !== input.origin ||
                capability.trustIdentity !== input.trustIdentity ||
                capability.retryKey !== input.retryKey ||
                capability.artifactDigest !== pending.artifactBinding?.artifactDigest ||
                capability.caSpkiSha256 !== pending.artifactBinding?.caSpkiSha256)
                throw new Error('Borg enrollment replacement consent does not match this transaction');
        }
        else if (input.replacementCapabilityToken !== undefined) {
            throw new Error('Borg enrollment replacement consent does not match this transaction');
        }
        const generationId = input.generationId ?? pending.artifactBinding?.stagedGenerationId;
        if (pending.artifactBinding && generationId !== pending.artifactBinding.stagedGenerationId) {
            throw new Error('pending Borg server enrollment generation does not match the verified response');
        }
        const activeRecord = {
            origin: input.origin,
            trustIdentity: input.trustIdentity,
            credential: input.credential,
            clientId: input.clientId,
            serverCapabilities,
        };
        const target = serverCredentialAccount(input.origin, input.trustIdentity);
        const next = { ...accounts };
        for (const [account, value] of Object.entries(accounts)) {
            try {
                const parsed = JSON.parse(value);
                if (parsed.version === SERVER_CREDENTIAL_RECORD_VERSION && parsed.origin === input.origin) {
                    delete next[account];
                }
            }
            catch {
                // Preserve unrelated malformed records; the backend's normal validation remains fail-closed.
            }
        }
        const activeValue = encodeServerCredentialRecord(activeRecord, serverCapabilities);
        next[target] = activeValue;
        delete next[pendingAccount];
        if (generationId !== undefined) {
            const rollbackAccount = serverEnrollmentRollbackAccount(input.origin, input.retryKey);
            const rollbackRecord = {
                version: 1,
                state: 'rollback-snapshot',
                origin: input.origin,
                snapshot: { activeAccounts, pendingAccount, pendingValue: stored },
            };
            const rollbackValue = JSON.stringify(rollbackRecord);
            const marker = {
                version: SERVER_ACCEPTED_ENROLLMENT_MARKER_VERSION,
                state: 'accepted',
                origin: input.origin,
                trustIdentity: input.trustIdentity,
                generationId,
                previousPointer: input.previousPointer ?? null,
                activeDigest: createHash('sha256').update(activeValue).digest('hex'),
                rollbackAccount,
                rollbackDigest: createHash('sha256').update(rollbackValue).digest('hex'),
            };
            next[rollbackAccount] = rollbackValue;
            next[serverAcceptedEnrollmentAccount(input.origin)] = JSON.stringify(marker);
        }
        await backend.replaceAccounts(next);
    }), { processShared: processSharedEnrollmentLock() });
}
export async function getAcceptedEnrollmentMarker(origin) {
    const backend = await getServerCredentialBackend();
    return withEnrollmentOriginLock(origin, () => withCredentialStoreLock(() => markerForOriginUnlocked(backend, origin)), { processShared: processSharedEnrollmentLock() });
}
/** Remove the gate only after the pointer and active account have been verified together. */
export async function finalizeAcceptedEnrollment(origin, trustIdentity, generationId) {
    const backend = await getServerCredentialBackend();
    await withEnrollmentOriginLock(origin, () => withCredentialStoreLock(async () => {
        if (!backend.entries || !backend.replaceAccounts) {
            throw new Error('Borg credential store does not support atomic enrollment finalization');
        }
        const accounts = await backend.entries();
        const markerValue = accounts[serverAcceptedEnrollmentAccount(origin)];
        if (!markerValue)
            return;
        const marker = decodeAcceptedEnrollmentMarker(markerValue);
        if (marker.trustIdentity !== trustIdentity || marker.generationId !== generationId) {
            throw new Error('Borg enrollment recovery marker does not match committed trust');
        }
        const active = accounts[serverCredentialAccount(origin, trustIdentity)];
        if (!active)
            throw new Error('Borg enrollment recovery marker has no matching active credential');
        if (createHash('sha256').update(active).digest('hex') !== marker.activeDigest) {
            throw new Error('Borg enrollment recovery marker active credential does not match the committed transaction');
        }
        try {
            decodeActiveServerCredentialRecord(active, origin, trustIdentity);
        }
        catch {
            throw new Error('Borg enrollment recovery marker active credential is invalid');
        }
        const next = { ...accounts };
        delete next[serverAcceptedEnrollmentAccount(origin)];
        delete next[marker.rollbackAccount];
        await backend.replaceAccounts(next);
    }), { processShared: processSharedEnrollmentLock() });
}
/** Restore the complete pre-commit account snapshot after pointer restoration. */
export async function restoreAcceptedEnrollmentAccounts(marker) {
    const backend = await getServerCredentialBackend();
    await withEnrollmentOriginLock(marker.origin, () => withCredentialStoreLock(async () => {
        if (!backend.entries || !backend.replaceAccounts) {
            throw new Error('Borg credential store does not support atomic enrollment rollback');
        }
        const accounts = await backend.entries();
        const current = accounts[serverAcceptedEnrollmentAccount(marker.origin)];
        if (!current || JSON.stringify(decodeAcceptedEnrollmentMarker(current)) !== JSON.stringify(marker)) {
            throw new Error('Borg enrollment recovery marker changed during rollback');
        }
        const rollbackValue = accounts[marker.rollbackAccount];
        if (!rollbackValue)
            throw new Error('Borg enrollment rollback snapshot is missing');
        const rollback = decodeRollbackRecord(rollbackValue, marker).snapshot;
        const next = { ...accounts };
        for (const [account, value] of Object.entries(accounts)) {
            try {
                const parsed = JSON.parse(value);
                if (parsed.version === SERVER_CREDENTIAL_RECORD_VERSION && parsed.origin === marker.origin) {
                    delete next[account];
                }
            }
            catch {
                // Preserve unrelated malformed entries for the backend's fail-closed reader.
            }
        }
        Object.assign(next, rollback.activeAccounts);
        next[rollback.pendingAccount] = rollback.pendingValue;
        delete next[serverAcceptedEnrollmentAccount(marker.origin)];
        delete next[marker.rollbackAccount];
        await backend.replaceAccounts(next);
    }), { processShared: processSharedEnrollmentLock() });
}
export async function findEnrollmentRecoveryTransaction(selectedOrigin) {
    if (selectedOrigin !== undefined) {
        let parsed;
        try {
            parsed = new URL(selectedOrigin);
        }
        catch {
            throw new Error('invalid Borg server credential origin');
        }
        if (parsed.origin !== selectedOrigin || parsed.protocol !== 'https:') {
            throw new Error('Borg server credentials require a canonical HTTPS origin');
        }
    }
    const backend = await getServerCredentialBackend();
    if (!backend.entries)
        return null;
    return withCredentialStoreLock(async () => {
        const accepted = [];
        const pending = [];
        for (const [account, value] of Object.entries(await backend.entries())) {
            try {
                const raw = JSON.parse(value);
                if (raw.version === SERVER_ACCEPTED_ENROLLMENT_MARKER_VERSION && raw.state === 'accepted') {
                    const marker = decodeAcceptedEnrollmentMarker(value);
                    if (account !== serverAcceptedEnrollmentAccount(marker.origin)) {
                        throw new InvitationArtifactRecoveryError(MISKEYED_RECOVERY_ERROR);
                    }
                    if (selectedOrigin === undefined || marker.origin === selectedOrigin)
                        accepted.push(marker);
                }
                else if ((raw.version === SERVER_PENDING_ENROLLMENT_RECORD_VERSION ||
                    raw.version === LEGACY_SERVER_PENDING_ENROLLMENT_RECORD_VERSION) &&
                    raw.state === 'pending' &&
                    typeof raw.origin === 'string' && typeof raw.trustIdentity === 'string') {
                    const record = decodePendingServerEnrollment(value, raw.origin, raw.trustIdentity);
                    if (account !== serverPendingEnrollmentAccount(raw.origin, raw.trustIdentity)) {
                        throw new InvitationArtifactRecoveryError(MISKEYED_RECOVERY_ERROR);
                    }
                    if (selectedOrigin === undefined || record.origin === selectedOrigin)
                        pending.push(record);
                }
            }
            catch (error) {
                if (error instanceof InvitationArtifactRecoveryError)
                    throw error;
                if (account.startsWith('borg-server-enrollment-accepted:') ||
                    account.startsWith('borg-server-enrollment-pending:') ||
                    account.startsWith('borg-server-enrollment-rollback:'))
                    throw new InvitationArtifactRecoveryError();
                // Unrelated corrupt entries are preserved for their owning reader.
            }
        }
        if (accepted.length + pending.length > 1) {
            throw new Error('multiple Borg enrollment transactions require an explicit server endpoint');
        }
        if (accepted[0])
            return { kind: 'accepted', marker: accepted[0] };
        if (pending[0])
            return { kind: 'pending', pending: pending[0] };
        return null;
    });
}
/** Delete only the exact definitively rejected pending attempt. */
export async function clearPendingServerEnrollment(origin, trustIdentity, retryKey) {
    validateUuid(retryKey, 'enrollment retry key');
    const backend = await getServerCredentialBackend();
    const account = serverPendingEnrollmentAccount(origin, trustIdentity);
    await withEnrollmentOriginLock(origin, () => withCredentialStoreLock(async () => {
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
    }), { processShared: processSharedEnrollmentLock() });
}
/** Persist one repository-scoped cube-create idempotency key in the 0600 credential store. */
export async function getOrCreatePendingServerCubeCreation(input) {
    validateServerCredentialBinding(input.origin, input.trustIdentity);
    validateUuid(input.clientId, 'client identity');
    if ((input.repository.kind !== 'origin' && input.repository.kind !== 'local') ||
        typeof input.repository.value !== 'string' || input.repository.value.length < 1) {
        throw new Error('invalid Borg server repository binding');
    }
    if (Buffer.byteLength(input.name, 'utf8') < 1 || Buffer.byteLength(input.name, 'utf8') > 120 ||
        !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(input.name)) {
        throw new Error('invalid Borg server cube name');
    }
    const repositoryBinding = createHash('sha256')
        .update(input.repository.kind)
        .update('\0')
        .update(input.repository.value)
        .digest('hex');
    const backend = await getServerCredentialBackend();
    const account = serverCubeRetryAccount(input.origin, input.trustIdentity, input.clientId, repositoryBinding);
    return withCredentialStoreLock(async () => {
        const stored = await backend.get(account);
        if (stored) {
            let record;
            try {
                const parsed = JSON.parse(stored);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                    throw new Error('invalid record');
                record = parsed;
            }
            catch {
                throw new Error('pending Borg server cube creation does not match this repository');
            }
            const retryKey = typeof record.retryKey === 'string' && UUID_RE.test(record.retryKey)
                ? record.retryKey
                : null;
            const sameOperation = record.state === 'pending' &&
                record.origin === input.origin &&
                record.trustIdentity === input.trustIdentity &&
                record.clientId === input.clientId &&
                record.repositoryBinding === repositoryBinding &&
                record.name === input.name &&
                record.workingRepoName === input.workingRepoName &&
                retryKey !== null;
            if (sameOperation && record.version === SERVER_CUBE_RETRY_RECORD_VERSION && record.template === input.template) {
                return {
                    origin: input.origin,
                    trustIdentity: input.trustIdentity,
                    clientId: input.clientId,
                    repositoryBinding,
                    retryKey,
                    name: input.name,
                    workingRepoName: input.workingRepoName,
                    repository: input.repository,
                    template: input.template,
                };
            }
            if (sameOperation && record.version === LEGACY_SERVER_CUBE_RETRY_RECORD_VERSION) {
                const preserveRetryKey = record.template === input.template;
                if (!preserveRetryKey && record.template !== 'default') {
                    throw new Error('pending Borg server cube creation does not match this repository');
                }
                const replacement = {
                    origin: input.origin,
                    trustIdentity: input.trustIdentity,
                    clientId: input.clientId,
                    repositoryBinding,
                    retryKey: preserveRetryKey ? retryKey : randomUUID(),
                    name: input.name,
                    workingRepoName: input.workingRepoName,
                    repository: input.repository,
                    template: input.template,
                };
                await backend.set(account, JSON.stringify({
                    version: SERVER_CUBE_RETRY_RECORD_VERSION,
                    state: 'pending',
                    origin: replacement.origin,
                    trustIdentity: replacement.trustIdentity,
                    clientId: replacement.clientId,
                    repositoryBinding: replacement.repositoryBinding,
                    retryKey: replacement.retryKey,
                    name: replacement.name,
                    workingRepoName: replacement.workingRepoName,
                    template: replacement.template,
                }));
                return replacement;
            }
            throw new Error('pending Borg server cube creation does not match this repository');
        }
        const record = {
            origin: input.origin,
            trustIdentity: input.trustIdentity,
            clientId: input.clientId,
            repositoryBinding,
            retryKey: randomUUID(),
            name: input.name,
            workingRepoName: input.workingRepoName,
            repository: input.repository,
            template: input.template,
        };
        await backend.set(account, JSON.stringify({
            version: SERVER_CUBE_RETRY_RECORD_VERSION,
            state: 'pending',
            origin: record.origin,
            trustIdentity: record.trustIdentity,
            clientId: record.clientId,
            repositoryBinding: record.repositoryBinding,
            retryKey: record.retryKey,
            name: record.name,
            workingRepoName: record.workingRepoName,
            template: record.template,
        }));
        return record;
    });
}
export async function clearPendingServerCubeCreation(record) {
    const backend = await getServerCredentialBackend();
    const account = serverCubeRetryAccount(record.origin, record.trustIdentity, record.clientId, record.repositoryBinding);
    await withCredentialStoreLock(async () => {
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
    await withEnrollmentOriginLock(origin, () => withCredentialStoreLock(async () => {
        await backend.delete(serverCredentialAccount(origin, trustIdentity));
        await backend.delete(pendingAccount);
    }), { processShared: processSharedEnrollmentLock() });
}
/** Clear only the exact failed enrollment transaction that the operator reviewed. */
export async function clearEnrollmentTransaction(expected) {
    validateServerCredentialBinding(expected.origin, expected.trustIdentity);
    const backend = await getServerCredentialBackend();
    const pendingAccount = serverPendingEnrollmentAccount(expected.origin, expected.trustIdentity);
    return withEnrollmentOriginLock(expected.origin, () => withCredentialStoreLock(async () => {
        if (await markerForOriginUnlocked(backend, expected.origin)) {
            throw new InvitationArtifactRecoveryError();
        }
        if (backend.entries && backend.replaceAccounts) {
            const accounts = await backend.entries();
            const stored = accounts[pendingAccount];
            if (!stored)
                return false;
            let current;
            try {
                current = decodePendingServerEnrollment(stored, expected.origin, expected.trustIdentity);
            }
            catch {
                return false;
            }
            if (JSON.stringify(current) !== JSON.stringify(expected))
                return false;
            const next = { ...accounts };
            delete next[pendingAccount];
            await backend.replaceAccounts(next);
            return (await backend.get(pendingAccount)) === null;
        }
        const stored = await backend.get(pendingAccount);
        if (!stored)
            return false;
        let current;
        try {
            current = decodePendingServerEnrollment(stored, expected.origin, expected.trustIdentity);
        }
        catch {
            return false;
        }
        if (JSON.stringify(current) !== JSON.stringify(expected))
            return false;
        await backend.delete(pendingAccount);
        return (await backend.get(pendingAccount)) === null;
    }), { processShared: processSharedEnrollmentLock() });
}
//# sourceMappingURL=config.js.map