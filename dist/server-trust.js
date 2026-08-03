import { Buffer } from 'node:buffer';
import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, open, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { BorgServerTrustError } from './server-errors.js';
import { InvitationArtifactCompatibilityError, InvitationArtifactRecoveryError, InvitationArtifactStorageError, InvitationArtifactTransportError, InvitationArtifactTrustError, } from './invitation-artifact.js';
import { atomicWrite0600 } from './seat-store.js';
import { withEnrollmentOriginLock } from './enrollment-lock.js';
import { finalizeAcceptedEnrollment, getAcceptedEnrollmentMarker, restoreAcceptedEnrollmentAccounts, } from './config.js';
// CR5 TLS LATTICE: OpenSSL/Node TLS certificate-verification error codes. A raw
// CA / cert-chain / SAN failure from the pinned transport is a potential MITM and
// MUST be a TERMINAL trust-mismatch verdict — never a transient 'restart' blip.
// Connection refusal / reset / timeout are NOT in here: those stay raw transport
// errors so the seat probe classifies them as `unreachable` (genuinely transient).
const TLS_TRUST_ERROR_CODES = new Set([
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_UNTRUSTED',
    'CERT_CHAIN_TOO_LONG',
    'HOSTNAME_MISMATCH',
    'ERR_TLS_CERT_ALTNAME_INVALID',
]);
/**
 * True iff `code` is a PINNED-TRANSPORT certificate-verification failure (bad CA,
 * unverifiable chain, self-signed leaf, expired/not-yet-valid cert, or a SAN /
 * hostname mismatch). These are terminal trust-mismatch — a restart never fixes a
 * wrong cert. `CERT_*` covers the OpenSSL verify family (CERT_HAS_EXPIRED,
 * CERT_NOT_YET_VALID, CERT_REVOKED, …); `ERR_TLS_CERT*` covers Node's SAN check.
 */
function isPinnedTransportTrustFailure(code) {
    if (typeof code !== 'string')
        return false;
    return (code.startsWith('CERT_') ||
        code.startsWith('ERR_TLS_CERT') ||
        TLS_TRUST_ERROR_CODES.has(code));
}
const trustCache = new Map();
let enrollmentTrustFaultsForTest = new Set();
function injectEnrollmentTrustFault(point) {
    if (enrollmentTrustFaultsForTest.has(point))
        throw new Error(`injected ${point} failure`);
}
function invalidateOriginTrustCache(origin) {
    for (const key of trustCache.keys()) {
        if (key === origin || key.startsWith(`${origin}\0`) || key.endsWith(`\0${origin}`)) {
            trustCache.delete(key);
        }
    }
}
function serverDataDirectory() {
    return resolve(process.env.BORG_SERVER_DATA_DIR ?? join(homedir(), '.borg', 'server'));
}
function remoteTrustDirectory(origin) {
    const key = createHash('sha256').update(origin).digest('hex');
    return join(homedir(), '.borg', 'server-trust', key);
}
function trustGenerationsDirectory(origin) {
    return join(remoteTrustDirectory(origin), 'generations');
}
function trustGenerationDirectory(origin, generationId) {
    return join(trustGenerationsDirectory(origin), generationId);
}
function trustPointerPath(origin) {
    return join(remoteTrustDirectory(origin), 'current.json');
}
function trustGenerationId(origin, certificate, identity) {
    return createHash('sha256')
        .update(origin).update('\0').update(identity).update('\0').update(certificate)
        .digest('hex');
}
async function trustFilesExist(directory) {
    try {
        await Promise.all([access(join(directory, 'ca.crt')), access(join(directory, 'server.json'))]);
        return true;
    }
    catch {
        return false;
    }
}
async function remoteTrustStateExists(origin) {
    try {
        await access(trustPointerPath(origin));
        return true;
    }
    catch { /* continue */ }
    return trustFilesExist(remoteTrustDirectory(origin));
}
async function readTrustFile(path) {
    let handle;
    try {
        handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if (error.code === 'ENOENT') {
            throw new Error('Borg server trust files were not found');
        }
        throw new Error('Borg server trust files could not be opened safely');
    }
    try {
        const metadata = await handle.stat();
        if (!metadata.isFile() || (metadata.mode & 0o077) !== 0) {
            throw new Error('Borg server trust files must be private regular files');
        }
        if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
            throw new Error('Borg server trust files must be owned by the current user');
        }
        return await handle.readFile('utf8');
    }
    finally {
        await handle.close();
    }
}
async function assertPrivateDirectory(path) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
        throw new Error('Borg server trust directories must be private real directories');
    }
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
        throw new Error('Borg server trust directories must be owned by the current user');
    }
}
async function syncPath(path) {
    const handle = await open(path, 'r');
    try {
        await handle.sync();
    }
    finally {
        await handle.close();
    }
}
function decodeTrustConfig(value) {
    let parsed;
    try {
        parsed = JSON.parse(value);
    }
    catch {
        throw new Error('Borg server trust metadata is invalid');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('Borg server trust metadata is invalid');
    }
    const fingerprint = parsed.ca_spki_sha256;
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/i.test(fingerprint)) {
        throw new Error('Borg server trust metadata is missing a valid CA identity');
    }
    return { ca_spki_sha256: fingerprint.toLowerCase() };
}
function verifyCaIdentity(certificate, expected) {
    let parsed;
    try {
        parsed = new X509Certificate(certificate);
    }
    catch {
        throw new Error('Borg server CA certificate is invalid');
    }
    if (!parsed.ca)
        throw new Error('Borg server trust anchor is not a CA certificate');
    const actual = createHash('sha256')
        .update(parsed.publicKey.export({ type: 'spki', format: 'der' }))
        .digest();
    const expectedBytes = Buffer.from(expected, 'hex');
    if (expectedBytes.length !== actual.length || !timingSafeEqual(actual, expectedBytes)) {
        throw new Error('Borg server CA certificate does not match its pinned identity');
    }
    return `spki-sha256:${actual.toString('hex')}`;
}
async function readGeneration(origin, generationId) {
    if (!/^[a-f0-9]{64}$/.test(generationId))
        throw new Error('Borg server trust pointer is invalid');
    const directory = trustGenerationDirectory(origin, generationId);
    const [certificate, configText] = await Promise.all([
        readTrustFile(join(directory, 'ca.crt')),
        readTrustFile(join(directory, 'server.json')),
    ]);
    const config = decodeTrustConfig(configText);
    const identity = verifyCaIdentity(certificate, config.ca_spki_sha256);
    if (trustGenerationId(origin, certificate, identity) !== generationId) {
        throw new Error('Borg server trust generation digest is invalid');
    }
    return { certificate, identity };
}
async function readTrustPointer(origin) {
    try {
        await assertPrivateDirectory(remoteTrustDirectory(origin));
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    let raw;
    try {
        raw = await readTrustFile(trustPointerPath(origin));
    }
    catch (error) {
        if (error instanceof Error && /were not found/.test(error.message))
            return null;
        throw error;
    }
    let pointer;
    try {
        pointer = JSON.parse(raw);
    }
    catch {
        throw new Error('Borg server trust pointer is invalid');
    }
    if (pointer.version !== 1 || pointer.origin !== origin ||
        typeof pointer.generationId !== 'string' || !/^[a-f0-9]{64}$/.test(pointer.generationId) ||
        typeof pointer.trustIdentity !== 'string')
        throw new Error('Borg server trust pointer is invalid');
    return pointer;
}
async function publishTrustPointer(pointer) {
    const root = remoteTrustDirectory(pointer.origin);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(root);
    await atomicWrite0600(trustPointerPath(pointer.origin), `${JSON.stringify(pointer)}\n`);
    invalidateOriginTrustCache(pointer.origin);
}
async function removeTrustPointer(origin) {
    try {
        await unlink(trustPointerPath(origin));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
    }
    await syncPath(remoteTrustDirectory(origin));
    invalidateOriginTrustCache(origin);
}
async function publishGeneration(origin, certificate, identity) {
    const generationId = trustGenerationId(origin, certificate, identity);
    const generations = trustGenerationsDirectory(origin);
    const target = trustGenerationDirectory(origin, generationId);
    await mkdir(generations, { recursive: true, mode: 0o700 });
    await assertPrivateDirectory(resolve(remoteTrustDirectory(origin), '..'));
    await assertPrivateDirectory(remoteTrustDirectory(origin));
    await assertPrivateDirectory(generations);
    if (await trustFilesExist(target)) {
        const verified = await readGeneration(origin, generationId);
        if (verified.identity !== identity)
            throw new Error('Borg server trust generation identity changed');
        return generationId;
    }
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    try {
        await mkdir(temporary, { mode: 0o700 });
        const certificatePath = join(temporary, 'ca.crt');
        const configPath = join(temporary, 'server.json');
        await writeFile(certificatePath, certificate, { mode: 0o600, flag: 'wx' });
        await syncPath(certificatePath);
        await writeFile(configPath, JSON.stringify({
            ca_spki_sha256: identity.replace(/^spki-sha256:/, ''),
        }), { mode: 0o600, flag: 'wx' });
        await syncPath(configPath);
        await syncPath(temporary);
        await rename(temporary, target);
        await syncPath(generations);
        const verified = await readGeneration(origin, generationId);
        if (verified.identity !== identity)
            throw new Error('Borg server trust generation identity changed');
        return generationId;
    }
    catch (error) {
        await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
        throw error;
    }
}
async function migrateLegacyRemoteTrust(origin) {
    const directory = remoteTrustDirectory(origin);
    if (!await trustFilesExist(directory))
        return null;
    const [certificate, configText] = await Promise.all([
        readTrustFile(join(directory, 'ca.crt')),
        readTrustFile(join(directory, 'server.json')),
    ]);
    const config = decodeTrustConfig(configText);
    const identity = verifyCaIdentity(certificate, config.ca_spki_sha256);
    const generationId = await publishGeneration(origin, certificate, identity);
    const pointer = { version: 1, origin, generationId, trustIdentity: identity };
    await publishTrustPointer(pointer);
    return pointer;
}
function responseHeaders(rawHeaders) {
    const headers = new Headers();
    for (let index = 0; index < rawHeaders.length; index += 2) {
        const name = rawHeaders[index];
        const value = rawHeaders[index + 1];
        if (name !== undefined && value !== undefined)
            headers.append(name, value);
    }
    return headers;
}
function requestBody(value) {
    if (value === null || value === undefined)
        return undefined;
    if (typeof value === 'string')
        return value;
    if (value instanceof Uint8Array)
        return value;
    if (value instanceof ArrayBuffer)
        return new Uint8Array(value);
    throw new Error('Borg server transport received an unsupported request body');
}
/**
 * Minimal fetch-compatible HTTPS transport bound to one origin and one
 * explicit local CA. Node's global fetch cannot consume the server-owned CA,
 * and disabling certificate validation would collapse the authority boundary.
 */
export function createPinnedServerFetch(origin, caCertificate) {
    const authority = new URL(origin);
    if (authority.protocol !== 'https:' || authority.origin !== origin) {
        throw new Error('Borg server trust requires a canonical HTTPS origin');
    }
    return (async (input, init = {}) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
        if (url.origin !== authority.origin || url.protocol !== 'https:') {
            throw new Error('Borg server transport refused a cross-authority request');
        }
        if (input instanceof Request) {
            throw new Error('Borg server transport requires an explicit URL and request options');
        }
        if (init.signal?.aborted)
            throw new DOMException('This operation was aborted', 'AbortError');
        const body = requestBody(init.body);
        const headers = new Headers(init.headers);
        if (body !== undefined) {
            const contentLength = String(typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : body.byteLength);
            const declaredLength = headers.get('Content-Length');
            if (declaredLength !== null && declaredLength !== contentLength) {
                throw new Error('Borg server transport refused an inconsistent Content-Length');
            }
            if (declaredLength === null)
                headers.set('Content-Length', contentLength);
        }
        return await new Promise((resolvePromise, rejectPromise) => {
            const request = httpsRequest({
                protocol: 'https:',
                hostname: url.hostname.replace(/^\[(.*)\]$/, '$1'),
                port: url.port || 443,
                path: `${url.pathname}${url.search}`,
                method: init.method ?? 'GET',
                headers: Object.fromEntries(headers.entries()),
                ca: caCertificate,
                rejectUnauthorized: true,
                minVersion: 'TLSv1.3',
            }, (incoming) => {
                const status = incoming.statusCode ?? 500;
                if (init.redirect === 'error' && status >= 300 && status < 400) {
                    incoming.resume();
                    rejectPromise(new Error('Borg server redirect refused'));
                    return;
                }
                const noBody = init.method === 'HEAD' || status === 204 || status === 304;
                const stream = noBody
                    ? null
                    : Readable.toWeb(incoming);
                if (noBody)
                    incoming.resume();
                resolvePromise(new Response(stream, {
                    status,
                    statusText: incoming.statusMessage,
                    headers: responseHeaders(incoming.rawHeaders),
                }));
            });
            const abort = () => {
                request.destroy(new DOMException('This operation was aborted', 'AbortError'));
            };
            init.signal?.addEventListener('abort', abort, { once: true });
            request.once('close', () => init.signal?.removeEventListener('abort', abort));
            request.once('error', (error) => {
                // CR5: a pinned-transport CERT/CA/SAN verification failure is TERMINAL trust
                // — type it as BorgServerTrustError so the seat probe returns `trust-mismatch`
                // (never `indeterminate` → "restart"). Connection refusal/reset/timeout carry
                // a transport errno (or an AbortError) and are rethrown RAW so the probe
                // classifies them as `unreachable`.
                const code = error.code;
                if (isPinnedTransportTrustFailure(code)) {
                    rejectPromise(new BorgServerTrustError(`Borg server presented a certificate that failed pinned verification (${code})`));
                    return;
                }
                rejectPromise(error);
            });
            if (body !== undefined)
                request.write(body);
            request.end();
        });
    });
}
export async function loadBorgServerTrust(origin, dataDirectory) {
    const useRemoteState = dataDirectory === undefined && await remoteTrustStateExists(origin);
    if (dataDirectory !== undefined || !useRemoteState && await trustFilesExist(serverDataDirectory())) {
        const directory = dataDirectory ?? serverDataDirectory();
        const key = `legacy\0${directory}\0${origin}`;
        let pending = trustCache.get(key);
        if (!pending) {
            pending = (async () => {
                const [certificate, configText] = await Promise.all([
                    readTrustFile(join(directory, 'ca.crt')),
                    readTrustFile(join(directory, 'server.json')),
                ]);
                const config = decodeTrustConfig(configText);
                const identity = verifyCaIdentity(certificate, config.ca_spki_sha256);
                return { identity, fetchImpl: createPinnedServerFetch(origin, certificate) };
            })();
            trustCache.set(key, pending);
            pending.catch(() => trustCache.delete(key));
        }
        return pending;
    }
    return withEnrollmentOriginLock(origin, async () => {
        await recoverAcceptedEnrollment(origin);
        const pointer = await readTrustPointer(origin) ?? await migrateLegacyRemoteTrust(origin);
        if (!pointer)
            throw new Error('Borg server trust files were not found');
        const key = `${origin}\0${pointer.generationId}\0${pointer.trustIdentity}`;
        let pending = trustCache.get(key);
        if (!pending) {
            pending = (async () => {
                const generation = await readGeneration(origin, pointer.generationId);
                if (generation.identity !== pointer.trustIdentity) {
                    throw new Error('Borg server trust pointer identity does not match its generation');
                }
                return {
                    identity: generation.identity,
                    fetchImpl: createPinnedServerFetch(origin, generation.certificate),
                };
            })();
            trustCache.set(key, pending);
            pending.catch(() => trustCache.delete(key));
        }
        return pending;
    });
}
function pemCertificate(raw) {
    const body = raw.toString('base64').match(/.{1,64}/g)?.join('\n') ?? '';
    return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}
function chainCertificates(socket) {
    const result = [];
    const seen = new Set();
    let current = socket.getPeerCertificate(true);
    while (current?.raw instanceof Buffer) {
        const key = current.raw.toString('base64');
        if (seen.has(key))
            break;
        seen.add(key);
        result.push(current.raw);
        current = current.issuerCertificate;
    }
    return result;
}
async function fetchPresentedChain(origin) {
    const url = new URL(origin);
    return new Promise((resolveChain, rejectChain) => {
        const socket = tlsConnect({
            host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
            port: url.port === '' ? 443 : Number(url.port),
            rejectUnauthorized: false,
            servername: url.hostname.replace(/^\[(.*)\]$/, '$1'),
        });
        const timeout = setTimeout(() => {
            socket.destroy();
            rejectChain(new InvitationArtifactTransportError());
        }, 5_000);
        socket.once('secureConnect', () => {
            clearTimeout(timeout);
            const chain = chainCertificates(socket);
            socket.destroy();
            resolveChain(chain);
        });
        socket.once('error', () => {
            clearTimeout(timeout);
            rejectChain(new InvitationArtifactTransportError());
        });
    });
}
/** Bootstrap a remote pinned transport from the CA chain presented by the server. */
export async function loadBorgServerTrustFromPresentedChain(origin, caSpkiSha256) {
    const chain = await fetchPresentedChain(origin);
    let sawCa = false;
    for (const raw of chain) {
        try {
            const certificate = new X509Certificate(raw);
            if (!certificate.ca)
                continue;
            sawCa = true;
            const actual = createHash('sha256')
                .update(certificate.publicKey.export({ type: 'spki', format: 'der' }))
                .digest('hex');
            if (actual !== caSpkiSha256)
                continue;
            return stageBorgServerTrust(origin, pemCertificate(raw), `spki-sha256:${actual}`);
        }
        catch {
            // Ignore malformed chain members; the typed compatibility failure below is safer.
        }
    }
    if (!sawCa)
        throw new InvitationArtifactCompatibilityError();
    throw new InvitationArtifactTrustError();
}
export async function stageBorgServerTrust(origin, certificate, identity) {
    let generationId;
    try {
        generationId = await withEnrollmentOriginLock(origin, () => publishGeneration(origin, certificate, identity));
    }
    catch {
        throw new InvitationArtifactStorageError();
    }
    return stagedTrustFromGeneration(origin, generationId, identity, certificate);
}
function stagedTrustFromGeneration(origin, generationId, identity, certificate) {
    let finalized = false;
    return {
        identity,
        generationId,
        fetchImpl: createPinnedServerFetch(origin, certificate),
        commitTrust: async (activate) => {
            if (finalized)
                return;
            await withEnrollmentOriginLock(origin, async () => {
                const previousPointer = await readTrustPointer(origin) ?? await migrateLegacyRemoteTrust(origin);
                let activated = false;
                try {
                    await activate({ generationId, previousPointer });
                    const accepted = await getAcceptedEnrollmentMarker(origin);
                    if (!accepted || accepted.generationId !== generationId ||
                        accepted.trustIdentity !== identity)
                        throw new Error('Borg enrollment activation did not publish its accepted marker');
                    activated = true;
                    injectEnrollmentTrustFault('after-account-activation');
                    await publishTrustPointer({ version: 1, origin, generationId, trustIdentity: identity });
                    injectEnrollmentTrustFault('after-pointer-publish');
                    const verified = await readGeneration(origin, generationId);
                    if (verified.identity !== identity)
                        throw new Error('published Borg trust generation changed');
                    injectEnrollmentTrustFault('before-marker-finalize');
                    await finalizeAcceptedEnrollment(origin, identity, generationId);
                    finalized = true;
                }
                catch (error) {
                    let marker;
                    try {
                        marker = await getAcceptedEnrollmentMarker(origin);
                    }
                    catch {
                        throw new InvitationArtifactRecoveryError();
                    }
                    // Activation is one atomic account-map replacement, but a durable
                    // backend may report an error after rename and before/while syncing
                    // the parent directory. The accepted marker, not the callback's
                    // return value, is therefore the authority for whether rollback is
                    // required.
                    if (!marker && !activated)
                        throw error;
                    if (!marker)
                        throw new InvitationArtifactRecoveryError();
                    try {
                        await restoreEnrollmentPointer(marker);
                        await restoreAcceptedEnrollmentAccounts(marker);
                    }
                    catch {
                        throw new InvitationArtifactRecoveryError();
                    }
                    throw new InvitationArtifactRecoveryError();
                }
            });
        },
        discardTrust: async () => {
            if (finalized)
                return;
            await withEnrollmentOriginLock(origin, async () => {
                const pointer = await readTrustPointer(origin);
                if (pointer?.generationId === generationId)
                    return;
                await rm(trustGenerationDirectory(origin, generationId), { recursive: true, force: true });
                await syncPath(trustGenerationsDirectory(origin)).catch(() => undefined);
            });
        },
    };
}
async function restoreEnrollmentPointer(marker) {
    injectEnrollmentTrustFault('during-pointer-rollback');
    if (marker.previousPointer === null) {
        await removeTrustPointer(marker.origin);
        if (await readTrustPointer(marker.origin) !== null)
            throw new Error('Borg trust pointer rollback failed');
        return;
    }
    const previous = await readGeneration(marker.origin, marker.previousPointer.generationId);
    if (previous.identity !== marker.previousPointer.trustIdentity) {
        throw new Error('Borg previous trust generation is invalid');
    }
    await publishTrustPointer(marker.previousPointer);
    const restored = await readTrustPointer(marker.origin);
    if (restored?.generationId !== marker.previousPointer.generationId) {
        throw new Error('Borg trust pointer rollback failed');
    }
}
async function recoverAcceptedEnrollment(origin) {
    const marker = await getAcceptedEnrollmentMarker(origin);
    if (!marker)
        return;
    try {
        const generation = await readGeneration(origin, marker.generationId);
        if (generation.identity !== marker.trustIdentity)
            throw new Error('Borg enrollment generation identity changed');
        await publishTrustPointer({
            version: 1,
            origin,
            generationId: marker.generationId,
            trustIdentity: marker.trustIdentity,
        });
        await finalizeAcceptedEnrollment(origin, marker.trustIdentity, marker.generationId);
    }
    catch {
        try {
            await restoreEnrollmentPointer(marker);
            await restoreAcceptedEnrollmentAccounts(marker);
        }
        catch {
            throw new InvitationArtifactRecoveryError();
        }
        throw new InvitationArtifactRecoveryError();
    }
}
/** Verify the exact persisted artifact binding before any resumed network I/O. */
export async function loadStagedBorgServerTrust(origin, binding) {
    return withEnrollmentOriginLock(origin, async () => {
        if (binding.endpoint !== origin || binding.trustIdentity !== `spki-sha256:${binding.caSpkiSha256}`)
            throw new InvitationArtifactTrustError();
        let generation;
        try {
            generation = await readGeneration(origin, binding.stagedGenerationId);
        }
        catch {
            throw new InvitationArtifactRecoveryError();
        }
        if (generation.identity !== binding.trustIdentity)
            throw new InvitationArtifactTrustError();
        return stagedTrustFromGeneration(origin, binding.stagedGenerationId, generation.identity, generation.certificate);
    });
}
/** Explicit operator recovery restores the exact accepted journal that was reviewed. */
export async function restoreBorgServerEnrollment(expected) {
    return withEnrollmentOriginLock(expected.origin, async () => {
        const marker = await getAcceptedEnrollmentMarker(expected.origin);
        if (!marker || JSON.stringify(marker) !== JSON.stringify(expected))
            return false;
        await restoreEnrollmentPointer(expected);
        await restoreAcceptedEnrollmentAccounts(expected);
        return true;
    });
}
export async function clearStagedBorgServerTrust(origin, generationId) {
    if (!generationId)
        return;
    await withEnrollmentOriginLock(origin, async () => {
        const pointer = await readTrustPointer(origin);
        if (pointer?.generationId === generationId) {
            throw new InvitationArtifactRecoveryError();
        }
        await rm(trustGenerationDirectory(origin, generationId), { recursive: true, force: true });
        await syncPath(trustGenerationsDirectory(origin)).catch(() => undefined);
    });
}
export function __clearServerTrustCacheForTest() {
    trustCache.clear();
}
export function __setEnrollmentTrustFaultForTest(points) {
    enrollmentTrustFaultsForTest = new Set(points === null ? [] : Array.isArray(points) ? points : [points]);
}
export async function clearBorgServerTrust(origin) {
    await withEnrollmentOriginLock(origin, async () => {
        await rm(remoteTrustDirectory(origin), { recursive: true, force: true });
        invalidateOriginTrustCache(origin);
    });
}
//# sourceMappingURL=server-trust.js.map