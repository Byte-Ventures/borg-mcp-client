import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { BorgServerTrustError } from './server-errors.js';
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
    if (!code)
        return false;
    return (code.startsWith('CERT_') ||
        code.startsWith('ERR_TLS_CERT') ||
        TLS_TRUST_ERROR_CODES.has(code));
}
const trustCache = new Map();
function serverDataDirectory() {
    return resolve(process.env.BORG_SERVER_DATA_DIR ?? join(homedir(), '.borg', 'server'));
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
export async function loadBorgServerTrust(origin, dataDirectory = serverDataDirectory()) {
    const key = `${dataDirectory}\0${origin}`;
    let pending = trustCache.get(key);
    if (!pending) {
        pending = (async () => {
            const [certificate, configText] = await Promise.all([
                readTrustFile(join(dataDirectory, 'ca.crt')),
                readTrustFile(join(dataDirectory, 'server.json')),
            ]);
            const config = decodeTrustConfig(configText);
            const identity = verifyCaIdentity(certificate, config.ca_spki_sha256);
            return {
                identity,
                fetchImpl: createPinnedServerFetch(origin, certificate),
            };
        })();
        trustCache.set(key, pending);
        pending.catch(() => trustCache.delete(key));
    }
    return pending;
}
export function __clearServerTrustCacheForTest() {
    trustCache.clear();
}
//# sourceMappingURL=server-trust.js.map