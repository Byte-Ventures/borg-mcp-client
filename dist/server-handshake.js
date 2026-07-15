import { ENROLLMENT_EXCHANGE_PATH, HEALTH_PATH, PROTOCOL_INFO_PATH, createProtocolEnvelope, decodeEnrollmentExchangeRequest, decodeEnrollmentExchangeResponseEnvelope, decodeProtocolEnvelope, negotiateProtocol, } from 'borgmcp-shared/protocol';
import { randomUUID } from 'node:crypto';
import { getServerCredential, storeServerCredential, storeServerSessionCredential, } from './config.js';
import { BorgServerError } from './server-errors.js';
import { readBoundedResponseBody } from './server-response.js';
import { loadBorgServerTrust, } from './server-trust.js';
const HANDSHAKE_BODY_LIMIT = 64 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ATTACH_PATH = '/api/client/attach';
export const DEFAULT_LOCAL_SERVER_ORIGIN = 'https://127.0.0.1:7091';
function handshakeUrl(origin, path) {
    return new URL(path, `${origin}/`).toString();
}
/** Bodyless, non-identifying liveness probe from the shared contract. */
export async function probeBorgServer(origin, fetchImpl = fetch, timeoutMs = 750) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetchImpl(handshakeUrl(origin, HEALTH_PATH), {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
        });
        return response.status === 204;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(timeout);
    }
}
const readHandshakeBody = (response, signal) => readBoundedResponseBody(response, HANDSHAKE_BODY_LIMIT, 'Borg server protocol handshake exceeded the response limit', signal);
/**
 * Authenticate and negotiate the shared protocol without consulting Cloud.
 * The caller supplies an authority- and trust-bound credential from secure
 * storage; redirects are rejected so bearer credentials never cross origins.
 */
export async function negotiateBorgServer(origin, credential, fetchImpl = fetch) {
    if (!/^[A-Za-z0-9_-]{43,1024}$/.test(credential)) {
        throw new Error('stored Borg server credential is invalid; enroll this client again');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
        const response = await fetchImpl(handshakeUrl(origin, PROTOCOL_INFO_PATH), {
            method: 'GET',
            redirect: 'error',
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${credential}`,
            },
        });
        if (response.status === 401 || response.status === 403) {
            throw new BorgServerError('CREDENTIAL_REJECTED', 'stored Borg server credential was rejected');
        }
        if (!response.ok) {
            throw new Error(`Borg server protocol handshake failed (HTTP ${response.status})`);
        }
        let decoded;
        try {
            decoded = JSON.parse(await readHandshakeBody(response, controller.signal));
        }
        catch (error) {
            if (error instanceof Error && error.message.includes('response limit'))
                throw error;
            throw new Error('Borg server returned an invalid protocol envelope');
        }
        return decodeProtocolEnvelope(decoded, (payload) => negotiateProtocol(payload)).payload;
    }
    finally {
        clearTimeout(timeout);
    }
}
function decodeServerAttachResponse(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Borg server returned an invalid attach response');
    }
    const record = value;
    const cube = record.cube;
    const role = record.role;
    const drone = record.drone;
    const session = record.session;
    const expiresAt = session?.expires_at;
    if (!cube || !UUID_RE.test(String(cube.id ?? '')) || typeof cube.name !== 'string' ||
        !role || !UUID_RE.test(String(role.id ?? '')) || typeof role.name !== 'string' ||
        !drone || !UUID_RE.test(String(drone.id ?? '')) || typeof drone.label !== 'string' ||
        !session || typeof session.token !== 'string' ||
        !/^[A-Za-z0-9_-]{43,1024}$/.test(session.token) ||
        !Number.isSafeInteger(session.generation) || Number(session.generation) < 1 ||
        (expiresAt !== null &&
            (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)))) ||
        typeof record.reattached !== 'boolean') {
        throw new Error('Borg server returned an invalid attach response');
    }
    const roleClass = role.role_class;
    if (roleClass !== undefined && roleClass !== 'queen' && roleClass !== 'worker') {
        throw new Error('Borg server returned an invalid attach response');
    }
    if (role.is_human_seat !== undefined && typeof role.is_human_seat !== 'boolean') {
        throw new Error('Borg server returned an invalid attach response');
    }
    return {
        cube: { id: String(cube.id), name: cube.name },
        role: {
            id: String(role.id),
            name: role.name,
            ...(roleClass === undefined ? {} : { role_class: roleClass }),
            ...(role.is_human_seat === undefined ? {} : { is_human_seat: role.is_human_seat }),
        },
        drone: { id: String(drone.id), label: drone.label },
        session: {
            token: session.token,
            generation: Number(session.generation),
            expiresAt: expiresAt,
        },
        reattached: record.reattached,
    };
}
/**
 * Attach an enrolled client principal to one granted cube/role. The response
 * bearer is written to a generation-specific keychain entry before this
 * function returns; only its opaque reference crosses into caller state.
 */
export async function attachBorgServer(origin, trustIdentity, parentCredential, request, deps = {}) {
    if (!UUID_RE.test(request.cubeId) || !UUID_RE.test(request.roleId)) {
        throw new Error('Borg server attach requires valid cube and role identities');
    }
    if (!UUID_RE.test(request.retryKey)) {
        throw new Error('Borg server attach retry state is invalid');
    }
    if (!/^[A-Za-z0-9_-]{43,1024}$/.test(parentCredential)) {
        throw new Error('stored Borg server enrollment credential is invalid');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    try {
        const response = await (deps.fetchImpl ?? fetch)(handshakeUrl(origin, CLIENT_ATTACH_PATH), {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${parentCredential}`,
            },
            body: JSON.stringify(createProtocolEnvelope(randomUUID(), {
                cube_id: request.cubeId,
                role_id: request.roleId,
                retry_key: request.retryKey,
            })),
        });
        if (response.status === 401 || response.status === 403) {
            throw new BorgServerError('CREDENTIAL_REJECTED', 'Borg server enrollment was rejected');
        }
        if (response.status === 409) {
            throw new BorgServerError('ATTACH_CONFLICT', 'Borg server attach request conflicted');
        }
        if (!response.ok) {
            throw new Error(`Borg server attach failed (HTTP ${response.status})`);
        }
        let decoded;
        try {
            decoded = decodeProtocolEnvelope(JSON.parse(await readHandshakeBody(response, controller.signal)), decodeServerAttachResponse).payload;
        }
        catch (error) {
            if (error instanceof Error && error.message.includes('response limit'))
                throw error;
            throw new Error('Borg server returned an invalid attach response');
        }
        if (decoded.cube.id !== request.cubeId || decoded.role.id !== request.roleId) {
            throw new Error('Borg server returned an attach identity outside the request');
        }
        const credentialRef = await (deps.storeSessionCredential ?? storeServerSessionCredential)({
            origin,
            trustIdentity,
            cubeId: decoded.cube.id,
            droneId: decoded.drone.id,
            generation: decoded.session.generation,
            credential: decoded.session.token,
            expiresAt: decoded.session.expiresAt,
        });
        return {
            cube: decoded.cube,
            role: decoded.role,
            drone: decoded.drone,
            session: {
                credentialRef,
                generation: decoded.session.generation,
                expiresAt: decoded.session.expiresAt,
            },
            reattached: decoded.reattached,
        };
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * Redeem one invitation after the caller has verified TLS and derived the
 * stable server/CA identity. The secret stays in the versioned request body,
 * never the URL, argv, environment, output, or diagnostics. The returned
 * bearer is negotiated before it is written once to the dedicated keychain.
 */
export async function enrollBorgServer(origin, trustIdentity, invitation, deps = {}) {
    const request = decodeEnrollmentExchangeRequest({
        invitation,
        ...(deps.clientName ? { client_name: deps.clientName } : {}),
    });
    const fetchImpl = deps.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HANDSHAKE_TIMEOUT_MS);
    let response;
    try {
        response = await fetchImpl(handshakeUrl(origin, ENROLLMENT_EXCHANGE_PATH), {
            method: 'POST',
            redirect: 'error',
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(createProtocolEnvelope(randomUUID(), request)),
        });
        if (response.status === 401 || response.status === 403) {
            throw new BorgServerError('INVITATION_REJECTED', 'the invitation was rejected or expired');
        }
        if (response.status !== 201) {
            throw new Error(`Borg server enrollment failed (HTTP ${response.status})`);
        }
        let decoded;
        try {
            decoded = decodeEnrollmentExchangeResponseEnvelope(JSON.parse(await readHandshakeBody(response, controller.signal)));
        }
        catch (error) {
            if (error instanceof Error && error.message.includes('response limit'))
                throw error;
            throw new Error('Borg server returned an invalid enrollment envelope');
        }
        const protocol = await negotiateBorgServer(origin, decoded.payload.credential, fetchImpl);
        await (deps.storeCredential ?? storeServerCredential)({
            origin,
            trustIdentity,
            credential: decoded.payload.credential,
        });
        return {
            token: decoded.payload.credential,
            trustIdentity,
            protocol,
            clientId: decoded.payload.client_id,
            ...(decoded.payload.credential_expires_at === undefined
                ? {}
                : { credentialExpiresAt: decoded.payload.credential_expires_at }),
        };
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * Swappable Part-4 integration seam. Trust verification supplies the server/CA
 * identity; this function then reads only the credential bound to that exact
 * origin+identity pair and negotiates the authenticated shared contract.
 */
export async function connectEnrolledBorgServer(origin, trustIdentity, deps = {}) {
    const loadCredential = deps.loadCredential ?? getServerCredential;
    const token = await loadCredential(origin, trustIdentity);
    if (!token) {
        throw new BorgServerError('NOT_ENROLLED', 'no enrolled credential is stored for this Borg server identity');
    }
    const protocol = await negotiateBorgServer(origin, token, deps.fetchImpl ?? fetch);
    return { token, trustIdentity, protocol };
}
/** Resolve the same-user server CA and its authority-bound keychain credential. */
export async function resolveBorgServerAuthority(origin, deps = {}) {
    const trust = await (deps.loadTrust ?? loadBorgServerTrust)(origin);
    const token = await (deps.loadCredential ?? getServerCredential)(origin, trust.identity);
    if (!token) {
        throw new BorgServerError('NOT_ENROLLED', 'no enrolled credential is stored for this Borg server identity');
    }
    return { ...trust, token };
}
/** Load pinned trust, then prove the stored credential against /api/protocol. */
export async function connectLocalBorgServer(origin, deps = {}) {
    const authority = await resolveBorgServerAuthority(origin, deps);
    const protocol = await negotiateBorgServer(origin, authority.token, authority.fetchImpl);
    return {
        token: authority.token,
        trustIdentity: authority.identity,
        protocol,
    };
}
/** Load and verify the local CA before sending a single-use invitation. */
export async function enrollLocalBorgServer(origin, invitation, deps = {}) {
    const trust = await (deps.loadTrust ?? loadBorgServerTrust)(origin);
    return enrollBorgServer(origin, trust.identity, invitation, {
        fetchImpl: trust.fetchImpl,
        ...(deps.storeCredential === undefined ? {} : { storeCredential: deps.storeCredential }),
        ...(deps.clientName === undefined ? {} : { clientName: deps.clientName }),
    });
}
/** Advisory discovery that still verifies the server-owned CA. */
export async function probeLocalBorgServer(origin) {
    try {
        const trust = await loadBorgServerTrust(origin);
        return await probeBorgServer(origin, trust.fetchImpl);
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=server-handshake.js.map